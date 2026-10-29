from __future__ import annotations

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, Iterable


USER_AGENT = "OryntDiscovery/0.1 (local, user-initiated)"
ALLOWED_CONTENT_TYPES = ("text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml")
DISCOVERY_HINTS = (
    "product", "products", "feature", "features", "pricing", "about", "faq",
    "case", "customer", "solution", "blog", "news", "press", "shop", "store",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalized_host(host: str) -> str:
    value = host.lower().rstrip(".")
    return value[4:] if value.startswith("www.") else value


class FetchError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _connect_addresses(addresses, port, timeout, source_address=None):
    # Never resolve the original hostname again after policy validation (DNS rebinding).
    deadline = time.monotonic() + timeout
    last_error = None
    for address in sorted(addresses, key=lambda value: (':' in value, value))[:4]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            return socket.create_connection((address, port), remaining, source_address)
        except OSError as error:
            last_error = error
    raise last_error or TimeoutError('公网连接超时')


@lru_cache(maxsize=128)
def public_resolver(host: str) -> frozenset[str]:
    """Resolve only a public hostname over certificate-verified, pinned HTTPS DNS.

    Used for local VPN fake-IP DNS only. No page paths, query strings or contents
    are sent to the DNS service. A DNS response never authorizes private addresses.
    Cache lasts only for this short-lived crawler process.
    """
    try:
        for record_type in ('A', 'AAAA'):
            connection = http.client.HTTPSConnection('dns.google', timeout=5)
            connection._create_connection = lambda destination, timeout=5, source_address=None: _connect_addresses({'8.8.8.8'}, destination[1], timeout, source_address)
            try:
                query = urllib.parse.urlencode({'name': host.encode('idna').decode('ascii'), 'type': record_type})
                connection.request('GET', '/resolve?' + query, headers={'Accept': 'application/dns-json', 'User-Agent': USER_AGENT})
                response = connection.getresponse()
                data = response.read(65_537)
                if response.status != 200 or len(data) > 65_536:
                    raise ValueError('Invalid DNS response')
                result = json.loads(data)
                if result.get('Status') != 0:
                    raise ValueError('Public domain not found')
                addresses = {str(ipaddress.ip_address(answer['data'])) for answer in result.get('Answer', []) if answer.get('type') in {1, 28}}
                if addresses:
                    if not all(ipaddress.ip_address(address).is_global for address in addresses):
                        raise ValueError('Non-public DNS answer')
                    return frozenset(addresses)
            finally:
                connection.close()
    except (OSError, ValueError, http.client.HTTPException):
        pass
    raise FetchError('PUBLIC_DNS_UNAVAILABLE', '本机网络使用代理虚拟地址，但未能查询到可验证的公网地址。请检查网络后重新读取。')


def default_resolver(host: str) -> set[str]:
    addresses = {entry[4][0] for entry in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
    fake_network = ipaddress.ip_network('198.18.0.0/15')
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    # Only recover synthetic VPN addresses for domain names, never arbitrary
    # private/loopback/link-local resolutions or explicit benchmark IP literals.
    if not literal and addresses and all(ipaddress.ip_address(address) in fake_network for address in addresses):
        return set(public_resolver(host))
    return addresses


class UrlPolicy:
    def __init__(self, entry_url: str, resolver: Callable[[str], set[str]] = default_resolver):
        parsed = urllib.parse.urlsplit(entry_url)
        if not parsed.hostname:
            raise ValueError("网址缺少有效域名")
        self.entry_host = normalized_host(parsed.hostname)
        self.resolver = resolver
        self._resolved_addresses: dict[str, set[str]] = {}
        self.validate(entry_url)

    def validate(self, url: str) -> str:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("仅允许 HTTP 或 HTTPS 网址")
        if parsed.username or parsed.password:
            raise ValueError("网址不能包含登录凭据")
        if not parsed.hostname or normalized_host(parsed.hostname) != self.entry_host:
            raise ValueError("采集仅允许在品牌官网同域内进行")
        if parsed.port and parsed.port not in {80, 443}:
            raise ValueError("品牌官网只允许标准 HTTP/HTTPS 端口")
        addresses = self._resolved_addresses.get(parsed.hostname)
        if addresses is None:
            addresses = self.resolver(parsed.hostname)
            self._resolved_addresses[parsed.hostname] = addresses
        if not addresses:
            raise ValueError("无法解析品牌官网域名")
        for address in addresses:
            if not ipaddress.ip_address(address).is_global:
                raise FetchError('NETWORK_ADDRESS_BLOCKED', "此网址解析到本机、内网或保留网络地址，无法作为公开商品页读取。")
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))

    def addresses(self, host: str) -> set[str]:
        return set(self._resolved_addresses[host])

    def same_site(self, url: str) -> bool:
        try:
            self.validate(url)
            return True
        except (ValueError, OSError, socket.gaierror):
            return False


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, policy: UrlPolicy):
        super().__init__()
        self.policy = policy

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url = self.policy.validate(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, safe_url)


class PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def connection(self, host, **kwargs):
        connection = http.client.HTTPConnection(host, **kwargs)
        addresses = self.policy.addresses(urllib.parse.urlsplit('//' + host).hostname)
        connection._create_connection = lambda destination, timeout=15, source_address=None: _connect_addresses(addresses, destination[1], timeout, source_address)
        return connection

    def http_open(self, request):
        return self.do_open(self.connection, request)


class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def connection(self, host, **kwargs):
        # Preserve hostname for TLS SNI, certificate validation and the Host header.
        connection = http.client.HTTPSConnection(host, **kwargs)
        addresses = self.policy.addresses(urllib.parse.urlsplit('//' + host).hostname)
        connection._create_connection = lambda destination, timeout=15, source_address=None: _connect_addresses(addresses, destination[1], timeout, source_address)
        return connection

    def https_open(self, request):
        return self.do_open(self.connection, request, context=self._context)


@dataclass
class FetchResult:
    url: str
    body: bytes
    content_type: str
    status: int


class HttpClient:
    def __init__(
        self,
        policy: UrlPolicy,
        *,
        timeout_seconds: float = 15,
        max_bytes: int = 1_500_000,
        max_retries: int = 2,
        min_interval_seconds: float = 0.4,
    ):
        self.policy = policy
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes
        self.max_retries = max_retries
        self.min_interval_seconds = min_interval_seconds
        self.last_started_at = 0.0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SafeRedirectHandler(policy), PinnedHTTPHandler(policy), PinnedHTTPSHandler(policy))

    def get(self, url: str, *, accepted_types: tuple[str, ...] = ALLOWED_CONTENT_TYPES) -> FetchResult:
        safe_url = self.policy.validate(url)
        last_error: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            wait = self.last_started_at + self.min_interval_seconds - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last_started_at = time.monotonic()
            request = urllib.request.Request(
                safe_url,
                headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/xml,text/plain;q=0.8"},
            )
            try:
                with self.opener.open(request, timeout=self.timeout_seconds) as response:
                    final_url = self.policy.validate(response.geturl())
                    content_type = response.headers.get_content_type().lower()
                    if accepted_types and not any(content_type.startswith(value) for value in accepted_types):
                        raise ValueError(f"不支持的响应类型：{content_type}")
                    declared = response.headers.get("Content-Length")
                    if declared and int(declared) > self.max_bytes:
                        raise ValueError("网页响应超过本地采集大小上限")
                    body = response.read(self.max_bytes + 1)
                    if len(body) > self.max_bytes:
                        raise ValueError("网页响应超过本地采集大小上限")
                    return FetchResult(final_url, body, content_type, int(response.status))
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code == 404:
                    raise
                if error.code not in {408, 425, 429, 500, 502, 503, 504} or attempt >= self.max_retries:
                    raise
                retry_after = error.headers.get("Retry-After")
                delay = min(10.0, float(retry_after)) if retry_after and retry_after.isdigit() else float(attempt)
                time.sleep(delay)
            except urllib.error.URLError as error:
                last_error = error
                if attempt >= self.max_retries:
                    raise
                time.sleep(float(attempt))
        if last_error:
            raise last_error
        raise RuntimeError("网页请求没有返回结果")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[str] = []
        self.meta: dict[str, str] = {}
        self._in_title = False
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if tag == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            content = values.get("content", "").strip()
            if key and content:
                self.meta[key] = content

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        cleaned = " ".join(data.split())
        if not cleaned:
            return
        self.text_parts.append(cleaned)
        if self._in_title:
            self.title_parts.append(cleaned)


