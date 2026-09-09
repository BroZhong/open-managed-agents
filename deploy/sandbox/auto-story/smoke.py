#!/usr/local/bin/python3
"""Offline image checks that exercise real CLIs and preserve only a JSON result.

Run this through a Pi bash tool as well to check the provisioned Environment
Spec. --require-env checks presence without disclosing any value. Cloud skill
acceptance is deliberately separate; these checks do not authenticate services.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave


def run(*args, env=None, cwd=None, expected_code=0):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90, env=env, cwd=cwd)
    if result.returncode != expected_code:
        # Service/CLI diagnostics may include request credentials. Report only
        # the failed executable and code; callers can investigate privately.
        raise RuntimeError(f"{Path(args[0]).name} exited {result.returncode}")
    return result.stdout


def verify_vfs_audio_contract(cli="vfs-cli"):
    # Even when invoked in a live Session, these previews use no real token or
    # endpoint. No references are resolved and no generation/upload is submitted.
    with tempfile.TemporaryDirectory(prefix=".auto-story-audio-contract-") as temp:
        env = {"HOME": temp, "PATH": os.environ["PATH"],
               "VFS_TOKEN": "offline-smoke-placeholder",
               "VFS_PIXEL_DIRECTOR_URL": "https://offline.invalid"}
        schema = json.loads(run(cli, "schema", "generate", "audio", "--model",
                                "seed-audio-1.0", env=env, cwd=temp))
        model = schema["data"]["model_schema"]
        assert schema["ok"] is True and model["medium"] == "audio"
        assert model["model"] == "seed-audio-1.0" and model["endpoint"] == "audio_gen_sse"
        assert model["fixed_fields"]["enable_subtitle"] is True
        refs = model["references"]["audio"]
        assert refs["resource_types"] == ["audio"]
        assert refs["max_total"] == 3 and refs["max_duration_seconds"] == 30

        prompt = "风从窗外吹来。"
        preview = json.loads(run(cli, "generate", "audio", "--model", "seed-audio-1.0",
                                 "--prompt", prompt, "--dry-run", env=env, cwd=temp,
                                 expected_code=10))
        assert preview["ok"] is True and preview["dry_run"] is True
        request = preview["request_preview"]
        assert request["endpoint"] == "audio_gen_sse"
        assert request["body"] == {"model": "seed-audio-1.0", "prompt": prompt}

        resource_schema = json.loads(run(cli, "schema", "resource", "create", env=env, cwd=temp))
        flags = resource_schema["data"]["commands"][0]["flags"]
        assert "audio" in next(flag["enum"] for flag in flags if flag["name"] == "type")
        audio = Path(temp) / "voice with spaces.wav"
        with wave.open(str(audio), "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            output.writeframes(b"\0\0" * 16000)
        for source in (("--url", "https://offline.invalid/voice.wav"), ("--file", audio.name)):
            preview = json.loads(run(cli, "resource", "create", "--type", "audio",
                                     *source, "--dry-run", env=env, cwd=temp, expected_code=10))
            assert preview["ok"] is True and preview["dry_run"] is True
            assert "register_audio" in preview["effects"]
            if source[0] == "--file":
                assert "upload_to_oss" in preview["effects"]
                assert preview["request_previews"][0]["type"] == "audio"


def verify_native_search(workspace):
    """Exercise the binaries and native syntax used by Pi, without network I/O."""
    with tempfile.TemporaryDirectory(prefix=".auto-story-search-", dir=workspace) as temp:
        root = Path(temp)
        (root / ".git").mkdir()
        (root / "src").mkdir()
        (root / "ignored").mkdir()
        (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        names = ("root.ts", ".hidden.ts", "src/child.ts", "src/script.js")
        for name in (*names, "ignored/secret.ts"):
            (root / name).write_text("故事 hello\n", encoding="utf-8")
        events = [json.loads(line) for line in run(
            "rg", "--json", "--line-number", "--color=never", "--hidden",
            "--glob", "*.{ts,js}", "--", r"\p{L}+", str(root), cwd=temp).splitlines()]
        matches = {Path(event["data"]["path"]["text"]).relative_to(root).as_posix()
                   for event in events if event["type"] == "match"}
        assert matches == set(names), "ripgrep Unicode/glob/gitignore check failed"
        found = {Path(line).relative_to(root).as_posix() for line in run(
            "fd", "--glob", "--color=never", "--hidden", "--max-results", "1000",
            "--", "*.ts", str(root), cwd=temp).splitlines()}
        assert found == {"root.ts", ".hidden.ts", "src/child.ts"}, "fd recursive basename/gitignore check failed"
        found = run("fd", "--glob", "--color=never", "--hidden", "--full-path",
                    "--", "**/src/?hild.ts", str(root), cwd=temp).splitlines()
        assert found == [str(root / "src/child.ts")], "fd path glob check failed"
    return {"rg": run("rg", "--version").splitlines()[0],
            "fd": run("fd", "--version").strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-env", action="append", default=[], metavar="NAME")
    args = parser.parse_args()
    required = ("vfs-cli", "mediakit-cli", "ffmpeg", "ffprobe", "python3", "node", "rg", "fd")
    for executable in required:
        if not shutil.which(executable):
            raise RuntimeError(f"missing executable: {executable}")
    for name in args.require_env:
        if not os.environ.get(name):
            raise RuntimeError(f"missing environment variable: {name}")

    from google import genai
    from importlib.metadata import version

    # SDK surface verification is offline and uses a synthetic non-secret key.
    with genai.Client(api_key="offline-smoke-placeholder") as client:
        assert callable(client.files.upload)
        assert callable(client.files.get)
        assert callable(client.files.delete)
        assert callable(client.interactions.create)

    workspace = Path(os.environ.get("WORKSPACE_DIR", "/home/user"))
    search_versions = verify_native_search(workspace)
    with tempfile.TemporaryDirectory(prefix=".auto-story-smoke-", dir=workspace) as temp:
        media = Path(temp) / "fixture with spaces.mp4"
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=red:s=160x90:r=5:d=1", "-f", "lavfi", "-i",
            "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(media))
        assert media.stat().st_size > 0, "ffmpeg did not create the fixture"
        probe = json.loads(run("ffprobe", "-v", "error", "-show_streams",
                               "-show_format", "-of", "json", str(media)))
        assert {stream["codec_type"] for stream in probe["streams"]} == {"video", "audio"}
        env = {**os.environ, "MEDIAKIT_SURFACE": "skill", "MEDIAKIT_RUNTIME": "pi-agent",
               "MEDIAKIT_OUTPUT_PATH": temp}
        metadata = json.loads(run("mediakit-cli", "--local", "video",
                                  "probe-video-metadata", "--video-url", str(media), env=env))
        assert metadata["video_stream_meta"]["width"] == 160
        assert metadata["video_stream_meta"]["height"] == 90
        assert metadata["audio_stream_meta"]["codec"] == "aac"
        assert 0.9 <= metadata["format_meta"]["duration"] <= 1.2

    vfs = json.loads(run("vfs-cli", "version"))
    assert vfs["ok"] is True
    run("vfs-cli", "skills", "list")
    verify_vfs_audio_contract()
    run("mediakit-cli", "--local", "video", "probe-video-metadata", "--schema")
    print(json.dumps({"ok": True, "vfs_cli": vfs["data"]["version"],
                      "mediakit_cli": run("mediakit-cli", "--version").strip(),
                      "google_genai": version("google-genai"),
                      "native_search": search_versions,
                      "checks": ["workspace_write", "ffmpeg_h264_aac", "ffprobe",
                                 "native_rg_unicode_glob_gitignore", "native_fd_recursive_and_path_glob",
                                 "mediakit_local_metadata", "vfs_embedded_skills",
                                 "vfs_audio_schema", "vfs_audio_generate_dry_run",
                                 "vfs_audio_resource_url_and_file_dry_run",
                                 "gemini_files_and_interactions_sdk"],
                      "environment_present": args.require_env}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Only our explicit diagnostics are safe to expose; third-party SDK
        # exceptions can contain URLs or environment-derived configuration.
        message = str(error) if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__
        print(json.dumps({"ok": False, "error": message}))
        raise SystemExit(1)
