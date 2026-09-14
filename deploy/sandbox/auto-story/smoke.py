#!/opt/auto-story/venv/bin/python
"""Offline image acceptance checks; run as user with a clean environment."""

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import wave


EXPECTED = {
    "vfs-cli": "0.3.15",
    "mediakit-cli": "0.2.1",
    "ffmpeg": "9.0.1",
    "ffprobe": "9.0.1",
    "google-genai": "2.22.0",
    "rg": "15.1.0",
    "fd": "10.4.2",
}
WORKSPACE = Path("/home/user")
CHECKS = []


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(argv, *, cwd=None, env=None, mediakit=False, timeout=90, expected_code=0):
    env = os.environ.copy() if env is None else dict(env)
    if mediakit:
        env.update(MEDIAKIT_SURFACE="skill", MEDIAKIT_RUNTIME="codex")
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != expected_code:
        raise RuntimeError(
            f"{argv[0]} exited {result.returncode}: "
            f"{(result.stdout + result.stderr)[-4000:]}"
        )
    return result.stdout


def check(name, operation):
    try:
        details = operation()
    except Exception as error:
        CHECKS.append({"name": name, "ok": False, "error": str(error)})
        return None
    CHECKS.append({"name": name, "ok": True, "details": details})
    return details


def binary_versions():
    required_binaries = [name for name in EXPECTED if name != "google-genai"] + ["python3", "node"]
    for executable in required_binaries:
        require(shutil.which(executable) is not None, f"Missing executable: {executable}")
    versions = {}
    payload = json.loads(run(["vfs-cli", "version", "--format", "json"], timeout=20))
    require(payload.get("ok") is True, "vfs-cli version did not report ok=true")
    data = payload["data"]
    versions["vfs-cli"] = data["version"].removeprefix("v")
    require(data.get("platform") == "linux/amd64", "vfs-cli must be linux/amd64")
    for binary, flag in (("mediakit-cli", "--version"), ("ffmpeg", "-version"), ("ffprobe", "-version"), ("rg", "--version"), ("fd", "--version")):
        output = run([binary, flag], mediakit=binary == "mediakit-cli", timeout=20)
        match = re.search(r"(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])", output)
        require(match is not None, f"Cannot parse {binary} version: {output[:300]}")
        versions[binary] = match.group(1)
    for binary, version in versions.items():
        require(version == EXPECTED[binary], f"{binary}: expected {EXPECTED[binary]}, got {version}")
    return versions


def gemini_sdk():
    version = importlib.metadata.version("google-genai")
    require(version == EXPECTED["google-genai"], f"google-genai: expected {EXPECTED['google-genai']}, got {version}")
    require(Path(sys.prefix) == Path("/opt/auto-story/venv"), f"Wrong Python environment: {sys.prefix}")
    from google import genai

    client = genai.Client(api_key="offline-smoke-test-not-a-real-key")
    api_shape = {"files": ("upload", "get", "list", "delete", "download"), "interactions": ("create", "get", "delete")}
    try:
        for service, methods in api_shape.items():
            resource = getattr(client, service)
            for method in methods:
                require(callable(getattr(resource, method, None)), f"Missing client.{service}.{method}")
    finally:
        client.close()
    return {"version": version, "api": api_shape, "network_calls": 0}


def python_entrypoint():
    # Match the installed scientific packages in the pinned ACS environment;
    # do not assume every base image contains both numpy and pandas.
    env = {"HOME": str(WORKSPACE), "PATH": "/usr/local/bin:/usr/bin:/bin"}
    base_program = """
import importlib
import importlib.util
import json
names = [name for name in ('numpy', 'pandas') if importlib.util.find_spec(name)]
print(json.dumps({name: importlib.import_module(name).__version__ for name in names}))
"""
    base_science = json.loads(run(["/opt/venv/bin/python3", "-I", "-c", base_program], env=env, timeout=30))
    program = """
import importlib
import importlib.metadata
import json
import sys
from google import genai
names = json.loads(sys.argv[1])
print(json.dumps({
    'prefix': sys.prefix,
    'google-genai': importlib.metadata.version('google-genai'),
    'base_science': {name: importlib.import_module(name).__version__ for name in names},
}))
"""
    result = json.loads(run(["python3", "-I", "-c", program, json.dumps(list(base_science))], env=env, timeout=30))
    require(result["prefix"] == "/opt/auto-story/venv", "Minimal PATH python3 selected the wrong venv")
    require(result["google-genai"] == EXPECTED["google-genai"], "Minimal PATH python3 selected the wrong Gemini SDK")
    require(result["base_science"] == base_science, "Minimal PATH python3 cannot import the base scientific packages unchanged")
    return result