@dataclass
class Evidence:
    evidenceId: str
    sourceType: str
    sourceUrl: str
    observedAt: str
    ingestedAt: str
    title: str
    contentSummary: str
    rawEvidenceRef: str
    contentHash: str


@dataclass
class SourceRecord:
    sourceType: str
    sourceUrl: str
    status: str
    observedAt: str
    rawEvidenceRef: str | None = None
    errorCode: str | None = None


@dataclass
class DiscoveryBundle:
    provider: str = "orynt_local_website"
    sources: list[SourceRecord] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    coverage: dict = field(default_factory=dict)
    limitations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "sources": [asdict(item) for item in self.sources],
            "evidence": [asdict(item) for item in self.evidence],
            "coverage": self.coverage,
            "limitations": self.limitations,
        }


class WebsiteConnector:
    def __init__(self, *, max_pages: int = 6):
        self.max_pages = max(1, min(max_pages, 12))

    def collect(self, entry_url: str, workspace: Path) -> DiscoveryBundle:
        policy = UrlPolicy(entry_url)
        http = HttpClient(policy)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(workspace, 0o700)
        raw_dir = workspace / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(raw_dir, 0o700)

        entry_url = policy.validate(entry_url)
        robots = self._load_robots(http, entry_url)
        candidates = [entry_url]
        candidates.extend(self._sitemap_candidates(http, robots, entry_url, policy))
        queued = set(candidates)
        fetched: set[str] = set()
        content_hashes: set[str] = set()
        bundle = DiscoveryBundle()

        while candidates and len(fetched) < self.max_pages:
            url = candidates.pop(0)
            if url in fetched:
                continue
            observed_at = utc_now()
            if not robots.can_fetch(USER_AGENT, url):
                bundle.sources.append(SourceRecord("brand_website", url, "blocked_by_robots", observed_at, errorCode="ROBOTS_DENIED"))
                fetched.add(url)
                continue
            try:
                result = http.get(url)
                fetched.add(result.url)
                html = result.body.decode("utf-8", errors="replace")
                parser = PageParser()
                parser.feed(html)
                title = " ".join(parser.title_parts).strip() or parser.meta.get("og:title", "")
                summary = " ".join(parser.text_parts)
                summary = re.sub(r"\s+", " ", summary).strip()[:6000]
                content_hash = hashlib.sha256(result.body).hexdigest()
                if content_hash in content_hashes or not summary:
                    continue
                content_hashes.add(content_hash)
                raw_name = f"{content_hash}.html"
                raw_path = raw_dir / raw_name
                self._secure_write(raw_path, result.body)
                raw_ref = f"raw/{raw_name}"
                evidence_id = f"evidence_{hashlib.sha256((result.url + content_hash).encode()).hexdigest()[:24]}"
                bundle.sources.append(SourceRecord("brand_website", result.url, "available", observed_at, raw_ref))
                bundle.evidence.append(Evidence(
                    evidence_id, "brand_website", result.url, observed_at, utc_now(),
                    title[:500], summary, raw_ref, content_hash,
                ))
                for link in self._rank_links(parser.links, result.url, policy):
                    if link not in queued and len(queued) < self.max_pages * 8:
                        candidates.append(link)
                        queued.add(link)
            except (ValueError, OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
                fetched.add(url)
                bundle.sources.append(SourceRecord("brand_website", url, "failed", observed_at, errorCode=type(error).__name__.upper()))

        available = sum(1 for item in bundle.sources if item.status == "available")
        failed = sum(1 for item in bundle.sources if item.status == "failed")
        blocked = sum(1 for item in bundle.sources if item.status == "blocked_by_robots")
        bundle.coverage = {
            "attemptedPages": len(fetched),
            "fetchedPages": available,
            "failedPages": failed,
            "robotsBlockedPages": blocked,
            "maxPages": self.max_pages,
        }
        if available == 0:
            bundle.limitations.append("品牌官网没有产生可用页面；可能被 robots 规则禁止、无法访问或内容需要浏览器渲染。")
        elif available < self.max_pages:
            bundle.limitations.append("官网可公开访问的有效页面少于本轮采集上限。")
        bundle.limitations.append("当前仅覆盖品牌自有官网，尚未加入外部市场、社区和广告数据。")
        return bundle

    def _load_robots(self, http: HttpClient, entry_url: str, *, strict=False) -> urllib.robotparser.RobotFileParser:
        parsed = urllib.parse.urlsplit(entry_url)
        robots_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/robots.txt", "", ""))
        rules = urllib.robotparser.RobotFileParser()
        rules.set_url(robots_url)
        try:
            result = http.get(robots_url, accepted_types=("text/plain", "text/html"))
            rules.parse(result.body.decode("utf-8", errors="replace").splitlines())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                rules.parse([])
            else:
                if strict:
                    raise FetchError('ROBOTS_UNAVAILABLE', '未能读取网站的自动访问规则，暂未继续读取商品页。请稍后重新读取。') from error
                rules.parse(["User-agent: *", "Disallow: /"])
        except Exception as error:
            if strict:
                if isinstance(error, FetchError):
                    raise
                raise FetchError('ROBOTS_UNAVAILABLE', '未能读取网站的自动访问规则，暂未继续读取商品页。请检查网络后重新读取。') from error
            rules.parse(["User-agent: *", "Disallow: /"])
        return rules

    def _sitemap_candidates(
        self,
        http: HttpClient,
        robots: urllib.robotparser.RobotFileParser,
        entry_url: str,
        policy: UrlPolicy,
    ) -> list[str]:
        parsed = urllib.parse.urlsplit(entry_url)
        urls = list(robots.site_maps() or [])
        if not urls:
            urls = [urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/sitemap.xml", "", ""))]
        result: list[str] = []
        for sitemap_url in urls[:3]:
            if not policy.same_site(sitemap_url):
                continue
            try:
                response = http.get(sitemap_url, accepted_types=("application/xml", "text/xml", "text/plain"))
                root = ET.fromstring(response.body)
                for node in root.iter():
                    if node.tag.rsplit("}", 1)[-1] == "loc" and node.text and policy.same_site(node.text.strip()):
                        result.append(policy.validate(node.text.strip()))
                        if len(result) >= 30:
                            return result
            except Exception:
                continue
        return result

    def _rank_links(self, links: Iterable[str], base_url: str, policy: UrlPolicy) -> list[str]:
        ranked: list[tuple[int, str]] = []
        seen: set[str] = set()
        for raw in links:
            if raw.startswith(("#", "mailto:", "tel:", "javascript:")):
                continue
            url = urllib.parse.urljoin(base_url, raw)
            if not policy.same_site(url):
                continue
            url = policy.validate(url)
            if url in seen:
                continue
            seen.add(url)
            lowered = urllib.parse.urlsplit(url).path.lower()
            score = sum(1 for hint in DISCOVERY_HINTS if hint in lowered)
            ranked.append((-score, url))
        ranked.sort()
        return [url for _, url in ranked]

    def _secure_write(self, path: Path, content: bytes) -> None:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)


def main() -> int:
    parser = argparse.ArgumentParser(description="Orynt local website discovery worker")
    parser.add_argument("--url", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--max-pages", type=int, default=6)
    args = parser.parse_args()
    try:
        bundle = WebsiteConnector(max_pages=args.max_pages).collect(args.url, Path(args.workspace))
        sys.stdout.write(json.dumps(bundle.to_dict(), ensure_ascii=False))
        return 0
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
