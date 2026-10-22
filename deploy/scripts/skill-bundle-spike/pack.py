# Deterministic Skill bundle packer for the #261 spike (the production packer is
# separate work). Reads {"out": dir, "bundles": [{"files": [{"path", "mode", "b64"}]}]}
# from stdin and writes <out>/<index>.zip with Unix modes in the external
# attributes, explicit directory entries, fixed timestamps and UTF-8 names.
import base64, json, os, sys, zipfile

EPOCH = (1980, 1, 1, 0, 0, 0)

def entry(name, mode):
    info = zipfile.ZipInfo(name, EPOCH)
    info.create_system = 3  # Unix, so unzip honours the mode bits
    info.external_attr = mode << 16
    if name.endswith("/"): info.external_attr |= 0x10  # MS-DOS directory flag
    else: info.compress_type = zipfile.ZIP_DEFLATED
    return info

manifest = json.load(sys.stdin)
for index, bundle in enumerate(manifest["bundles"]):
    files = sorted(bundle["files"], key=lambda f: f["path"])
    dirs = sorted({"/".join(f["path"].split("/")[:i]) + "/" for f in files for i in range(1, f["path"].count("/") + 1)})
    with zipfile.ZipFile(os.path.join(manifest["out"], f"{index}.zip"), "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in dirs: archive.writestr(entry(name, 0o040755), b"")
        for f in files: archive.writestr(entry(f["path"], 0o100000 | f["mode"]), base64.b64decode(f["b64"]))
print(json.dumps({"bundles": len(manifest["bundles"])}))