def excluded_software():
    def excluded(name):
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        return "openmontage" in normalized.replace("-", "") or "whisper" in normalized

    found = set()
    for binary in ("openmontage", "OpenMontage", "open-montage", "whisper", "whisperx", "whisper-cli", "faster-whisper"):
        location = shutil.which(binary)
        if location:
            found.add(location)

    # Inspect the clean SDK venv and the retained Jupyter/system environments.
    package_roots = {Path(path) for path in sys.path if path and Path(path).is_dir()}
    for root in (Path("/opt"), Path("/usr/local/lib"), Path("/usr/lib")):
        if root.exists():
            package_roots.update(root.glob("**/site-packages"))
            package_roots.update(root.glob("**/dist-packages"))
    for root in package_roots:
        for distribution in importlib.metadata.distributions(path=[str(root)]):
            name = distribution.metadata.get("Name", "")
            if excluded(name):
                found.add(f"distribution:{name}@{root}")
        for item in root.iterdir():
            if excluded(item.name):
                found.add(str(item))
    # Source trees can remain even when their executable/distribution is absent.
    for root in (Path("/opt"), Path("/app"), WORKSPACE):
        if not root.exists():
            continue
        for current, directories, _ in os.walk(root):
            for name in directories:
                if excluded(name):
                    found.add(str(Path(current) / name))
            directories[:] = [name for name in directories if name not in {"site-packages", "dist-packages", ".cache", ".git"}]
    require(not found, "Excluded software remains: " + ", ".join(sorted(found)))
    return {"openmontage": "absent", "whisper": "absent"}


