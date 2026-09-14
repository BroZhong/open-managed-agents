#!/usr/bin/env python3
"""Run real representative MediaKit operations without exposing cloud credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def command(args, env):
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("command_failed_exit_" + str(result.returncode))
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--cloud", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, MEDIAKIT_SURFACE="skill", MEDIAKIT_RUNTIME="pi-agent")
    checks = {}
    artifacts = {}

    def check(name, operation):
        try:
            operation()
            checks[name] = {"ok": True}
        except Exception as error:
            # Remote error bodies may include signed URLs or account data.
            checks[name] = {"ok": False, "error": type(error).__name__}
            if type(error) is RuntimeError:
                checks[name]["reason"] = str(error)

    def invoke(mode, domain, tool, flags):
        prefix = ["mediakit-cli", mode, domain, tool]
        contract = command(prefix + ["--schema"], env)
        if "input_schema" not in contract:
            raise RuntimeError("missing_input_schema")
        discovery = subprocess.run(prefix + ["--help"], env=env, capture_output=True, timeout=30)
        if discovery.returncode:
            raise RuntimeError("help_failed")
        return command(prefix + flags, env)

    def probe_video():
        data = invoke("--local", "video", "probe-video-metadata", ["--video-url", str(args.video.resolve())])
        if not data.get("video_stream_meta") or not data.get("audio_stream_meta"):
            raise RuntimeError("missing_video_or_audio")

    def probe_audio():
        data = invoke("--local", "audio", "probe-audio-metadata", ["--audio-url", str(args.audio.resolve())])
        if not data.get("audio_stream_meta"):
            raise RuntimeError("missing_audio")

    def trim():
        output = args.output_dir.resolve() / "trimmed.mp4"
        data = invoke("--local", "editing", "trim-video", ["--video-url", str(args.video.resolve()), "--start-time", "0.5", "--end-time", "2", "--output-path", str(output)])
        actual = Path(data.get("video_url", ""))
        if not actual.is_file() or actual.stat().st_size == 0:
            raise RuntimeError("missing_trimmed_output")
        probe = command(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(actual)], env)
        if not 1.3 <= float(probe["format"]["duration"]) <= 1.8:
            raise RuntimeError("wrong_trimmed_duration")
        if not any(stream["codec_type"] == "audio" for stream in probe["streams"]):
            raise RuntimeError("trim_lost_audio")
        artifacts["trimmed_video"] = str(actual.resolve())

    def image_cloud():
        if not env.get("MEDIAKIT_API_KEY"):
            raise RuntimeError("missing_MEDIAKIT_API_KEY")
        if args.image is None:
            raise RuntimeError("missing_image")
        data = invoke("--cloud", "image", "probe-image-metadata", ["--image-url", str(args.image.resolve())])
        if data.get("width") != 320 or data.get("height") != 240:
            raise RuntimeError("unexpected_image_dimensions")

    check("video_local_probe", probe_video)
    check("audio_local_probe", probe_audio)
    check("editing_local_trim", trim)
    if args.cloud:
        check("image_cloud_probe", image_cloud)
    else:
        checks["image_cloud_probe"] = {"ok": None, "skipped": "pass_--cloud_to_test"}
    ok = all(value["ok"] is True for value in checks.values() if "skipped" not in value)
    print(json.dumps({"ok": ok, "checks": checks, "artifacts": artifacts}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
