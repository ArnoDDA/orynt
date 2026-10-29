import unittest
import json
import ssl
import urllib.request
from unittest.mock import Mock, patch

from orynt_crawler import PageParser, UrlPolicy, WebsiteConnector, default_resolver, public_resolver, PinnedHTTPSHandler, SafeRedirectHandler, FetchError


PUBLIC = lambda host: {"93.184.216.34"}


class UrlPolicyTests(unittest.TestCase):
    def test_allows_only_public_same_site_http_urls(self):
        policy = UrlPolicy("https://example.com", resolver=PUBLIC)
        self.assertEqual(policy.validate("https://www.example.com/products#details"), "https://www.example.com/products")
        with self.assertRaisesRegex(ValueError, "同域"):
            policy.validate("https://other.example/products")
        with self.assertRaisesRegex(ValueError, "HTTP"):
            policy.validate("file:///etc/passwd")

    def test_rejects_private_network_resolution(self):
        with self.assertRaisesRegex(ValueError, "内网"):
            UrlPolicy("http://internal.example", resolver=lambda host: {"127.0.0.1"})

    def test_fake_ip_dns_is_replaced_with_verified_public_resolution(self):
        answer = [(None, None, None, None, ('198.18.0.165', 443))]
        with patch('orynt_crawler.socket.getaddrinfo', return_value=answer), patch('orynt_crawler.public_resolver', return_value=frozenset({'23.227.38.65'})) as resolve:
            policy = UrlPolicy('https://store.example/products/bottle')
            self.assertEqual(policy.addresses('store.example'), {'23.227.38.65'})
            resolve.assert_called_once_with('store.example')

    def test_private_mixed_and_literal_addresses_never_use_dns_recovery(self):
        for host, addresses in [('127.0.0.1', ['127.0.0.1']), ('198.18.0.10', ['198.18.0.10']), ('internal.example', ['10.0.0.4']), ('mixed.example', ['198.18.0.5', '127.0.0.1']), ('link.example', ['169.254.169.254']), ('ipv6.example', ['::1'])]:
            with self.subTest(host=host), patch('orynt_crawler.socket.getaddrinfo', return_value=[(None, None, None, None, (ip, 443)) for ip in addresses]), patch('orynt_crawler.public_resolver') as resolve:
                with self.assertRaises(FetchError):
                    UrlPolicy('https://' + host + '/private')
                resolve.assert_not_called()

    def test_public_dns_validates_response_and_sends_only_hostname(self):
        for addresses, accepted in [(['23.227.38.65'], True), (['127.0.0.1'], False), (['23.227.38.65', '169.254.169.254'], False)]:
            public_resolver.cache_clear()
            connection = Mock()
            connection.getresponse.return_value.status = 200
            connection.getresponse.return_value.read.return_value = json.dumps({'Status': 0, 'Answer': [{'type': 1, 'data': address} for address in addresses]}).encode()
            with patch('orynt_crawler.http.client.HTTPSConnection', return_value=connection) as https:
                if accepted:
                    self.assertEqual(public_resolver('store.example'), frozenset(addresses))
                    https.assert_called_once_with('dns.google', timeout=5)
                    self.assertEqual(connection.request.call_args.args[:2], ('GET', '/resolve?name=store.example&type=A'))
                else:
                    with self.assertRaises(FetchError):
                        public_resolver('store.example')
                connection.close.assert_called_once()
        public_resolver.cache_clear()

    def test_connection_pins_validated_address_and_preserves_tls_hostname(self):
        policy = UrlPolicy('https://store.example/p', resolver=PUBLIC)
        connection = PinnedHTTPSHandler(policy).connection('store.example', timeout=3)
        self.assertEqual(connection.host, 'store.example')
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        with patch('orynt_crawler.socket.create_connection', return_value=object()) as connect:
            connection._create_connection(('store.example', 443), timeout=3)
            self.assertEqual(connect.call_args.args[0], ('93.184.216.34', 443))
        redirect = SafeRedirectHandler(policy)
        request = urllib.request.Request('https://store.example/p')
        for target in ['http://127.0.0.1/private', 'https://other.example/p', 'https://store.example:8443/p']:
            with self.assertRaises(ValueError):
                redirect.redirect_request(request, None, 302, '', {}, target)


class ExtractionTests(unittest.TestCase):
    def test_extracts_readable_text_and_links_without_script_content(self):
        parser = PageParser()
        parser.feed("<html><head><title>Brand</title><script>secret()</script></head><body><main>Hello product</main><a href='/pricing'>Price</a></body></html>")
        self.assertEqual(" ".join(parser.title_parts), "Brand")
        self.assertIn("Hello product", " ".join(parser.text_parts))
        self.assertNotIn("secret", " ".join(parser.text_parts))
        self.assertEqual(parser.links, ["/pricing"])

    def test_prioritizes_product_pages(self):
        policy = UrlPolicy("https://example.com", resolver=PUBLIC)
        links = WebsiteConnector()._rank_links(["/legal", "/products/widget", "/about"], "https://example.com", policy)
        self.assertEqual(links[0], "https://example.com/products/widget")
        self.assertEqual(links[1], "https://example.com/about")


if __name__ == "__main__":
    unittest.main()
