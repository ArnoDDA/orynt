import tempfile
import unittest
import json
from pathlib import Path

from meta_ads_crawler import build_bundle, collect_ad_nodes, collect_script_ad_nodes, normalize_ad
from reference_media import ad_media_candidates, attach_ad_media, download_ad_image
from unittest.mock import patch


class MetaResponseTests(unittest.TestCase):
    def test_finds_and_deduplicates_nested_ad_nodes(self):
        ad = {"ad_archive_id": "123", "page_name": "Example", "snapshot": {}}
        payload = {"data": {"edges": [{"node": ad}, {"node": ad}]}}
        self.assertEqual(collect_ad_nodes(payload), [ad])

    def test_collects_nodes_from_public_page_json_scripts(self):
        scripts = [
            "not json",
            json.dumps({"payload": {"ad_archive_id": "123", "page_name": "Public advertiser", "snapshot": {"body": {"text": "Public copy"}}}}),
            json.dumps({"duplicate": {"ad_archive_id": "123", "page_name": "Public advertiser", "snapshot": {}}}),
        ]
        nodes = collect_script_ad_nodes(scripts)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["ad_archive_id"], "123")

    def test_normalizes_visible_creative_fields(self):
        item = normalize_ad({
            "ad_archive_id": "123",
            "page_id": "page-1",
            "page_name": "Example",
            "start_date": 1788307200,
            "is_active": True,
            "snapshot": {
                "body": {"text": "A clear product hook"},
                "title": "Product proof",
                "cta_text": "Learn more",
                "videos": [{}],
                "link_url": "https://example.com/landing?utm_source=meta",
            },
        }, query="product")
        self.assertEqual(item["displayFormat"], "VIDEO")
        self.assertEqual(item["landingDomain"], "example.com")
        self.assertIn("A clear product hook", item["contentSummary"])
        self.assertFalse(item["demo"])


class MetaDemoBundleTests(unittest.TestCase):
    def test_demo_mode_is_local_limited_and_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = build_bundle("daily bottle", Path(directory), limit=50, mode="demo")
            self.assertEqual(bundle["mode"], "demo_fallback")
            self.assertEqual(bundle["coverage"]["demoMetaAds"], 12)
            self.assertEqual(bundle["coverage"]["liveMetaAds"], 0)
            self.assertEqual(bundle["coverage"]["maxAds"], 30)
            self.assertTrue(all(item["status"] == "demo" for item in bundle["sources"]))
            self.assertTrue(all("演示样本" in item["contentSummary"] for item in bundle["evidence"]))
            raw_files = list((Path(directory) / "raw").glob("*.json"))
            self.assertEqual(len(raw_files), 12)

    def test_extracts_posters_and_carousel_images_without_using_profile_or_video_urls(self):
        raw = {'snapshot': {'page_profile_picture_url':'https://cdn.example/logo.jpg',
               'videos':[{'video_hd_url':'https://cdn.example/ad.mp4','video_preview_image_url':'https://cdn.example/poster.jpg'}],
               'cards':[{'original_image_url':'https://cdn.example/detail.jpg'}, {'original_image_url':'https://cdn.example/detail.jpg'}]}}
        self.assertEqual(ad_media_candidates(raw),[
            {'sourceUrl':'https://cdn.example/poster.jpg','kind':'video_poster'},
            {'sourceUrl':'https://cdn.example/detail.jpg','kind':'image'}])
        raw['snapshot']={'images':[{'original_image_url':'javascript:alert(1)'},{'original_image_url':'https://user:secret@cdn.example/x.jpg'}]}
        self.assertEqual(ad_media_candidates(raw),[])

    def test_failed_media_does_not_erase_copy_or_become_a_real_visual(self):
        items=[{'bodyText':'Real copy','mediaCandidates':[{'sourceUrl':'https://cdn.example/expired.jpg','kind':'image'}]},
               {'demo':True,'mediaCandidates':[{'sourceUrl':'https://cdn.example/fake.jpg','kind':'image'}]}]
        with patch('reference_media.download_ad_image'):
            result=attach_ad_media(items,loader=lambda _: (_ for _ in ()).throw(ValueError('expired')))
        self.assertEqual(result[0]['bodyText'],'Real copy')
        self.assertEqual(result[0]['mediaStatus'],'unavailable')
        self.assertEqual(result[1]['media'],[])
        self.assertNotIn('mediaCandidates',result[0])

    def test_download_keeps_private_network_and_source_exclusion_checks(self):
        with self.assertRaises(ValueError):
            download_ad_image({'sourceUrl':'https://127.0.0.1/private.png','kind':'image'})
        with patch('reference_media.UrlPolicy'), patch('reference_media.HttpClient') as client, patch('reference_media.WebsiteConnector') as website:
            website.return_value._load_robots.return_value.can_fetch.return_value=False
            with self.assertRaisesRegex(ValueError,'ROBOTS_DENIED'):
                download_ad_image({'sourceUrl':'https://cdn.example/ad.png','kind':'image'})
            client.return_value.get.assert_not_called()

    def test_direct_permission_applies_only_to_the_exact_selected_poster(self):
        selected='https://cdn.example/selected.jpg'
        calls=[]
        def loader(candidate, *, check_robots=True):
            calls.append((candidate['sourceUrl'], check_robots))
            raise ValueError('DOWNLOAD_FAILED')
        attach_ad_media([{'mediaCandidates':[
            {'sourceUrl':selected,'kind':'video_poster'},
            {'sourceUrl':'https://cdn.example/other.jpg','kind':'image'}
        ]}],loader=loader,direct_urls=frozenset([selected]))
        self.assertCountEqual(calls,[(selected,False),('https://cdn.example/other.jpg',True)])


if __name__ == "__main__":
    unittest.main()
