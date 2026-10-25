#!/usr/bin/python3 -I
"""Offline acceptance checks of oma-media; run as `user` with a clean environment.

oma-base's own smoke runs beside this one: the media layer must keep the
platform contract.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

IDENTITY = json.loads(Path("/opt/oma/images/oma-media.json").read_text())
ENCODERS = ["libopenh264", "libx264", "libx265", "libvpx-vp9", "libaom-av1", "libmp3lame", "libopus",
            "libvorbis", "libwebp", "aac"]
FILTERS = ["subtitles", "ass", "drawtext"]
CHECKS = []


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(argv, *, cwd=None, timeout=120, text=True):
    env = {"HOME": "/home/user", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=text, timeout=timeout,
                            check=False, stdin=subprocess.DEVNULL)
    if result.returncode != 0:
        output = result.stdout + result.stderr if text else (result.stdout + result.stderr).decode(errors="replace")
        raise RuntimeError(f"{argv[0]} exited {result.returncode}: {output[-2000:]}")
    return result.stdout


def check(name, operation):
    try:
        CHECKS.append({"name": name, "ok": True, "details": operation()})
    except Exception as error:  # noqa: BLE001 - every failure is reported
        CHECKS.append({"name": name, "ok": False, "error": str(error)})


def build():
    found = {}
    for binary in ("ffmpeg", "ffprobe"):
        first = run([binary, "-version"]).splitlines()[0]
        match = re.match(rf"{binary} version (\S+)", first)
        require(match and match.group(1) == IDENTITY["ffmpeg"], f"{binary}: {first}")
        missing = [line.strip() for line in run(["ldd", f"/usr/local/bin/{binary}"]).splitlines() if "not found" in line]
        require(not missing, f"{binary} lacks runtime libraries: {missing}")
        found[binary] = match.group(1)
    encoders = run(["ffmpeg", "-hide_banner", "-encoders"])
    absent = [name for name in ENCODERS if not re.search(rf"^\s*\S+\s+{re.escape(name)}\s", encoders, re.M)]
    require(not absent, f"Missing encoders: {absent}")
    filters = run(["ffmpeg", "-hide_banner", "-filters"])
    absent = [name for name in FILTERS if not re.search(rf"^\s*\S+\s+{re.escape(name)}\s", filters, re.M)]
    require(not absent, f"Missing filters: {absent}")
    return {**found, "encoders": ENCODERS, "filters": FILTERS}


def probe(path):
    data = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = [s for s in data["streams"] if s["codec_type"] == "audio"]
    return {"video": video["codec_name"], "audio": audio[0]["codec_name"] if audio else None,
            "size": [video["width"], video["height"]], "duration": round(float(data["format"]["duration"]), 2)}


def encode(directory, encoder):
    target = Path(directory) / f"{encoder}.mp4"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
         "-c:v", encoder, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(target)])
    details = probe(target)
    require(details["video"] == "h264" and details["audio"] == "aac", f"{encoder}: {details}")
    require(details["size"] == [320, 240] and abs(details["duration"] - 2) <= 0.3, f"{encoder}: {details}")
    return details


def frame(path, at="0.5"):
    return run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", at, "-i", str(path), "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "gray", "-"], text=False)


def subtitles(directory):
    """libass renders CJK text with the bundled Noto CJK font, from SRT and ASS."""
    root = Path(directory)
    source = root / "plain.mp4"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "color=c=black:size=320x240:rate=10:duration=1", "-c:v", "libopenh264", "-pix_fmt", "yuv420p",
         str(source)])
    (root / "cjk.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n中文字幕测试 smoke\n", encoding="utf-8")
    (root / "cjk.ass").write_text(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\n"
        "Style: Default,Noto Sans CJK SC,28,&H00FFFFFF,2\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,样式字幕\n", encoding="utf-8")
    plain = frame(source)
    results = {}
    for name, expression in (("srt", "subtitles=cjk.srt:force_style='FontName=Noto Sans CJK SC'"), ("ass", "ass=cjk.ass")):
        target = root / f"{name}.mp4"
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source.name, "-vf", expression,
             "-c:v", "libopenh264", "-pix_fmt", "yuv420p", target.name], cwd=root)
        rendered = frame(target)
        lit = sum(1 for value in rendered if value > 128)
        require(len(rendered) == len(plain) and lit > 50, f"{name}: subtitle not rendered ({lit} lit pixels)")
        results[name] = {"litPixels": lit, **probe(target)}
    return results


def fonts():
    match = run(["fc-match", "-f", "%{family}|%{file}", "Noto Sans CJK SC"])
    require("Noto Sans CJK" in match and "NotoSansCJK" in match, f"CJK font: {match}")
    chinese = [line for line in run(["fc-list", ":lang=zh", "family"]).splitlines() if line.strip()]
    require(chinese, "No font covers zh")
    dejavu = run(["fc-match", "-f", "%{file}", "DejaVu Sans"])
    require("DejaVuSans" in dejavu, f"DejaVu: {dejavu}")
    return {"cjk": match.split("|", 1)[1], "zhFamilies": len(chinese), "dejavu": dejavu}


def main():
    check("ffmpeg_build", build)
    with tempfile.TemporaryDirectory(prefix="oma-media-smoke-") as directory:
        check("encode_libopenh264", lambda: encode(directory, "libopenh264"))
        check("encode_libx264", lambda: encode(directory, "libx264"))
        check("subtitles_libass_cjk", lambda: subtitles(directory))
    check("fonts", fonts)
    require_home = [path for path in Path("/home/user").iterdir() if path.name not in {".bashrc", ".profile", ".bash_logout"}]
    CHECKS.append({"name": "home_untouched", "ok": not require_home, "details": [str(p) for p in require_home]})
    ok = all(item["ok"] for item in CHECKS)
    print(json.dumps({"image": IDENTITY, "ok": ok, "checks": CHECKS}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