def verify_vfs_audio_contract(workspace, cli="vfs-cli"):
    # Even in a live Session, previews get no real credentials or endpoint.
    # No references are resolved and no upload or paid generation is submitted.
    with tempfile.TemporaryDirectory(prefix=".auto-story-audio-contract-", dir=workspace) as temp:
        env = {
            "HOME": temp,
            "PATH": os.environ["PATH"],
            "VFS_TOKEN": "offline-smoke-placeholder",
            "VFS_PIXEL_DIRECTOR_URL": "https://offline.invalid",
        }
        skills = json.loads(run([cli, "skills", "list"], env=env, cwd=temp))
        require(skills.get("ok") is True, "Embedded VFS Skill discovery failed")
        schema = json.loads(run([
            cli, "schema", "generate", "audio", "--model", "seed-audio-1.0",
        ], env=env, cwd=temp))
        model = schema["data"]["model_schema"]
        require(schema["ok"] is True and model["medium"] == "audio", "Missing VFS audio model schema")
        require(model["model"] == "seed-audio-1.0" and model["endpoint"] == "audio_gen_sse", "Unexpected audio model endpoint")
        require(model["fixed_fields"]["enable_subtitle"] is True, "Audio subtitles must be enabled")
        refs = model["references"]["audio"]
        require(refs["resource_types"] == ["audio"], "Unexpected audio reference types")
        require(refs["max_total"] == 3 and refs["max_duration_seconds"] == 30, "Unexpected audio reference limits")

        prompt = "风从窗外吹来。"
        preview = json.loads(run([
            cli, "generate", "audio", "--model", "seed-audio-1.0", "--prompt", prompt, "--dry-run",
        ], env=env, cwd=temp, expected_code=10))
        require(preview["ok"] is True and preview["dry_run"] is True, "Audio generation dry-run failed")
        request = preview["request_preview"]
        require(request["endpoint"] == "audio_gen_sse", "Unexpected audio generation endpoint")
        require(request["body"] == {"model": "seed-audio-1.0", "prompt": prompt}, "Unexpected audio generation payload")

        resource_schema = json.loads(run([cli, "schema", "resource", "create"], env=env, cwd=temp))
        flags = resource_schema["data"]["commands"][0]["flags"]
        require("audio" in next(flag["enum"] for flag in flags if flag["name"] == "type"), "Resource schema does not support audio")
        audio = Path(temp) / "voice with spaces.wav"
        with wave.open(str(audio), "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            output.writeframes(b"\0\0" * 16000)
        for source in (("--url", "https://offline.invalid/voice.wav"), ("--file", audio.name)):
            preview = json.loads(run([
                cli, "resource", "create", "--type", "audio", *source, "--dry-run",
            ], env=env, cwd=temp, expected_code=10))
            require(preview["ok"] is True and preview["dry_run"] is True, "Audio Resource dry-run failed")
            require("register_audio" in preview["effects"], "Audio Resource registration effect missing")
            if source[0] == "--file":
                require("upload_to_oss" in preview["effects"], "Local audio upload effect missing")
                require(preview["request_previews"][0]["type"] == "audio", "Local audio upload has wrong type")
    return {"embedded_skills": True, "audio_schema": True, "generation_dry_run": True, "resource_url_and_file_dry_run": True}


def verify_native_search(workspace):
    """Exercise the exact rg/fd syntax used by Pi, without network I/O."""
    with tempfile.TemporaryDirectory(prefix=".auto-story-search-", dir=workspace) as temp:
        root = Path(temp)
        (root / ".git").mkdir()
        (root / "src").mkdir()
        (root / "ignored").mkdir()
        (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        names = ("root.ts", ".hidden.ts", "src/child.ts", "src/script.js")
        for name in (*names, "ignored/secret.ts"):
            (root / name).write_text("故事 hello\n", encoding="utf-8")
        events = [json.loads(line) for line in run([
            "rg", "--json", "--line-number", "--color=never", "--hidden",
            "--glob", "*.{ts,js}", "--", r"\p{L}+", str(root),
        ], cwd=temp).splitlines()]
        matches = {
            Path(event["data"]["path"]["text"]).relative_to(root).as_posix()
            for event in events if event["type"] == "match"
        }
        require(matches == set(names), "ripgrep Unicode/glob/gitignore check failed")
        found = {Path(line).relative_to(root).as_posix() for line in run([
            "fd", "--glob", "--color=never", "--hidden", "--max-results", "1000",
            "--", "*.ts", str(root),
        ], cwd=temp).splitlines()}
        require(found == {"root.ts", ".hidden.ts", "src/child.ts"}, "fd recursive basename/gitignore check failed")
        found = run([
            "fd", "--glob", "--color=never", "--hidden", "--full-path",
            "--", "**/src/?hild.ts", str(root),
        ], cwd=temp).splitlines()
        require(found == [str(root / "src/child.ts")], "fd path glob check failed")
    return {"rg": run(["rg", "--version"]).splitlines()[0], "fd": run(["fd", "--version"]).strip()}


def probe(path, expected_duration):
    require(path.is_file() and path.stat().st_size > 0, f"Missing or empty output: {path.name}")
    data = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=20))
    videos = [stream for stream in data["streams"] if stream.get("codec_type") == "video"]
    audios = [stream for stream in data["streams"] if stream.get("codec_type") == "audio"]
    require(bool(videos), f"{path.name}: no video stream")
    require(bool(audios), f"{path.name}: no audio stream")
    require((videos[0].get("width"), videos[0].get("height")) == (320, 240), f"{path.name}: unexpected dimensions")
    duration = float(data["format"]["duration"])
    require(abs(duration - expected_duration) <= 0.3, f"{path.name}: expected about {expected_duration}s, got {duration}s")
    return {"duration_seconds": duration, "width": 320, "height": 240, "video_codec": videos[0]["codec_name"], "audio_codec": audios[0]["codec_name"]}


def create_video(directory):
    target = directory / "input.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-shortest", "-movflags", "+faststart", str(target),
    ])
    details = probe(target, 2)
    require(details["video_codec"] == "h264" and details["audio_codec"] == "aac", "Expected H.264/AAC encoding")
    return details


