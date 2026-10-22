#!/usr/bin/env python3
"""Resolve one current accessible element and act, with JSON through stdin."""

import json
import sys
import subprocess
import time
from types import SimpleNamespace
from atspi_query import Atspi, collect, states_of


def perform(request):
    if request["action"] not in ("focus", "invoke", "set-text", "read-text", "inspect"):
        raise RuntimeError("Unsupported accessibility action")
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    candidates = []
    visited = [0, False]
    budget = [100]
    args = SimpleNamespace(
        mode="find",
        role=request.get("role"),
        name=request["name"],
        interactive=False,
        include_offscreen=False,
        max_depth=40,
        max_children=256,
        max_visited=20000,
        window_bounds=request["bounds"],
        window_title=request["windowTitle"],
    )
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None or app.get_process_id() != request["pid"]:
            continue
        elements = []
        collect(app, args, elements, budget, visited)
        for element in elements:
            if element["name"] != request["name"]:
                continue
            bounds = request["bounds"]
            if not (
                element.get("x", -1) >= bounds["x"]
                and element.get("y", -1) >= bounds["y"]
                and element.get("x", -1) + element.get("w", 0)
                <= bounds["x"] + bounds["width"]
                and element.get("y", -1) + element.get("h", 0)
                <= bounds["y"] + bounds["height"]
            ):
                continue
            candidates.append((app, element))
    if len(candidates) != 1 or visited[1] or budget[0] <= 0:
        raise RuntimeError(
            "Accessibility selector must resolve exactly one current on-screen element"
        )
    app, element = candidates[0]
    node = app
    for index in element["path"]:
        node = node.get_child_at_index(index)
    if node.get_name() != request["name"]:
        raise RuntimeError("Accessibility element changed before action")
    active = subprocess.run(
        ["hyprctl", "-j", "activewindow"], capture_output=True, text=True, timeout=3
    )
    if (
        active.returncode != 0
        or json.loads(active.stdout).get("address") != request["windowId"]
    ):
        raise RuntimeError("Window focus changed before accessibility action")
    states = states_of(node)
    if (
        "stale" in states
        or "defunct" in states
        or "enabled" not in states
        or "showing" not in states
    ):
        raise RuntimeError("Accessibility element is not actionable")
    action = request["action"]
    if request.get("requireFocusedEditable") and not all(
        state in states for state in ("focused", "editable", "enabled")
    ):
        raise RuntimeError("Destination is not a focused editable field")
    verified = False
    text = None
    if action == "inspect":
        verified = True
    elif action == "focus":
        if not Atspi.Component.grab_focus(node):
            raise RuntimeError("Element refused focus")
        deadline = time.monotonic() + 0.75
        while True:
            node.clear_cache()
            verified = "focused" in states_of(node)
            if verified or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        if not verified:
            raise RuntimeError("Element focus verification failed")
    elif action == "set-text":
        if "editable" not in states or node.get_role_name() == "password text":
            raise RuntimeError("Element does not expose verifiable editable text")
        value = request.get("text")
        if not isinstance(value, str) or not node.set_text_contents(value):
            raise RuntimeError("Element refused text")
        verified = Atspi.Text.get_text(node, 0, -1) == value
        if not verified:
            raise RuntimeError("Text verification failed")
    elif action == "read-text":
        if node.get_role_name() == "password text":
            raise RuntimeError("Password readback is not supported")
        text = Atspi.Text.get_text(node, 0, -1)
        verified = True
    else:
        interface = node.get_action_iface()
        if interface is None:
            raise RuntimeError("Element exposes no accessibility actions")
        names = [
            Atspi.Action.get_action_name(node, i)
            for i in range(Atspi.Action.get_n_actions(node))
        ]
        preferred = request.get("actionName")
        indexes = (
            [i for i, name in enumerate(names) if name == preferred]
            if preferred
            else [
                i
                for i, name in enumerate(names)
                if name in ("click", "press", "activate", "toggle")
            ]
        )
        if len(indexes) != 1 or not Atspi.Action.do_action(node, indexes[0]):
            raise RuntimeError(
                "Element action is ambiguous or was refused; specify an advertised action name"
            )
    return {
        "ok": True,
        "action": action,
        "element": element,
        "verified": verified,
        "verificationRequired": not verified,
        **({"text": text} if text is not None else {}),
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise RuntimeError("Action input is too large")
        request = json.loads(raw)
        if "steps" in request:
            results = []
            try:
                for step in request["steps"]:
                    results.append(perform({**request, **step}))
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "steps": results,
                            "stepCount": len(results),
                            "verificationRequired": any(
                                result["verificationRequired"] for result in results
                            ),
                        }
                    )
                )
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "error": str(error),
                            "completedSteps": len(results),
                            "steps": results,
                        }
                    )
                )
                sys.exit(1)
        else:
            print(json.dumps(perform(request)))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
