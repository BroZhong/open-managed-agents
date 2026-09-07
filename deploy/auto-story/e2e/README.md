# auto-story capability E2E

These scripts exercise the commands described by the existing local MediaKit, VFS and video-analysis Skills. They do not package or install Skills. Import the original Skill directories into the Agent separately.

Requires Python 3.10+, `vfs-cli`, `mediakit-cli`, `ffmpeg`, `ffprobe`, and the dependencies in `requirements.txt`. The earlier synthetic-media acceptance used VFS v0.3.13 and MediaKit 0.2.1. The current narration sandbox `auto-story-0.1.1` uses the published VFS v0.3.14, adding SeedAudio generation and audio Resource registration; MediaKit remains 0.2.1. See the [narration acceptance record](../../../docs/auto-story-narration-e2e-2026-09-07.md) for its separate progress and pending checks.

```bash
python3 -m venv /tmp/auto-story-e2e-venv
/tmp/auto-story-e2e-venv/bin/python -m pip install -r deploy/auto-story/e2e/requirements.txt
/tmp/auto-story-e2e-venv/bin/python deploy/auto-story/e2e/run.py --output-dir /tmp/auto-story-e2e-result
```

Pass credentials through the process environment: `VFS_TOKEN`, `RUNTIME_ENV`, `MEDIAKIT_API_KEY`, and either `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Existing VFS endpoint and project variables remain effective. The scripts do not print environment values, account records, remote response bodies, or signed URLs. `httpx[socks]` supports local SOCKS proxies when present; the sandbox can use direct egress.

`run.py` generates a three-second H.264/AAC video with a red background, white shape and a continuous tone, plus matching WAV and PNG files. It uses an intra-frame fixture because MediaKit local trimming uses stream copying and arbitrary footage may cut at keyframes. The checks then run independently:

| Check | Observable result |
| --- | --- |
| MediaKit video | Real local video metadata, including video and audio streams |
| MediaKit audio | Real local audio metadata |
| MediaKit editing | A real trimmed file with the expected duration and an audio stream |
| MediaKit image | Real authenticated Cloud PNG metadata with matching dimensions |
| VFS | Embedded guide, exact video-model schema, and authenticated read-only Teamwork query |
| video-analysis | Actual video and audio uploaded to Gemini, completed analysis, and remote file deletion |

The current default Gemini model is `gemini-3.8-flash`, verified against the [official video guide](https://ai.google.dev/gemini-api/docs/video-understanding) on 2026-09-07. Override it with `GEMINI_VIDEO_MODEL` or `--gemini-model` when the documented model changes. `video_analysis.py` uses the Files and Interactions APIs. It deletes its remote upload after the interaction reaches a terminal state, including ordinary failures; a cleanup failure makes the check fail. An uncertain or still-running job retains its upload and reports `cleanup_pending` so cleanup does not interrupt processing.

`report.json` and stdout contain structured success flags and artifact paths. Any failed required check exits nonzero. `--local-only` deliberately skips authenticated Cloud, VFS and Gemini checks and labels the report `scope: local`; it is not a complete E2E pass. Each helper is independently executable with `--help` where it accepts arguments.

This verifies representative tool operations, authentication, media transfer and Gemini cleanup. It does not exercise all MediaKit Cloud algorithms, create VFS resources, or prove the Agent selected/read its equipped Skills. Use an Agent Session with the imported original Skills and inspect its tool events for that additional check.

## Narration and final-video review

Copy `audio_analysis.py`, `video_analysis.py`, and `gemini_media.py` together into the Session workspace. They are acceptance helpers; the Agent should still read its equipped original Skills. Both helpers upload the actual media file, record its SHA-256 and duration, and leave the original file unchanged.

For a real narration WAV, run independent transcription followed by a separate listening review:

```bash
python3 audio_analysis.py --audio narration.wav --reference-text narration.txt --output audio-review.md
```

This makes two sequential Gemini understanding requests. The first receives only the actual audio and transcription instructions, without the reference script or prior interaction context. The second receives the actual audio again, the independent transcript, and the optional reference script. It reviews script mismatches, intelligibility, voice consistency within the story, delivery, music/effects balance, distortion, and sentence endings. Without `--reference-text`, the report states that script fidelity cannot be verified. Use `--question` for additional review focus. `GEMINI_AUDIO_MODEL` takes precedence over `GEMINI_VIDEO_MODEL`; `--model` overrides both.

Audio defaults to synchronous Interactions (`background=False`, `store=False`), the route verified with actual narration and `gemini-3.8-flash` on 2026-09-07. WAV MIME aliases such as `audio/x-wav` are normalized to `audio/wav` in the input. A completed unstored response may have no interaction ID; the helper preserves that absence. Background audio was rejected with HTTP 400 because the selected provider route had not enabled audio input; `--execution background` is an explicit option for a provider that supports it, without automatic fallback or model changes.

For the finished film, require native agentic processing explicitly:

```bash
python3 video_analysis.py --video final.mp4 --processing agentic --output video-review.md \
  --question "Review the entire film's first-person narration, audiovisual consistency, pacing, continuity, and intelligibility. Give timestamped observations and distinguish uncertainty."
