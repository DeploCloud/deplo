#!/usr/bin/python3
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import syslog
import time

PROJECTS = Path("/root/projects")
SERVERS = Path("/root/.vscode-server/cli/servers")
MIN_AGE = 24 * 60 * 60
RELEASE = re.compile(r"deplo-live-(\d+)")
PREVIOUS = re.compile(r"\.next\.prev-\d+")
VERSION = re.compile(r"Stable-[0-9a-f]{40}")


def directories(root, pattern):
    return [
        p for p in root.iterdir()
        if pattern.fullmatch(p.name) and p.is_dir() and not p.is_symlink()
        and p.resolve() == p
    ]


def candidates(projects=PROJECTS, servers=SERVERS, now=None):
    now = time.time() if now is None else now
    current = projects / "deplo-live-current"
    if not current.is_symlink():
        raise RuntimeError("Missing active release symlink; refusing cleanup")
    active = current.resolve(strict=True)
    if active.parent != projects or not RELEASE.fullmatch(active.name):
        raise RuntimeError("Active release is outside the expected directory")
    active_number = int(RELEASE.fullmatch(active.name)[1])
    previous = [
        p for p in directories(projects, RELEASE)
        if int(RELEASE.fullmatch(p.name)[1]) < active_number
    ]
    previous.sort(key=lambda p: int(RELEASE.fullmatch(p.name)[1]))
    selected = previous[:-1]
    for project in projects.iterdir():
        if project.is_dir() and not project.is_symlink() and project.resolve() == project:
            selected.extend(directories(project, PREVIOUS))
    if servers.is_dir() and servers.resolve() == servers:
        versions = sorted(directories(servers, VERSION), key=lambda p: p.stat().st_mtime)
        selected.extend(versions[:-2])
    return [
        p for p in selected
        if now - max(p.stat().st_mtime, p.stat().st_ctime) >= MIN_AGE
    ]


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30)


def live_references(projects=PROJECTS):
    paths = []
    texts = []
    for process in Path("/proc").glob("[0-9]*"):
        try:
            for entry in [process / "cwd", process / "exe", *process.joinpath("fd").iterdir()]:
                try:
                    paths.append(Path(os.readlink(entry).removesuffix(" (deleted)")))
                except OSError as error:
                    if error.errno not in (errno.ENOENT, errno.ESRCH, errno.EINVAL):
                        raise
            texts.append(process.joinpath("cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"))
            for line in process.joinpath("maps").read_text().splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) == 6 and fields[5].startswith("/"):
                    paths.append(Path(fields[5].removesuffix(" (deleted)")))
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ESRCH):
                raise
    ids = command("docker", "ps", "-aq").split()
    mounts = []
    if ids:
        for container in json.loads(command("docker", "inspect", *ids)):
            mounts.extend(Path(m["Source"]) for m in container["Mounts"])
    mounted = json.loads(command("findmnt", "--json", "--list", "--output", "TARGET"))
    paths.extend(Path(m["target"]) for m in mounted["filesystems"])
    paths.extend(Path(p) for p in command("losetup", "-ln", "-O", "BACK-FILE").splitlines() if p)
    for project in projects.iterdir():
        if project.is_symlink():
            paths.append(project.resolve())
        elif project.is_dir():
            paths.extend(p.resolve() for p in project.iterdir() if p.is_symlink())
    for root, pattern in [
        (Path("/etc/systemd/system"), "*.service"),
        (Path("/etc/systemd/system"), "*.service.d/*.conf"),
        (Path("/etc/cron.d"), "*"),
    ]:
        for path in root.glob(pattern):
            if path.is_file():
                texts.append(path.read_text())
    return paths, texts, mounts


def protected(path, paths, texts, mounts):
    if any(p == path or path in p.parents for p in paths):
        return True
    if any(p == path or path in p.parents or p in path.parents for p in mounts):
        return True
    if any(str(path) in text for text in texts):
        return True
    if VERSION.fullmatch(path.name):
        version = path.name.removeprefix("Stable-")
        return any(version in text for text in texts)
    return False


def emit(message, error=False):
    print(message, flush=True)
    syslog.syslog(syslog.LOG_ERR if error else syslog.LOG_INFO, message)


def cleanup(dry_run=False):
    before = shutil.disk_usage("/").free
    removed = 0
    for path in candidates():
        identity = path.stat()
        paths, texts, mounts = live_references()
        if protected(path, paths, texts, mounts):
            emit(f"Keep referenced directory: {path}")
            continue
        if path not in candidates() or path.is_symlink() or path.resolve() != path:
            emit(f"Keep changed directory: {path}")
            continue
        current = path.stat()
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise RuntimeError(f"Directory changed during cleanup: {path}")
        if dry_run:
            emit(f"Would remove: {path}")
        else:
            shutil.rmtree(path)
            emit(f"Removed: {path}")
            removed += 1
    freed = max(0, shutil.disk_usage("/").free - before)
    emit(f"Completed: dry_run={dry_run}, removed={removed}, freed_bytes={freed}")


def main():
    parser = argparse.ArgumentParser(description="Clean obsolete development artifacts on Main")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    syslog.openlog("deplo-main-host-cleanup", facility=syslog.LOG_DAEMON)
    if os.geteuid() != 0:
        parser.error("Run as root")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("This Python lacks symlink-safe directory removal")
    with open("/run/lock/deplo-main-host-cleanup.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit("Skipped: another cleanup is running")
            return
        cleanup(args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(f"Failed: {error}", error=True)
        raise SystemExit(1)
