#!/usr/bin/env python3
"""Generate harmless canary media, then run real MediaKit, VFS and Gemini checks."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def generate(output):
    video, audio, image = [output / name for name in ("canary.mp4", "canary.wav", "canary.png")]
    # A red field, white box and 440 Hz tone have no private content.
    commands = [
        ["ffmpeg", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=3:r=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-vf", "drawbox=x=100:y=70:w=120:h=100:color=white:t=fill", "-c:v", "libx264", "-g", "1", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(video)],
        ["ffmpeg", "-i", str(video), "-vn", "-c:a", "pcm_s16le", str(audio)],
        ["ffmpeg", "-i", str(video), "-frames:v", "1", str(image)],
    ]
    for command in commands:
        subprocess.run(command[:1] + ["-hide_banner", "-loglevel", "error", "-y"] + command[1:], capture_output=True, check=True, timeout=60)
    return video, audio, image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="Artifacts directory; defaults to a fresh temporary directory")
    parser.add_argument("--local-only", action="store_true", help="Skip all authenticated network checks")
    parser.add_argument("--gemini-model", help="Override the current documented default or GEMINI_VIDEO_MODEL")
    args = parser.parse_args()
    output = args.output_dir.resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix="auto-story-e2e-"))
    output.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).resolve().parent
    try:
        video, audio, image = generate(output)
    except Exception as error:
        print(json.dumps({"ok": False, "fixture_error": type(error).__name__}))
        return 1
    commands = {"mediakit": [sys.executable, str(scripts / "mediakit.py"), "--video", str(video), "--audio", str(audio), "--image", str(image), "--output-dir", str(output / "mediakit")]}
    if not args.local_only:
        commands["mediakit"].append("--cloud")
        commands["vfs"] = [sys.executable, str(scripts / "vfs.py")]
        commands["video_analysis"] = [sys.executable, str(scripts / "video_analysis.py"), "--video", str(video), "--output", str(output / "video-analysis.md")]
        if args.gemini_model:
            commands["video_analysis"].extend(["--model", args.gemini_model])

    def run(item):
        name, command = item
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=450)
            data = json.loads(result.stdout)
            if result.returncode:
                data["ok"] = False
            return name, data
        except Exception as error:
            return name, {"ok": False, "error": type(error).__name__}

    with ThreadPoolExecutor(max_workers=3) as executor:
        checks = dict(executor.map(run, commands.items()))
    report = {"ok": all(result["ok"] for result in checks.values()), "scope": "local" if args.local_only else "authenticated", "checks": checks, "artifacts": {"video": str(video), "audio": str(audio), "image": str(image)}}
    report_path = output / "report.json"
    report["report"] = str(report_path)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
