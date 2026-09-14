"""Real pinned SDK transport tests; every HTTP request is intercepted offline."""
import json
import os
from types import SimpleNamespace as Obj
import unittest
from unittest.mock import patch

import gemini_media

try:
    import httpx
    from google import genai
except ImportError:
    httpx = genai = None


@unittest.skipIf(genai is None, "install pinned requirements for SDK transport verification")
class InteractionSubmissionTests(unittest.TestCase):
    def client(self, handler):
        constructor = genai.Client

        def intercepted_client(**kwargs):
            kwargs["http_options"]["client_args"] = {"transport": httpx.MockTransport(handler)}
            return constructor(**kwargs)

        with patch.dict(os.environ, {"GEMINI_API_KEY": "offline-placeholder", "GOOGLE_API_KEY": ""}), patch.object(genai, "Client", side_effect=intercepted_client):
            client = gemini_media.create_client()
        self.addCleanup(client.close)
        return client

    def test_sync_and_background_submissions_are_never_implicitly_repeated(self):
        for background in (False, True):
            for failure in (503, "read_timeout"):
                with self.subTest(background=background, failure=failure):
                    requests = []

                    def handler(request):
                        requests.append(request)
                        if failure == "read_timeout":
                            raise httpx.ReadTimeout("offline ambiguous response", request=request)
                        return httpx.Response(failure, json={"error": {"code": failure, "message": "offline server failure"}})

                    client = self.client(handler)
                    lifecycle = gemini_media.MediaInteractions(client)
                    lifecycle.uploaded = Obj(name="files/offline-upload", uri="https://example.invalid/media", mime_type="audio/wav")
                    with self.assertRaises(Exception):
                        lifecycle.run(model="gemini-3.8-flash", kind="audio", question="Offline test", timeout=10, background=background)

                    self.assertEqual(len(requests), 1)
                    self.assertEqual(requests[0].method, "POST")
                    body = json.loads(requests[0].content)
                    self.assertEqual(body["model"], "gemini-3.8-flash")
                    self.assertEqual(body["background"], background)
                    self.assertEqual(body["store"], background)
                    cleanup = lifecycle.cleanup()
                    self.assertTrue(cleanup["cleanup_pending"])
                    self.assertEqual(cleanup["cleanup_reason"], "submission_uncertain")
                    self.assertFalse(cleanup["upload_deleted"])
                    self.assertEqual(len(requests), 1)

    def test_disabling_interaction_retries_keeps_files_and_known_job_reads_working(self):
        requests = []

        def handler(request):
            requests.append(request)
            if "/interactions/" in request.url.path:
                return httpx.Response(200, json={"id": "known-job", "status": "completed", "model": "gemini-3.8-flash"})
            return httpx.Response(200, json={"name": "files/offline-upload", "state": "ACTIVE", "mimeType": "audio/wav"})

        client = self.client(handler)
        self.assertEqual(client.files.get(name="files/offline-upload").state.name, "ACTIVE")
        self.assertEqual(client.interactions.get(id="known-job").status, "completed")
        self.assertEqual([request.method for request in requests], ["GET", "GET"])
        self.assertIsNone(client._api_client._http_options.retry_options)


if __name__ == "__main__":
    unittest.main()
