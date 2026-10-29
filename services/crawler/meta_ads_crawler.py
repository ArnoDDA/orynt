"""Small, local-first Meta Ad Library collector for Orynt Discovery.

The normalization approach is adapted from Ilian Daviaud's MIT-licensed
``meta-ads-scraper`` project (copyright 2026 Ilian Daviaud). Orynt deliberately
does not reuse that project's private GraphQL replay/pagination mechanism. It
only observes responses already loaded by a logged-out public browser page.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from reference_media import ad_media_candidates, attach_ad_media


META_LIBRARY_URL = "https://www.facebook.com/ads/library/"
MAX_ADS = 30


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clamp_limit(value: int) -> int:
    return max(1, min(int(value), MAX_ADS))


def collect_ad_nodes(payload: Any) -> list[dict[str, Any]]:
    """Find ad nodes in a GraphQL response without depending on one nesting shape."""
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            ad_id = value.get("ad_archive_id")
            if ad_id and ("snapshot" in value or "page_name" in value):
                key = str(ad_id)
                if key not in seen:
                    seen.add(key)
                    found.append(value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return found


def collect_script_ad_nodes(scripts: list[str]) -> list[dict[str, Any]]:
    """Read public JSON already embedded in the loaded page; never replay requests."""
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for script in scripts:
        value = script.strip()
        if not value.startswith(("{", "[")) or "ad_archive_id" not in value:
            continue
        try:
            payload = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        for node in collect_ad_nodes(payload):
            ad_id = str(node.get("ad_archive_id") or "")
            if ad_id and ad_id not in seen:
                seen.add(ad_id)
                found.append(node)
    return found


def _date(epoch: Any) -> str | None:
    try:
        value = float(epoch)
        if value > 10_000_000_000:
            value /= 1000
        return datetime.fromtimestamp(value, timezone.utc).date().isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _text(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("text", "")
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_ad(ad: dict[str, Any], *, query: str, demo: bool = False) -> dict[str, Any]:
    snapshot = ad.get("snapshot") if isinstance(ad.get("snapshot"), dict) else {}
    cards = snapshot.get("cards") if isinstance(snapshot.get("cards"), list) else []
    videos = snapshot.get("videos") if isinstance(snapshot.get("videos"), list) else []
    images = snapshot.get("images") if isinstance(snapshot.get("images"), list) else []
    body = _text(snapshot.get("body"))
    if not body and cards:
        body = _text(cards[0].get("body"))
    title = _text(snapshot.get("title"))
    page_name = _text(ad.get("page_name") or snapshot.get("page_name")) or "Meta 广告主"
    ad_id = str(ad.get("ad_archive_id") or "")
    start_date = _date(ad.get("start_date"))
    end_date = _date(ad.get("end_date"))
    display_format = _text(snapshot.get("display_format"))
    if not display_format:
        display_format = "VIDEO" if videos else "CAROUSEL" if len(cards) > 1 else "IMAGE" if images else "UNKNOWN"
    cta = _text(snapshot.get("cta_text") or snapshot.get("cta_type"))
    link = snapshot.get("link_url") or (cards[0].get("link_url") if cards else None)
    domain = urllib.parse.urlsplit(str(link or "")).hostname or ""
    source_url = f"local-demo://meta/{ad_id}" if demo else f"{META_LIBRARY_URL}?id={urllib.parse.quote(ad_id)}"
    parts = [
        "演示样本，不代表真实广告。" if demo else "Meta 公开广告页面采集。",
        f"广告主：{page_name}。",
        f"形式：{display_format}。",
        f"文案：{body[:900]}" if body else "",
        f"标题：{title[:300]}。" if title else "",
        f"CTA：{cta}。" if cta else "",
        f"投放时间：{start_date or '未知'} 至 {end_date or '仍在投放/未知'}。",
        f"落地页域名：{domain}。" if domain else "",
    ]
    summary = " ".join(part for part in parts if part)
    normalized = {
        "adId": ad_id,
        "query": query,
        "advertiserId": str(ad.get("page_id") or snapshot.get("page_id") or ""),
        "advertiserName": page_name,
        "bodyText": body,
        "title": title,
        "cta": cta,
        "displayFormat": display_format,
        "startDate": start_date,
        "endDate": end_date,
        "isActive": bool(ad.get("is_active")),
        "landingDomain": domain,
        "sourceUrl": source_url,
        "contentSummary": summary[:6000],
        "demo": demo,
    }
    normalized["contentHash"] = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    normalized['mediaCandidates'] = [] if demo else ad_media_candidates(ad)
    return normalized


def demo_ads(query: str, limit: int) -> list[dict[str, Any]]:
    formats = ("VIDEO", "IMAGE", "CAROUSEL")
    hooks = (
        "还在用复杂的方法解决这个日常问题吗？",
        "一个细节，让每天的使用过程更顺手。",
        "真实用户从第一次使用到形成习惯的完整过程。",
        "先看产品如何工作，再决定它是否适合你。",
        "把抽象卖点变成三秒就能看懂的产品动作。",
        "同样的场景，不同的处理方式会有什么变化？",
    )
    count = min(limit, 12)
    result = []
    for index in range(count):
        seed = hashlib.sha256(f"{query}:{index}".encode()).hexdigest()[:18]
        fmt = formats[index % len(formats)]
        result.append({
            "ad_archive_id": f"demo_{seed}",
            "page_id": f"demo_page_{index % 4 + 1}",
            "page_name": f"{query[:36]} · 示例品牌 {index % 4 + 1}",
            "start_date": 1788307200 - index * 86400,
            "end_date": None if index % 3 else 1789084800,
            "is_active": index % 3 != 0,
            "snapshot": {
                "display_format": fmt,
                "body": {"text": f"{hooks[index % len(hooks)]} {query} 的演示广告文案。"},
                "title": f"{query[:30]} 创意方向 {index + 1}",
                "cta_text": ("了解更多", "立即购买", "查看详情")[index % 3],
                "link_url": f"https://example.invalid/{urllib.parse.quote(query[:30])}/{index + 1}",
                "videos": [{}] if fmt == "VIDEO" else [],
                "images": [{}] if fmt == "IMAGE" else [],
                "cards": [{}, {}] if fmt == "CAROUSEL" else [],
            },
        })
    return result


def collect_public_page(query: str, limit: int) -> list[dict[str, Any]]:
    """Collect only data the logged-out browser page itself has already loaded."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError("PLAYWRIGHT_NOT_INSTALLED") from error

    params = urllib.parse.urlencode({
        "active_status": "active",
        "ad_type": "all",
        "country": "ALL",
        "q": query,
        "search_type": "keyword_unordered",
        "media_type": "all",
    })
    captured: list[dict[str, Any]] = []
    seen: set[str] = set()

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
        except Exception:
            browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(locale="en-US")
        page = context.new_page()

        def on_response(response: Any) -> None:
            if "/api/graphql" not in response.url or len(captured) >= limit:
                return
            try:
                for node in collect_ad_nodes(response.json()):
                    ad_id = str(node.get("ad_archive_id") or "")
                    if ad_id and ad_id not in seen:
                        seen.add(ad_id)
                        captured.append(node)
                        if len(captured) >= limit:
                            break
            except Exception:
                return

        page.on("response", on_response)
        page.goto(f"{META_LIBRARY_URL}?{params}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(6_000)
        for _ in range(2):
            if len(captured) >= limit:
                break
            page.mouse.wheel(0, 3500)
            page.wait_for_timeout(2_500)
        if len(captured) < limit:
            for node in collect_script_ad_nodes(page.locator("script").all_text_contents()):
                ad_id = str(node.get("ad_archive_id") or "")
                if ad_id and ad_id not in seen:
                    seen.add(ad_id)
                    captured.append(node)
                    if len(captured) >= limit:
                        break
        content_head = page.content()[:5000].lower()
        browser.close()

    if any(marker in content_head for marker in ("captcha", "security check", "you must log in")):
        raise RuntimeError("META_PUBLIC_PAGE_BLOCKED")
    if not captured:
        raise RuntimeError("META_PUBLIC_PAGE_EMPTY")
    return captured[:limit]


def _secure_write(path: Path, payload: dict[str, Any]) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def build_bundle(query: str, workspace: Path, *, limit: int = 20, mode: str = "auto") -> dict[str, Any]:
    limit = clamp_limit(limit)
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(workspace, 0o700)
    raw_dir = workspace / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(raw_dir, 0o700)
    observed_at = utc_now()
    fallback_reason = None
    demo = mode == "demo"

    if demo:
        raw_ads = demo_ads(query, limit)
    else:
        try:
            raw_ads = collect_public_page(query, limit)
        except Exception as error:
            if mode == "live":
                raise
            fallback_reason = str(error)[:160]
            demo = True
            raw_ads = demo_ads(query, limit)

    items = attach_ad_media([normalize_ad(raw_ad, query=query, demo=demo) for raw_ad in raw_ads[:limit]])
    sources = []
    evidence = []
    for raw_ad, item in zip(raw_ads[:limit], items):
        raw_name = f"{item['contentHash']}.json"
        _secure_write(raw_dir / raw_name, raw_ad)
        raw_ref = f"raw/{raw_name}"
        sources.append({
            "sourceType": "meta_ad_library_demo" if demo else "meta_ad_library",
            "sourceUrl": item["sourceUrl"],
            "status": "demo" if demo else "available",
            "observedAt": observed_at,
            "rawEvidenceRef": raw_ref,
            "provider": "orynt_local_meta_ads",
        })
        evidence.append({
            "evidenceId": f"evidence_{item['contentHash'][:24]}",
            "sourceType": "meta_ad_library_demo" if demo else "meta_ad_library",
            "sourceUrl": item["sourceUrl"],
            "observedAt": observed_at,
            "ingestedAt": utc_now(),
            "title": f"{item['advertiserName']} · {item['displayFormat']}",
            "contentSummary": item["contentSummary"],
            "rawEvidenceRef": raw_ref,
            "contentHash": item["contentHash"],
            "attributes": item,
        })

    limitations = []
    if demo:
        limitations.append("Meta 当前使用结构化演示样本，不代表真实市场广告或投放表现。")
        if fallback_reason:
            limitations.append(f"公开页面采集未启用或未成功，已自动回退演示样本：{fallback_reason}")
    else:
        limitations.append("Meta 仅采集公开页面首批小样本；未翻页、未登录，也不代表完整市场覆盖。")
    return {
        "provider": "orynt_local_meta_ads",
        "mode": "demo_fallback" if demo else "live_public_page",
        "sources": sources,
        "evidence": evidence,
        "coverage": {
            "attemptedAds": len(raw_ads),
            "metaSamples": len(evidence),
            "liveMetaAds": 0 if demo else len(evidence),
            "demoMetaAds": len(evidence) if demo else 0,
            "externalSignals": 0 if demo else len(evidence),
            "maxAds": limit,
            "visualAds": sum(item['mediaStatus'] == 'available' for item in items),
        },
        "limitations": limitations,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Orynt local Meta public-page sample collector")
    parser.add_argument("--query")
    parser.add_argument("--workspace")
    parser.add_argument("--hydrate", action='store_true')
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--mode", choices=("auto", "demo", "live"), default="auto")
    args = parser.parse_args()
    try:
        if args.hydrate:
            payload = json.loads(sys.stdin.read(8_000_000))
            items, direct_urls = [], set()
            for entry in payload.get('evidence', [])[:30]:
                raw = entry.get('rawAd') or {}
                item = {'id': entry['id'], 'mediaCandidates': ad_media_candidates(raw)}
                if entry.get('direct') is True and len(direct_urls) < 2:
                    direct_urls.update(candidate['sourceUrl'] for candidate in item['mediaCandidates'][:1])
                if not raw:
                    item['mediaMissingReason'] = 'RAW_RECORD_MISSING'
                items.append(item)
            sys.stdout.write(json.dumps({'evidence': attach_ad_media(items,direct_urls=frozenset(direct_urls))}, ensure_ascii=False))
            return 0
        if not args.query or not args.workspace:
            raise ValueError('query and workspace are required')
        query = re.sub(r"\s+", " ", args.query).strip()[:160]
        if not query:
            raise ValueError("Meta 采集关键词为空")
        bundle = build_bundle(query, Path(args.workspace), limit=args.limit, mode=args.mode)
        sys.stdout.write(json.dumps(bundle, ensure_ascii=False))
        return 0
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
