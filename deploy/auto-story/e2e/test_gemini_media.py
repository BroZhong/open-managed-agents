"""Offline acceptance tests: no credentials, model requests, or remote uploads."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as Obj
import unittest
from unittest.mock import patch

import audio_analysis
import gemini_media
import video_analysis


MODEL = "gemini-3.8-flash"


def interaction(status="completed", *, text="Observed actual media.", steps=None, identifier="interaction-1", model=MODEL):
    return Obj(id=identifier, status=status, output_text=text, steps=steps or [], model=model)


def pair(identifier="processing-1"):
    return [Obj(type="processing_call", id=identifier, signature="private-signature"), Obj(type="processing_result", call_id=identifier, signature="private-signature")]


class Clock:
    now = 0

    def monotonic(self):
        return self.now

    def sleep(self, duration):
        self.now += duration


class ApiFailure(Exception):
    code = 400


class FakeClient:
    def __init__(self, creates, gets=None, cancels=None):
        self.creates = list(creates)
        self.gets = list(gets or [])
        self.cancels = list(cancels or [interaction("cancelled")])
        self.calls, self.requests = [], []
        self.files = Obj(upload=self.upload, get=self.get_file, delete=self.delete_file)
        self.interactions = Obj(create=self.create, get=self.get, cancel=self.cancel)

    def take(self, sequence):
        response = sequence.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def upload(self, *, file):
        self.calls.append("upload")
        return Obj(name="files/test-upload", uri="https://private.invalid/signed-media", mime_type="audio/wav" if file.endswith(".wav") else "video/mp4", state=Obj(name="ACTIVE"))

    def get_file(self, **kwargs):
        raise AssertionError("unexpected file poll")

    def delete_file(self, **kwargs):
        self.calls.append("delete")

    def create(self, **kwargs):
        self.calls.append("create")
        self.requests.append(kwargs)
        return self.take(self.creates)

    def get(self, **kwargs):
        self.calls.append("get")
        return self.take(self.gets) if self.gets else interaction("in_progress")

    def cancel(self, **kwargs):
        self.calls.append("cancel")
        return self.take(self.cancels)

    def close(self):
        self.calls.append("close")


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / "原始 成片.mp4"
        self.audio = self.root / "原始 旁白.wav"
        self.video.write_bytes(b"original video bytes")
        self.audio.write_bytes(b"original audio bytes")
        self.output = self.root / "review.md"
        self.clock = Clock()

    def invoke(self, module, client, method, **kwargs):
        def lifecycle(actual_client):
            return gemini_media.MediaInteractions(actual_client, clock=self.clock.monotonic, sleep=self.clock.sleep, poll_interval=1, cleanup_timeout=3)
        metadata = {"path": "local-original", "sha256": "test-input-digest", "duration": 12.5}
        with patch.object(module, "create_client", return_value=client), patch.object(module, "probe_media", return_value=metadata), patch.object(module, "MediaInteractions", side_effect=lifecycle):
            return method(**kwargs)

    def video_review(self, client, **kwargs):
        return self.invoke(video_analysis, client, video_analysis.analyze, video=self.video, question="Review the full story", output=self.output, model=MODEL, timeout=10, **kwargs)

    def test_ordinary_video_remains_compatible_without_processing_records(self):
        client = FakeClient([interaction()])
        result = self.video_review(client)
        self.assertTrue(result["ok"])
        self.assertEqual(client.requests[0]["input"][0]["processing"], "static")
        self.assertFalse(client.requests[0]["background"])
        self.assertEqual(client.calls, ["upload", "create", "delete", "close"])
        self.assertEqual(self.video.read_bytes(), b"original video bytes")

    def test_agentic_waits_for_completion_and_saves_paired_evidence(self):
        client = FakeClient([interaction("in_progress")], [interaction(steps=pair())])
        result = self.video_review(client, processing="agentic", execution="background")
        self.assertTrue(result["ok"])
        self.assertTrue(client.requests[0]["background"])
        self.assertTrue(client.requests[0]["store"])
        self.assertEqual(client.requests[0]["input"][0]["processing"], "agentic")
        self.assertEqual(client.calls, ["upload", "create", "get", "delete", "close"])
        evidence_text = Path(result["evidence"]).read_text()
        evidence = json.loads(evidence_text)
        self.assertTrue(evidence["processing_pairs_valid"])
        self.assertEqual(evidence["processing_pair_count"], 1)
        self.assertNotIn("private-signature", evidence_text)
        self.assertNotIn("signed-media", evidence_text)

    def test_agentic_auto_uses_sync_and_verifies_pairs_without_interaction_id(self):
        client = FakeClient([interaction(identifier=None, steps=pair("p1") + pair("p2"))])
        result = self.video_review(client, processing="agentic")
        self.assertTrue(result["ok"])
        self.assertTrue(result["upload_deleted"])
        self.assertEqual(result["execution"], "sync")
        self.assertEqual(result["processing_pair_count"], 2)
        self.assertIsNone(result["interaction_id"])
        self.assertFalse(client.requests[0]["background"])
        self.assertFalse(client.requests[0]["store"])
        self.assertEqual(client.requests[0]["input"][0]["processing"], "agentic")
        self.assertEqual(client.calls, ["upload", "create", "delete", "close"])

    def test_agentic_rejects_missing_or_mismatched_or_duplicate_records(self):
        cases = [[], [Obj(type="processing_call", id="p")], [Obj(type="processing_result", call_id="p")],
                 [Obj(type="processing_call", id="p"), Obj(type="processing_result", call_id="q")],
                 pair("") , pair() + pair()]
        for steps in cases:
            with self.subTest(steps=steps):
                result = self.video_review(FakeClient([interaction(steps=steps)]), processing="agentic")
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"], "agentic_processing_pairs_missing_or_invalid")
                self.assertTrue(result["upload_deleted"])
                self.assertTrue(Path(result["evidence"]).is_file())

    def test_timeout_cancels_and_confirms_terminal_state_before_file_deletion(self):
        client = FakeClient([interaction("in_progress")], [interaction("in_progress"), interaction("cancelled")], [interaction("in_progress")])
        result = self.video_review(client, processing="agentic", execution="background", interaction_timeout=2)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "interaction_timeout")
        self.assertTrue(result["upload_deleted"])
        self.assertEqual(result["interaction_cleanup_status"], "cancelled")
        self.assertEqual(client.calls[-4:], ["cancel", "get", "delete", "close"])

    def test_uncertain_cancellation_retains_upload_for_recovery(self):
        for cancellation in [RuntimeError("private API body"), None]:
            with self.subTest(cancellation=cancellation):
                self.clock.now = 0
                client = FakeClient([interaction("in_progress")], cancels=[cancellation])
                result = self.video_review(client, processing="agentic", execution="background", interaction_timeout=1)
                self.assertFalse(result["upload_deleted"])
                self.assertTrue(result["cleanup_pending"])
                self.assertEqual(result["pending_upload_name"], "files/test-upload")
                self.assertNotIn("delete", client.calls)
                self.assertNotIn("private API body", json.dumps(result))

    def test_ambiguous_submission_retains_upload_but_http_rejection_deletes(self):
        for error, deleted in [(TimeoutError("signed secret URL"), False), (ApiFailure("private body"), True)]:
            with self.subTest(error=error):
                client = FakeClient([error])
                result = self.video_review(client, processing="agentic")
                self.assertFalse(result["ok"])
                self.assertEqual(result["upload_deleted"], deleted)
                self.assertNotIn(str(error), json.dumps(result))

    def test_real_sdk_bad_request_reports_status_and_redacted_reason_then_deletes(self):
        try:
            import httpx
            from google.genai._gaos.lib.compat_errors import BadRequestError
        except ImportError:
            self.skipTest("install the pinned requirements to verify real SDK errors")
        body = {"error": {"code": "INVALID_ARGUMENT", "message": "Background processing is not supported for this model. See https://provider.invalid/path?key=url-secret API_KEY=short-secret Bearer bearer-secret test-key-value", "details": [{"private": "never-print-body-details"}]}}
        response = httpx.Response(400, request=httpx.Request("POST", "https://provider.invalid/interactions?key=request-secret"))
        error = BadRequestError("entire private response body must never be printed", response=response, body=body)
        self.assertFalse(hasattr(error, "code"))
        client = FakeClient([error])
        with patch.dict("os.environ", {"GEMINI_API_KEY": "test-key-value"}):
            result = self.invoke(audio_analysis, client, audio_analysis.analyze, audio=self.audio, output=self.output, model=MODEL)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "BadRequestError")
        self.assertEqual(result["http_status"], 400)
        self.assertIn("Background processing is not supported for this model", result["provider_reason"])
        self.assertTrue(result["upload_deleted"])
        self.assertNotIn("cleanup_pending", result)
        self.assertEqual(client.calls, ["upload", "create", "delete", "close"])
        evidence_text = Path(result["evidence"]).read_text()
        for private in ("https://", "url-secret", "short-secret", "bearer-secret", "test-key-value", "never-print-body-details", "request-secret", str(error)):
            self.assertNotIn(private, evidence_text)

    def test_status_code_precedes_symbolic_code_and_server_failure_retains_upload(self):
        error = RuntimeError("do not print this body")
        error.status_code = 503
        error.code = "UNAVAILABLE"
        error.body = {"error": {"message": "Service temporarily unavailable"}}
        client = FakeClient([error])
        result = self.video_review(client)
        self.assertEqual(result["http_status"], 503)
        self.assertEqual(result["provider_reason"], "Service temporarily unavailable")
        self.assertTrue(result["cleanup_pending"])
        self.assertFalse(result["upload_deleted"])
        self.assertNotIn("delete", client.calls)

    def test_background_get_and_cancel_rejections_do_not_prove_terminal_status(self):
        try:
            import httpx
            from google.genai._gaos.lib.compat_errors import BadRequestError
        except ImportError:
            self.skipTest("install the pinned requirements to verify real SDK errors")
        response = httpx.Response(400, request=httpx.Request("GET", "https://provider.invalid/interactions/job"))
        error = BadRequestError("Unsupported file uri", response=response, body={"error": {"message": "Unsupported file uri"}})
        client = FakeClient([interaction("in_progress", identifier="known-background-job")], gets=[error], cancels=[error])
        result = self.video_review(client, processing="agentic", execution="background")
        self.assertFalse(result["ok"])
        self.assertEqual(result["http_status"], 400)
        self.assertEqual(result["provider_reason"], "Unsupported file uri")
        self.assertTrue(result["cleanup_pending"])
        self.assertFalse(result["upload_deleted"])
        self.assertEqual(result["cleanup_reason"], "interaction_not_terminal")
        self.assertEqual(result["pending_interaction_id"], "known-background-job")
        self.assertEqual(client.calls, ["upload", "create", "get", "cancel", "close"])

    def test_terminal_failure_cleans_up_and_never_claims_success(self):
        result = self.video_review(FakeClient([interaction("failed")]), processing="agentic")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "interaction_failed")
        self.assertTrue(result["upload_deleted"])

    def test_wrong_model_or_empty_answer_fails(self):
        for response in [interaction(model="unexpected-model"), interaction(text=" ")]:
            with self.subTest(response=response):
                result = self.video_review(FakeClient([response]))
                self.assertFalse(result["ok"])
                self.assertTrue(result["upload_deleted"])

    def test_audio_uses_real_audio_twice_and_keeps_transcription_independent(self):
        reference = self.root / "narration.txt"
        reference.write_text("原稿独有文本", encoding="utf-8")
        client = FakeClient([interaction(text="独立听到的转录", identifier="transcribe"), interaction(text="声音审查结论", identifier="review")])
        result = self.invoke(audio_analysis, client, audio_analysis.analyze, audio=self.audio, output=self.output, model=MODEL, reference=reference)
        self.assertTrue(result["ok"])
        self.assertTrue(result["reference_compared"])
        self.assertEqual(result["interaction_ids"], ["transcribe", "review"])
        self.assertEqual([request["input"][0]["type"] for request in client.requests], ["audio", "audio"])
        self.assertNotIn("原稿独有文本", client.requests[0]["input"][1]["text"])
        self.assertIn("原稿独有文本", client.requests[1]["input"][1]["text"])
        self.assertIn("独立听到的转录", client.requests[1]["input"][1]["text"])
        self.assertTrue(all("previous_interaction_id" not in request for request in client.requests))
        self.assertEqual(Path(result["transcript"]).read_text(), "独立听到的转录")
        self.assertEqual(self.audio.read_bytes(), b"original audio bytes")

    def test_audio_second_stage_failure_preserves_transcript(self):
        client = FakeClient([interaction(text="transcript"), interaction("failed")])
        result = self.invoke(audio_analysis, client, audio_analysis.analyze, audio=self.audio, output=self.output, model=MODEL)
        self.assertFalse(result["ok"])
        self.assertFalse(result["reference_compared"])
        self.assertEqual(Path(result["transcript"]).read_text(), "transcript")
        self.assertTrue(result["upload_deleted"])

    def test_sync_audio_normalizes_wav_mime_and_accepts_completed_unstored_responses(self):
        client = FakeClient([interaction(text="实际独立转录", identifier=None), interaction(text="实际听审", identifier=None)])
        original_upload = client.files.upload

        def upload(**kwargs):
            uploaded = original_upload(**kwargs)
            uploaded.mime_type = "audio/x-wav"
            return uploaded

        client.files.upload = upload
        result = self.invoke(audio_analysis, client, audio_analysis.analyze, audio=self.audio, output=self.output, model=MODEL)
        self.assertTrue(result["ok"])
        self.assertEqual(result["execution"], "sync")
        self.assertEqual(result["interaction_ids"], [None, None])
        self.assertTrue(all(request["input"][0]["mime_type"] == "audio/wav" for request in client.requests))
        self.assertTrue(all(request["background"] is False and request["store"] is False for request in client.requests))
        self.assertEqual(client.calls, ["upload", "create", "create", "delete", "close"])

    def test_output_collision_cannot_overwrite_source_or_reference(self):
        with patch.object(video_analysis, "create_client") as create:
            with self.assertRaisesRegex(gemini_media.ReviewError, "paths_must_differ"):
                video_analysis.analyze(self.video, "review", self.video, MODEL, 10)
            create.assert_not_called()
        with patch.object(audio_analysis, "create_client") as create:
            with self.assertRaises(gemini_media.ReviewError):
                audio_analysis.analyze(self.audio, self.output, MODEL, reference=self.output)
            create.assert_not_called()

    def test_cleanup_failure_is_not_a_success(self):
        client = FakeClient([interaction()])
        client.files.delete = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("do not expose API body"))
        result = self.video_review(client)
        self.assertFalse(result["ok"])
        self.assertTrue(result["cleanup_pending"])
        self.assertEqual(result["cleanup_error"], "RuntimeError")


class SdkSchemaTests(unittest.TestCase):
    def test_pinned_sdk_serializes_native_processing_and_parses_pairs(self):
        try:
            from google.genai import interactions as types
        except ImportError:
            self.skipTest("install the pinned requirements to run SDK schema verification")
        content = types.VideoContent(type="video", uri="https://example.invalid/video", mime_type="video/mp4", processing="agentic")
        self.assertEqual(content.model_dump()["processing"], "agentic")
        actual = types.Interaction(status="completed", id="sdk", steps=[
            types.ProcessingCallStep(type="processing_call", id="p1"),
            types.ProcessingResultStep(type="processing_result", call_id="p1"),
        ])
        self.assertTrue(gemini_media.interaction_evidence(actual)["processing_pairs_valid"])
        self.assertEqual(types.AudioContent(type="audio", uri="https://example.invalid/audio", mime_type="audio/wav").type, "audio")


if __name__ == "__main__":
    unittest.main()
