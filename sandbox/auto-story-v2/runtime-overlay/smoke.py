"""Additional checks; keep the inherited production smoke suite intact."""
import ast
import configparser
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import tempfile


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def media_python(directory):
    import ctypes
    import cv2
    import numpy as np
    from PIL import Image
    from fontTools.ttLib import TTFont
    from scenedetect import ContentDetector, detect

    ctypes.CDLL("libGL.so.1")
    versions = {name: importlib.metadata.version(name) for name in ("scenedetect", "Pillow", "fonttools")}
    require(versions["scenedetect"] == "0.7.1", "Expected scenedetect 0.7.1")
    for name, lower, upper in (("Pillow", (10, 4), (13, 0)), ("fonttools", (4, 50), (5, 0))):
        version = tuple(int(part) for part in versions[name].split(".")[:2])
        require(lower <= version < upper, f"{name}: unsupported version {versions[name]}")

    image_path = directory / "pillow.png"
    Image.new("RGB", (32, 24), (255, 0, 0)).save(image_path)
    with Image.open(image_path) as image:
        require(image.size == (32, 24) and image.getpixel((0, 0)) == (255, 0, 0), "Pillow PNG round-trip failed")
    with TTFont("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") as font:
        require(ord("A") in font.getBestCmap(), "fonttools could not read the system font cmap")

    video_path = directory / "scene-cut.avi"
    writer = cv2.VideoWriter(str(video_path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (64, 48))
    require(writer.isOpened(), "OpenCV could not open the scene fixture writer")
    try:
        for value in (0, 255):
            for _ in range(20):
                writer.write(np.full((48, 64, 3), value, dtype=np.uint8))
    finally:
        writer.release()
    scenes = detect(str(video_path), ContentDetector(threshold=10, min_scene_len=5))
    require(len(scenes) == 2 and scenes[0][1].frame_num == 20, "SceneDetect did not detect the known cut at frame 20")
    return {"versions": versions, "libGL": "loaded", "pillow": "PNG round-trip", "fonttools": "font cmap read", "scenedetect": "cut at frame 20"}


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='runtime-overlay-') as directory:
        result = media_python(Path(directory))
    config = configparser.ConfigParser()
    config.read('/etc/pip.conf')
    require(config['global']['index-url'] == 'https://mirrors.aliyun.com/pypi/simple/', 'pip mirror mismatch')
    effective = subprocess.check_output(['python3', '-m', 'pip', 'config', 'list'], text=True)
    entries = dict(line.split('=', 1) for line in effective.splitlines() if '=' in line)
    actual = ast.literal_eval(entries['global.index-url'])
    require(actual == config['global']['index-url'], 'effective pip mirror mismatch')
    for executable in ['python', 'python3']:
        subprocess.run([executable, '-I', '-c', 'import cv2, scenedetect; assert scenedetect.__version__ == "0.7.1"'], check=True)
    require(importlib.metadata.version('numpy') == '1.26.4', 'numpy changed')
    require(importlib.metadata.version('opencv-python') == '4.11.0.86', 'OpenCV changed')
    proxy = dict(line.split('=', 1) for line in Path('/etc/oma/proxy.env').read_text().splitlines() if line)
    require(proxy['HTTP_PROXY'] == proxy['HTTPS_PROXY'] == 'http://sing-box.oma-infra.svc.cluster.local:7890', 'proxy defaults mismatch')
    result.update(pipMirror=actual, proxyDefaults=proxy, proxyRuntimeInjection='requires new Sandbox acceptance')
    print(json.dumps(result))