def subtitle_burn(directory):
    filters = run(["ffmpeg", "-hide_banner", "-filters"], timeout=20)
    if re.search(r"\bsubtitles\s+V->V", filters):
        (directory / "smoke.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nsmoke test\n", encoding="utf-8")
        filter_name, expression = "subtitles", "subtitles=smoke.srt"
    else:
        require(bool(re.search(r"\bdrawtext\s+V->V", filters)), "FFmpeg has neither subtitles nor drawtext filter")
        filter_name, expression = "drawtext", "drawtext=text='smoke test':fontcolor=white:fontsize=20:x=10:y=10"
    target = directory / "burned.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", "input.mp4",
        "-vf", expression, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(target),
    ], cwd=directory)
    return {"filter": filter_name, **probe(target, 1)}


def mediakit_operation(directory, operation):
    input_path = directory / "input.mp4"
    trimmed = directory / "trimmed.mp4"
    outputs = {"trim": trimmed, "concat": directory / "concatenated.mp4", "subtitle": directory / "mediakit-subtitle.mp4"}
    commands = {
        "trim": ["trim-video", "--video-url", str(input_path), "--start-time", "0", "--end-time", "1"],
        "concat": ["concat-video", "--video-urls", f"{trimmed},{trimmed}"],
        "subtitle": ["add-subtitle-to-video", "--video-url", str(input_path), "--subtitles", json.dumps([{"subtitle_text": "smoke test", "start_time": 0, "end_time": 1}])],
    }
    require(input_path.exists(), "Input video generation failed")
    if operation == "concat":
        require(trimmed.exists(), "MediaKit trim did not produce an input for concat")
    run(["mediakit-cli", "--local", "editing", *commands[operation], "--output-path", str(outputs[operation])], mediakit=True, timeout=120)
    # Stream-copy trimming can retain frames around a GOP boundary. Concat
    # must preserve both actual inputs, including that timestamp padding.
    expected_duration = 1 if operation == "trim" else 2
    if operation == "concat":
        expected_duration = 2 * probe(trimmed, 1)["duration_seconds"]
    return probe(outputs[operation], expected_duration)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-env", action="append", default=[], metavar="NAME", help="Require a nonempty environment variable without printing its value; repeatable")
    args = parser.parse_args()

    def required_environment():
        missing = [name for name in args.require_env if not os.environ.get(name, "").strip()]
        require(not missing, "Missing required environment variables: " + ", ".join(missing))
        return {"present": args.require_env}

    check("required_environment", required_environment)
    check("binary_versions", binary_versions)
    check("gemini_sdk", gemini_sdk)
    check("minimal_path_python_and_base_science", python_entrypoint)
    check("excluded_software", excluded_software)

    try:
        require(os.geteuid() != 0, "Run the acceptance test as the non-root user")
        require(os.environ.get("HOME") == str(WORKSPACE), "HOME must be /home/user")
        with tempfile.TemporaryDirectory(prefix="auto-story-smoke-", dir=WORKSPACE) as temporary:
            directory = Path(temporary)
            marker = directory / "writable.txt"
            marker.write_text("workspace writable\n", encoding="utf-8")
            require(marker.read_text(encoding="utf-8") == "workspace writable\n", "Workspace read/write check failed")
            CHECKS.append({"name": "workspace", "ok": True, "details": {"root": str(WORKSPACE), "uid": os.geteuid()}})
            check("native_search", lambda: verify_native_search(directory))
            check("vfs_audio_contract_and_embedded_skills", lambda: verify_vfs_audio_contract(directory))
            check("ffmpeg_encode", lambda: create_video(directory))
            check("ffmpeg_subtitle_burn", lambda: subtitle_burn(directory))
            for operation in ("trim", "concat", "subtitle"):
                check(f"mediakit_local_{operation}", lambda operation=operation: mediakit_operation(directory, operation))
        require(not directory.exists(), "Temporary files were not cleaned up")
    except Exception as error:
        CHECKS.append({"name": "workspace_and_cleanup", "ok": False, "error": str(error)})

    ok = all(item["ok"] for item in CHECKS)
    print(json.dumps({"ok": ok, "checks": CHECKS}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
