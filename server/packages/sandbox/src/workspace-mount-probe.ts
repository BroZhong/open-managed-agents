/**
 * Runs as uid 1000. Open directory descriptors prevent an unmount from
 * redirecting the check into a local fallback. The probe is kept only until
 * Host OSS readback proves the mounted bucket/prefix, then removed separately.
 * Interrupted checks can leave objects only in the reserved control area.
 */
export const WORKSPACE_MOUNT_PROBE = String.raw`
import json, os, re, sys, uuid

def unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match.group(1), 8)), value)

def check():
    mount_path = sys.argv[1]
    if os.geteuid() != 1000 or os.getegid() != 1000:
        raise RuntimeError()
    real_path = os.path.realpath(mount_path)
    if not re.fullmatch(r'/run/csi/mount-root/oss/[a-f0-9]{32}', real_path):
        raise RuntimeError()
    records = []
    with open('/proc/self/mountinfo') as mounts:
        for line in mounts:
            before, after = line.rstrip().split(' - ', 1)
            fields, volume = before.split(), after.split()
            if unescape(fields[4]) == real_path:
                records.append((fields, volume))
    if len(records) != 1:
        raise RuntimeError()
    fields, volume = records[0]
    if volume[0] != 'fuse.ossfs' or 'rw' not in fields[5].split(','):
        raise RuntimeError()
    root = os.open(real_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        device = os.fstat(root).st_dev
        if fields[2] != str(os.major(device)) + ':' + str(os.minor(device)):
            raise RuntimeError()
        try:
            os.mkdir('.oma-workspace-checks', mode=0o700, dir_fd=root)
        except FileExistsError:
            pass
        control = os.open('.oma-workspace-checks', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            if os.fstat(control).st_dev != device:
                raise RuntimeError()
            name = uuid.uuid4().hex
            created, complete = False, False
            try:
                fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600, dir_fd=control)
                created = True
                content = uuid.uuid4().hex + uuid.uuid4().hex
                with os.fdopen(fd, 'wb') as output:
                    output.write(content.encode('ascii'))
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=control)
                with os.fdopen(fd, 'rb') as source_file:
                    if source_file.read() != content.encode('ascii'):
                        raise RuntimeError()
                print(json.dumps({'probeName': name, 'content': content, 'realPath': real_path}))
                complete = True
            finally:
                if created and not complete:
                    os.unlink(name, dir_fd=control)
        finally:
            os.close(control)
    finally:
        os.close(root)

try:
    check()
except BaseException:
    sys.exit(1)
`;

/** Cleanup never resolves the user-writable Workspace symlink a second time. */
export const WORKSPACE_MOUNT_PROBE_CLEANUP = String.raw`
import os, re, sys
try:
    real_path, name = sys.argv[1:]
    if not re.fullmatch(r'/run/csi/mount-root/oss/[a-f0-9]{32}', real_path) or not re.fullmatch(r'[a-f0-9]{32}', name):
        raise RuntimeError()
    root = os.open(real_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        control = os.open('.oma-workspace-checks', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            os.unlink(name, dir_fd=control)
        finally:
            os.close(control)
    finally:
        os.close(root)
    print('OMA_WORKSPACE_PROBE_REMOVED')
except BaseException:
    sys.exit(1)
`;
