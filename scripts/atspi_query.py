#!/usr/bin/env python3
"""Query the AT-SPI accessibility tree and emit JSON.

Used by saarthi's ui_tree / ui_find tools to get structured, addressable UI
elements (roles, names, screen-coordinate extents) instead of guessing from
OCR. Coverage is toolkit-dependent: GTK/Qt apps expose well; Chromium/Electron
and Firefox expose their content tree only when launched with accessibility
enabled.

Output (stdout): {"ok": true, "apps": [...], "elements": [...], "count", "truncated"}
On failure: {"ok": false, "error": "..."} with a non-zero exit code.
"""

import argparse
import json
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")  # keep stdout pure JSON (a11y bindings warn on stderr)

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

INTERACTIVE_ROLES = {
    "push button", "toggle button", "check box", "radio button", "menu item",
    "check menu item", "radio menu item", "link", "entry", "text", "password text",
    "combo box", "list item", "tab", "page tab", "slider", "spin button",
    "icon", "table cell", "tree item", "button",
}

USEFUL_STATES = {
    "focused", "focusable", "sensitive", "enabled", "visible", "showing",
    "selected", "checked", "expanded", "editable",
}


def focused_pid():
    try:
        out = subprocess.run(
            ["hyprctl", "-j", "activewindow"], capture_output=True, text=True, timeout=3
        )
        return json.loads(out.stdout).get("pid")
    except Exception:
        return None


def states_of(node):
    try:
        ss = node.get_state_set()
        return sorted(s for s in USEFUL_STATES if ss.contains(getattr(Atspi.StateType, s.upper().replace(" ", "_"), -1)))
    except Exception:
        return []


def actions_of(node):
    try:
        ai = node.get_action_iface()
        if ai is None:
            return []
        return [Atspi.Action.get_action_name(node, i) for i in range(Atspi.Action.get_n_actions(node))]
    except Exception:
        return []


def extents_of(node):
    try:
        e = node.get_extents(Atspi.CoordType.SCREEN)
        return (int(e.x), int(e.y), int(e.width), int(e.height))
    except Exception:
        return None


def collect(app, args, out, budget):
    """Depth-first walk of one application, appending matching elements to out."""

    def visit(node, depth, path):
        if budget[0] <= 0 or depth > args.max_depth:
            return
        try:
            role = node.get_role_name()
            name = node.get_name() or ""
        except Exception:
            return

        ext = extents_of(node)
        onscreen = ext is not None and ext[2] > 0 and ext[3] > 0
        match = True
        if args.interactive and role not in INTERACTIVE_ROLES:
            match = False
        if args.role and role != args.role:
            match = False
        if args.name and args.name.lower() not in name.lower():
            match = False
        if not args.include_offscreen and not onscreen:
            if args.mode == "find":
                match = False

        if match and not (args.mode == "find" and not name and not args.role):
            elem = {"role": role, "name": name, "depth": depth, "path": path}
            if ext:
                elem.update(x=ext[0], y=ext[1], w=ext[2], h=ext[3],
                            cx=ext[0] + ext[2] // 2, cy=ext[1] + ext[3] // 2)
            elem["states"] = states_of(node)
            acts = actions_of(node)
            if acts:
                elem["actions"] = acts
            out.append(elem)
            budget[0] -= 1

        try:
            n = node.get_child_count()
        except Exception:
            n = 0
        for i in range(min(n, args.max_children)):
            try:
                child = node.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                visit(child, depth + 1, path + [i])

    visit(app, 0, [])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["tree", "find"], default="find")
    p.add_argument("--pid", type=int)
    p.add_argument("--focused", action="store_true")
    p.add_argument("--app-name")
    p.add_argument("--role")
    p.add_argument("--name")
    p.add_argument("--interactive", action="store_true")
    p.add_argument("--include-offscreen", action="store_true")
    p.add_argument("--max-depth", type=int, default=14)
    p.add_argument("--max-children", type=int, default=64)
    p.add_argument("--max-nodes", type=int, default=400)
    args = p.parse_args()

    Atspi.init()
    desktop = Atspi.get_desktop(0)

    pid = args.pid
    if args.focused and pid is None:
        pid = focused_pid()

    apps_meta = []
    elements = []
    budget = [args.max_nodes]

    for i in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(i)
        except Exception:
            continue
        if app is None:
            continue
        try:
            app_name = app.get_name() or ""
            app_pid = app.get_process_id()
        except Exception:
            continue

        if pid is not None and app_pid != pid:
            continue
        if args.app_name and args.app_name.lower() not in app_name.lower():
            continue

        apps_meta.append({"name": app_name, "pid": app_pid, "children": app.get_child_count()})
        collect(app, args, elements, budget)
        if budget[0] <= 0:
            break

    print(json.dumps({
        "ok": True,
        "mode": args.mode,
        "apps": apps_meta,
        "elements": elements,
        "count": len(elements),
        "truncated": budget[0] <= 0,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # pragma: no cover
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
