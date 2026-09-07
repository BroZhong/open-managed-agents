#!/usr/bin/env python3
"""Check embedded VFS skills and authenticated read access; never emit account records."""
import json
import os
import subprocess
import sys


def main():
    checks = {}
    commands = {
        "embedded_skill": ["vfs-cli", "skills", "read", "vfs-cli"],
        "generation_contract": ["vfs-cli", "schema", "generate", "video", "--model", "seedance-2.0"],
        "authenticated_read": ["vfs-cli", "teamwork", "query", "--format", "json", "--timeout", "30s"],
    }
    for name, command in commands.items():
        if name == "authenticated_read" and not os.environ.get("VFS_TOKEN"):
            checks[name] = {"ok": False, "error": "missing_VFS_TOKEN"}
            continue
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=45)
            ok = result.returncode == 0 and bool(result.stdout.strip())
            if name == "authenticated_read" and ok:
                ok = json.loads(result.stdout).get("ok") is True
            checks[name] = {"ok": ok}
            if not ok:
                checks[name]["error"] = "command_failed_exit_" + str(result.returncode)
        except Exception as error:
            checks[name] = {"ok": False, "error": type(error).__name__}
    ok = all(value["ok"] for value in checks.values())
    print(json.dumps({"ok": ok, "checks": checks}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
