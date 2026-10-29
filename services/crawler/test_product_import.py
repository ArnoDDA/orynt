import unittest
from unittest.mock import patch
from types import SimpleNamespace
import json

from product_import import extract, collect, image_format
from orynt_crawler import UrlPolicy
from product_media import product_media


class ProductImportTests(unittest.TestCase):
    def test_gallery_deduplicates_resizes_and_excludes_recommendations_and_navigation(self):
        html = '''<header><div class="product-gallery"><img src="/logo.png"></div></header>
          <div class="product-media"><img alt="Bottle back" srcset="/back.jpg?width=300 300w, /back.jpg?width=1600 1600w">
          <img src="/front.jpg?width=100"><source type="video/mp4" src="/demo.mp4"></div>
          <div class="related-products"><div class="product-gallery"><img src="/other.jpg"></div></div>'''
        result = product_media(html, 'https://example.com/products/bottle', ['https://example.com/front.jpg?width=1200'])
        self.assertEqual(len(result['images']), 2)
        self.assertTrue(any('width=1600' in im['url'] for im in result['images']))
        self.assertFalse(any('logo' in im['url'] or 'other' in im['url'] for im in result['images']))
        self.assertEqual(result['videos'][0]['status'], 'link_only')

    def test_shopify_selected_variant_is_first_and_other_colors_remain_explicit(self):
        data = {'handle':'bottle','images':['/red.png','/black.png','/detail.png'], 'variants':[
            {'id':1,'title':'Red','featured_image':{'src':'/red.png'}},
            {'id':2,'title':'Black','sku':'BLK','featured_image':{'src':'/black.png'}}]}
        result = product_media('', 'https://example.com/products/bottle?variant=2', [], data)
        self.assertEqual(result['selectedVariantId'], '2')
        self.assertEqual(result['images'][0]['variantName'], 'Black')
        self.assertEqual(result['images'][-1]['identityStatus'], 'other_variant')
        wrong = product_media('', 'https://example.com/products/another', [], data)
        self.assertEqual(wrong['images'], [])
        self.assertEqual(wrong['variants'], [])

    def test_download_deduplicates_real_bytes_without_stopping_after_an_unreadable_image(self):
        png = b'\x89PNG\r\n\x1a\n' + b'example'
        class Client:
            def __init__(self,*args,**kwargs):
                self.attempts = kwargs.get('max_retries', 1)
            def get(self,url,**kwargs):
                if url.endswith('.png'):
                    self.assert_attempt()
                    if 'broken' in url: raise ValueError('unavailable')
                    return SimpleNamespace(url=url,body=png)
                return SimpleNamespace(url=url,body=b'<meta property="og:type" content="product"><div class="product-gallery"><img src="/broken.png"><img src="/front.png"><img src="/same.png"></div>')
            def assert_attempt(self):
                if self.attempts < 1: raise ValueError('No download attempt')
        with patch('product_import.UrlPolicy'), patch('product_import.HttpClient',Client), patch('product_import.WebsiteConnector._load_robots',return_value=SimpleNamespace(can_fetch=lambda *args:True)):
            result=collect('https://example.com/products/bottle')
        self.assertEqual(len(result['images']), 1)
        self.assertEqual(result['images'][0]['sourceType'], 'product_gallery')

    def test_explicit_media_variant_links_override_unknown_gallery_metadata(self):
        data = {'handle':'bottle', 'images':['/black-detail.png'], 'variants':[{'id':1,'title':'Black','featured_image':{'src':'/black.png'}}], 'media':[{'media_type':'image','preview_image':{'src':'/black-detail.png'},'alt':'Black lid detail','variant_ids':[1]}]}
        result = product_media('', 'https://example.com/products/bottle?variant=1', [], data)
        detail = next(im for im in result['images'] if im['url'].endswith('black-detail.png'))
        self.assertEqual(detail['variantId'], '1')
        self.assertEqual(detail['identityStatus'], 'selected_variant')
        self.assertEqual(detail['alt'], 'Black lid detail')

    def test_structured_product_and_plain_text(self):
        product = {'@type':'Product','name':'Daily Coffee','description':'<p>Chocolate &amp; <b>caramel</b></p>', 'brand':{'name':'Roaster'}, 'image':['/coffee.jpg', {'contentUrl':'https://cdn.example.com/bag.png'}]}
        result = extract('<script type="application/ld+json">'+json.dumps({'@graph':[product]})+'</script>', 'https://example.com/products/coffee')
        self.assertEqual(result['fields']['product']['value'], 'Daily Coffee')
        self.assertEqual(result['fields']['claim']['value'], 'Chocolate & caramel')
        self.assertEqual(result['fields']['brandName']['sourceType'], 'schema_brand')
        self.assertNotIn('audience', result['fields'])
        self.assertEqual(result['imageUrls'][0], 'https://example.com/coffee.jpg')
        self.assertEqual(result['pageKind'], 'product')

    def test_multiple_products_do_not_choose_arbitrary_recommendation(self):
        products=[{'@type':'Product','name':'Other'}, {'@type':'Product','name':'Another'}]
        html='<meta property="og:title" content="Our collection"><script type="application/ld+json">'+json.dumps(products)+'</script>'
        result=extract(html,'https://example.com/collection')
        self.assertEqual(result['pageKind'],'website')
        self.assertEqual(result['fields']['product']['value'],'Our collection')
        products[1]['url']='/products/target'
        result=extract('<script type="application/ld+json">'+json.dumps(products)+'</script>','https://example.com/products/target')
        self.assertEqual(result['fields']['product']['value'],'Another')

    def test_structured_product_attributes_and_candidates_keep_their_product_boundary(self):
        products = [
            {'@type': 'Product', 'name': 'Cotton Shirt', 'url': '/products/shirt', 'material': 'Cotton', 'color': 'Blue', 'sku': 'SHIRT-1', 'model': 'Everyday', 'category': 'Apparel', 'additionalProperty': [{'name': 'Fit', 'value': 'Regular'}]},
            {'@type': 'Product', 'name': 'Serum', 'url': '/products/serum', 'category': 'Skincare'},
            {'@type': 'Product', 'name': 'External', 'url': 'https://unrelated.example/product'}
        ]
        html = '<script type="application/ld+json">' + json.dumps(products) + '</script>'
        result = extract(html, 'https://example.com/products/shirt')
        self.assertEqual(result['details']['sku'], 'SHIRT-1')
        self.assertEqual(result['details']['attributes'][0], {'name': '材质', 'value': 'Cotton'})
        self.assertEqual(len(result['details']['candidates']), 2)
        collection = extract(html, 'https://example.com/collection')
        self.assertEqual(collection['details']['attributes'], [])
        self.assertTrue(any('多个商品' in t for t in collection['limitations']))

    def test_invalid_json_and_executable_content_are_ignored(self):
        result=extract('<script>not_a_real_call()</script><script type="application/ld+json">{invalid</script><h1>Product &amp; Name</h1><meta name="description" content="Page description">','https://example.com/p')
        self.assertEqual(result['fields']['product']['value'],'Product & Name')
        self.assertEqual(result['fields']['claim']['sourceType'],'page_description')

    def test_explicit_product_meta_supports_stores_without_product_json_ld(self):
        result = extract('<meta property="og:type" content="product"><meta property="og:title" content="FreeSip Twist"><meta property="og:image" content="/bottle.png">', 'https://example.com/products/bottle')
        self.assertEqual(result['pageKind'], 'product')
        self.assertEqual(result['fields']['product']['sourceType'], 'page_title')
        self.assertEqual(result['details']['attributes'], [])
        self.assertTrue(any('页面标记' in note for note in result['limitations']))
        collection = extract('<meta property="og:type" content="product"><script type="application/ld+json">' + json.dumps([{'@type': 'Product', 'name': 'One'}, {'@type': 'Product', 'name': 'Two'}]) + '</script>', 'https://example.com/collection')
        self.assertEqual(collection['pageKind'], 'website')

    def test_public_page_survives_image_failure(self):
        class Client:
            def __init__(self,*args,**kwargs): pass
            def get(self,url,**kwargs):
                if url.endswith('.png'): raise ValueError('unavailable')
                return SimpleNamespace(url=url,body=b'<meta property="og:title" content="Coffee"><meta property="og:image" content="/bag.png">')
        with patch('product_import.UrlPolicy'), patch('product_import.HttpClient',Client), patch('product_import.WebsiteConnector._load_robots',return_value=SimpleNamespace(can_fetch=lambda *args:True)):
            result=collect('https://example.com/p')
        self.assertEqual(result['fields']['product']['value'],'Coffee')
        self.assertEqual(result['images'],[])
        self.assertTrue(any('无法读取' in text for text in result['limitations']))

    def test_robots_denial_stops_page_read(self):
        with patch('product_import.UrlPolicy'), patch('product_import.HttpClient') as client, patch('product_import.WebsiteConnector._load_robots',return_value=SimpleNamespace(can_fetch=lambda *args:False)):
            with self.assertRaises(ValueError): collect('https://example.com')
            client.return_value.get.assert_not_called()

    def test_image_types_and_private_url_rejected(self):
        self.assertEqual(image_format(b'RIFF0000WEBPxx')[0],'image/webp')
        with self.assertRaises(ValueError): image_format(b'<svg></svg>')
        for url in ['http://127.0.0.1/private','file:///tmp/file','http://169.254.169.254/latest']:
            with self.assertRaises(ValueError): UrlPolicy(url)


if __name__=='__main__': unittest.main()
