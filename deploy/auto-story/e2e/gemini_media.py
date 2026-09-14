"""Bounded Files + Interactions lifecycle for the original media review Skills."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


TERMINAL = {"completed", "failed", "cancelled"}


class ReviewError(RuntimeError):
    """An intentionally safe error code; API response bodies are never logged."""


def field(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def http_status(error):
    # Files errors expose code; Interactions' Stainless-compatible errors use
    # status_code. A symbolic provider code must not hide a numeric HTTP status.
    for name in ("status_code", "code"):
        value = getattr(error, name, None)
        if isinstance(value, (str, int)) and str(value).isdigit() and 100 <= int(value) <= 599:
            return int(value)
    return None


def provider_reason(error):
    """Extract one diagnostic message, never stringify an API body or request."""
    body = getattr(error, "body", None)
    if body is None:
        body = getattr(error, "details", None)
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            body = None
    message = None
    if isinstance(body, dict):
        nested = body.get("error")
        message = nested.get("message") if isinstance(nested, dict) else body.get("message")
    if not isinstance(message, str) or not message.strip():
        return None
    # Providers may echo rejected field values. Remove credential values from
    # the process environment before generic URL/token filtering and truncation.
    for name, value in os.environ.items():
        if len(value) >= 4 and re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH", name, re.I):
            message = message.replace(value, "[redacted]")
    message = re.sub(r"(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>\"']+", "[url]", message, flags=re.I)
    message = re.sub(r"\bBearer\s+\S+", "Bearer [redacted]", message, flags=re.I)
    message = re.sub(r"\b(api[-_ ]?key|access[-_ ]?token|token|secret|password|authorization|signature)\b[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|\S+)", r"\1=[redacted]", message, flags=re.I)
    message = re.sub(r"\b(?:AIza|sk-)[A-Za-z0-9_-]+|[A-Za-z0-9_+/=-]{32,}", "[redacted]", message)
    return " ".join(message.split())[:400]


def error_record(error):
    result = {"error": str(error) if isinstance(error, ReviewError) else type(error).__name__}
    status = http_status(error)
    if status is not None:
        result["http_status"] = status
        reason = provider_reason(error)
        if reason:
            result["provider_reason"] = reason
    return result


def create_client():
    from google import genai
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise ReviewError("missing_GEMINI_API_KEY_or_GOOGLE_API_KEY")
    client = genai.Client(api_key=key, http_options={"timeout": 120_000})
    # Pinned google-genai 2.22.0 gives Interactions its own retry policy:
    # even HttpOptions retry_options.attempts=1 sends a failed POST twice.
    # Null disables that generated policy for create/get/cancel. Files keep
    # their separate SDK policy; known jobs are still polled by this helper.
    # An ambiguous paid submission must reach our recovery logic immediately.
    client.interactions.sdk_configuration.retry_config = None
    return client


def probe_media(path, kind):
    if not path.is_file():
        raise ReviewError("media_file_not_found")
    process = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    metadata = json.loads(process.stdout)
    if not any(stream.get("codec_type") == kind for stream in metadata.get("streams", [])):
        raise ReviewError(f"input_has_no_{kind}")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else _digest(source)
    return {"path": str(path.resolve()), "sha256": digest, "duration": float(metadata["format"]["duration"])}


def _digest(source):
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def require_distinct_paths(sources, outputs):
    resolved = [Path(path).resolve() for path in [*sources, *outputs]]
    if len(set(resolved)) != len(resolved):
        raise ReviewError("source_and_output_paths_must_differ")


def evidence_path(output):
    return output.with_suffix(".evidence.json")


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def interaction_evidence(interaction):
    """Keep verifiable processing IDs, never signatures, URIs, or request bodies."""
    steps = []
    for step in field(interaction, "steps", []) or []:
        kind = field(step, "type")
        if kind == "processing_call":
            steps.append({"type": kind, "id": field(step, "id")})
        elif kind == "processing_result":
            steps.append({"type": kind, "call_id": field(step, "call_id")})
    calls = [step["id"] for step in steps if step["type"] == "processing_call"]
    results = [step["call_id"] for step in steps if step["type"] == "processing_result"]
    valid_ids = all(isinstance(value, str) and value.strip() for value in [*calls, *results])
    paired = bool(calls) and valid_ids and len(set(calls)) == len(calls) and len(set(results)) == len(results) and set(calls) == set(results)
    return {
        "interaction_id": field(interaction, "id"),
        "status": field(interaction, "status"),
        "response_model": field(interaction, "model"),
        "processing_steps": steps,
        "processing_pairs_valid": bool(paired),
        "processing_pair_count": len(calls) if paired else 0,
    }


class MediaInteractions:
    """Own one uploaded file and sequential interactions that refer to it."""

    def __init__(self, client, *, clock=time.monotonic, sleep=time.sleep, poll_interval=2, cleanup_timeout=30):
        self.client = client
        self.clock, self.sleep = clock, sleep
        self.poll_interval, self.cleanup_timeout = poll_interval, cleanup_timeout
        self.uploaded = None
        self.current = None
        self.submission_uncertain = False

    def _remaining(self, deadline):
        remaining = deadline - self.clock()
        if remaining <= 0:
            raise ReviewError("interaction_timeout")
        return remaining

    def _pause(self, deadline):
        self.sleep(min(self.poll_interval, self._remaining(deadline)))

    def upload(self, path, timeout):
        self.uploaded = self.client.files.upload(file=str(path))
        deadline = self.clock() + timeout
        while True:
            state = field(self.uploaded, "state")
            state = field(state, "name", state)
            if state == "ACTIVE":
                return self.uploaded
            if state == "FAILED":
                raise ReviewError("media_processing_failed")
            if self.clock() >= deadline:
                raise ReviewError("media_processing_timeout")
            self._pause(deadline)
            self.uploaded = self.client.files.get(name=field(self.uploaded, "name"))

    def run(self, *, model, kind, question, timeout, background, processing=None):
        deadline = self.clock() + timeout
        content = {"type": kind, "uri": field(self.uploaded, "uri"), "mime_type": field(self.uploaded, "mime_type")}
        if kind == "audio" and content["mime_type"] in {"audio/x-wav", "audio/wave", "audio/vnd.wave"}:
            content["mime_type"] = "audio/wav"
        if processing is not None:
            content["processing"] = processing
        self.current = None
        self.submission_uncertain = True
        try:
            self.current = self.client.interactions.create(
                model=model,
                input=[content, {"type": "text", "text": question}],
                background=background,
                store=background,
                timeout=min(120, self._remaining(deadline)),
            )
            self.submission_uncertain = self.current is None
        except Exception as error:
            # A rejected request did not start a job. Network timeouts and 5xx
            # are ambiguous: retain the file instead of breaking a possible job.
            if http_status(error) in {400, 401, 403, 404, 422, 429}:
                self.submission_uncertain = False
            raise
        while field(self.current, "status") not in TERMINAL:
            if field(self.current, "status") == "requires_action":
                raise ReviewError("interaction_requires_action")
            identifier = field(self.current, "id")
            if not identifier:
                raise ReviewError("incomplete_interaction_missing_id")
            self._pause(deadline)
            updated = self.client.interactions.get(id=identifier, timeout=min(30, self._remaining(deadline)))
            if updated is None:
                raise ReviewError("empty_interaction_response")
            self.current = updated
        if field(self.current, "status") != "completed":
            raise ReviewError(f"interaction_{field(self.current, 'status')}")
        if self.clock() > deadline:
            raise ReviewError("interaction_timeout")
        response_model = field(self.current, "model")
        if response_model and response_model != model:
            raise ReviewError("unexpected_response_model")
        if not (field(self.current, "output_text", "") or "").strip():
            raise ReviewError("empty_media_analysis")
        return self.current

    def cleanup(self):
        result = {"upload_deleted": False}
        if self.uploaded is None:
            return result
        identifier = field(self.current, "id")
        if self.current is not None and field(self.current, "status") not in TERMINAL and identifier:
            deadline = self.clock() + self.cleanup_timeout
            try:
                updated = self.client.interactions.cancel(id=identifier, timeout=min(10, self._remaining(deadline)))
                if updated is None:
                    raise ReviewError("empty_cancellation_response")
                self.current = updated
                while field(self.current, "status") not in TERMINAL:
                    self._pause(deadline)
                    updated = self.client.interactions.get(id=identifier, timeout=min(10, self._remaining(deadline)))
                    if updated is None:
                        raise ReviewError("empty_interaction_response")
                    self.current = updated
                result["interaction_cleanup_status"] = field(self.current, "status")
            except Exception as error:
                result["cleanup_error"] = error_record(error)["error"]
        running = self.current is not None and field(self.current, "status") not in TERMINAL
        if self.submission_uncertain or running:
            result.update(
                cleanup_pending=True,
                pending_upload_name=field(self.uploaded, "name"),
                pending_interaction_id=identifier,
                cleanup_reason="submission_uncertain" if self.submission_uncertain else "interaction_not_terminal",
            )
            return result
        try:
            self.client.files.delete(name=field(self.uploaded, "name"))
            result["upload_deleted"] = True
        except Exception as error:
            result.update(cleanup_error=error_record(error)["error"], cleanup_pending=True, pending_upload_name=field(self.uploaded, "name"))
        return result


def finish_review(client, lifecycle, result):
    result.update(lifecycle.cleanup())
    if result.get("cleanup_error") or not result.get("upload_deleted"):
        result["ok"] = False
    try:
        client.close()
    except Exception as error:
        result.update(ok=False, client_close_error=type(error).__name__)