```

The request sets `processing: "agentic"` inside the video input. Success requires a completed interaction with nonempty text and at least one nonempty `processing_call.id` paired with exactly one `processing_result.call_id`. Missing IDs, duplicate IDs, unmatched calls, or orphan results fail the check. Ordinary `video_analysis.py` calls and `run.py` retain static processing by default and do not require these records. The ordinary runner's three-second tone fixture does not verify spoken narration and does not request native agentic processing.

Video `--execution auto` selects synchronous Interactions for both static and agentic processing (`background=False`, `store=False`). A separate real three-second agentic canary completed on 2026-09-07 with two valid processing call/result pairs and confirmed upload deletion; its unstored interaction ID was absent. The same canary's background job returned HTTP 400 `Unsupported file uri` during get/cancel, so its terminal state could not be confirmed. `--execution background` remains explicit for providers with working background file support; this helper does not retry automatically using a different route or model.

The agentic canary exposed a content error: its source contains a continuous 440 Hz tone, but Gemini reported an invented spoken English sentence about AI summarization. The valid processing pairs demonstrate execution of native agentic processing, not correctness of the answer or a passed listening review. This result must not be used as evidence that narration fidelity or final-film quality passed. A later explicit `get(include_input=False)` diagnostic also returned HTTP 400; the faulty background canary upload remains pending cleanup because no terminal state was confirmed. Local receipts are `/private/tmp/oma-auto-story/agentic-canary-sync.evidence.json`, `agentic-canary-sync.md`, `agentic-canary.evidence.json`, and `agentic-canary-cleanup-check.json` in the same directory.

`--processing-timeout` defaults to 180 seconds for file activation; `--interaction-timeout` defaults to 600 seconds per interaction. Explicit background execution polls until terminal completion. On timeout or an interrupted polling request, cleanup attempts cancellation when a job ID is known and waits up to another 30 seconds for terminal status before deleting the upload. API requests also have bounded transport timeouts. If submission or cancellation cannot be confirmed, the helper exits unsuccessfully and retains the upload with its name and any known interaction ID for follow-up cleanup. A get/cancel HTTP 400 after a successful submission does not prove the job is terminal and does not authorize automatic file deletion.

The pinned SDK gives Interactions a separate implicit retry policy. The helper
disables it with `client.interactions.sdk_configuration.retry_config = None`:
an ambiguous submission reaches recovery immediately instead of repeating a
paid POST. Setting `HttpOptions.retry_options.attempts=1` alone does not disable
this policy in version 2.22.0. Real SDK transport tests intercept all requests
offline and require exactly one POST for both HTTP 503 and read timeout, in
sync and background modes. Files retain their own policy; explicit reads of
known jobs continue to work.

Each CLI prints one JSON result and exits zero only when `ok` is true. This flag verifies execution, required processing evidence, and upload cleanup; the review itself may still identify quality problems requiring edits.

| Artifact / field | Contract |
| --- | --- |
| `audio-review.md` | Actual audio listening review; `.transcript.md` contains the independent transcript |
| `video-review.md` | Actual video review, retained even if native agentic evidence is insufficient |
| `*.evidence.json` | Input path, SHA-256, duration, interaction model/status/IDs, sanitized processing IDs, and final result; excludes signed media URIs and signatures |
| `ok`, `upload_deleted` | Both must be true for a successful run; API errors are reported as safe names/codes |
| `http_status`, `provider_reason` | HTTP status supports both SDK error families; the optional diagnostic contains only a sanitized provider message, excluding URLs, credential values, and other response fields |
| `processing_pair_count` | Verified pair count in video results; must be positive in agentic mode |
| `reference_compared` | Whether a reference script was supplied to the audio workflow; only a successful completed review verifies that the comparison ran |
| `cleanup_pending` | Upload was retained; use `pending_upload_name` and any `pending_interaction_id` to inspect the job before deleting its file |

Validation uses offline fake clients and the pinned SDK's real serialization types; it makes no paid API requests:

```bash
PYTHONDONTWRITEBYTECODE=1 /tmp/auto-story-e2e-venv/bin/python -m unittest discover \
  -s deploy/auto-story/e2e -p 'test_*.py' -v
```

The tests cover independent audio inputs, reference isolation, WAV MIME normalization, completed unstored responses, source-file protection, valid and malformed processing pairs, terminal failures, response-model mismatches, timeouts, cancellation, ambiguous submissions, cleanup failures, real SDK HTTP errors with redacted diagnostics, and compatibility with `google-genai==2.22.0`.

## Verified run

On 2026-09-07 the complete runner passed with the local credentials and the pinned SDK. All four MediaKit checks, all three VFS checks, and Gemini analysis and file deletion returned `true`. The Gemini answer described the red background, white shape and continuous tone across the full three seconds. Generated artifacts and live credentials are not stored in the repository.
