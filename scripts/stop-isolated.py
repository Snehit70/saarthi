"""Signal only verified private-session processes through stable Linux pidfds."""
import json
import os
import signal
import sys

request = json.load(sys.stdin)
desktop_id = request["desktopId"]
runtime = request["runtime"]
if len(desktop_id) != 16 or any(c not in "0123456789abcdef" for c in desktop_id):
    raise ValueError("Invalid desktop id")
if runtime != f"/run/user/{os.getuid()}/saarthi-isolated/{desktop_id}":
    raise ValueError("Invalid private runtime")
sig = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL}[request["signal"]]
sent = 0
for identity in request["processes"]:
    pid = identity["pid"]
    if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        continue
    fd = None
    try:
        fd = os.pidfd_open(pid)
        if os.stat(f"/proc/{pid}").st_uid != os.getuid():
            continue
        with open(f"/proc/{pid}/stat", encoding="utf-8") as source:
            data = source.read()
        fields = data[data.rfind(")") + 2:].split()
        if fields[19] != identity["startTime"]:
            continue
        with open(f"/proc/{pid}/environ", "rb") as source:
            env = source.read().split(b"\0")
        if f"SAARTHI_DESKTOP_ID={desktop_id}".encode() not in env or f"XDG_RUNTIME_DIR={runtime}".encode() not in env:
            continue
        signal.pidfd_send_signal(fd, sig)
        sent += 1
    except (ProcessLookupError, FileNotFoundError, PermissionError):
        pass
    finally:
        if fd is not None:
            os.close(fd)
print(json.dumps({"signalled": sent}))
