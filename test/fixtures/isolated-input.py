"""Manual native input/file-picker verification inside an isolated desktop.

This is an input plumbing fixture, not an autonomous benchmark. Launch from a
private terminal. All evidence stays in that desktop's private runtime.
"""
import json
import os
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

desktop_id = os.environ.get("SAARTHI_DESKTOP_ID", "")
runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "/invalid"))
if runtime != Path(f"/run/user/{os.getuid()}/saarthi-isolated/{desktop_id}") or len(desktop_id) != 16:
    raise RuntimeError("Run this fixture only inside an isolated desktop")
state = {"text": "", "clicks": 0, "scrolls": 0, "presses": 0, "releases": 0, "motion": None, "files": []}
evidence = runtime / "input-verification.json"


def save():
    temporary = runtime / "input-verification.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(evidence)


window = Gtk.Window(title="Isolated native input verification")
window.set_default_size(600, 700)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
box.set_border_width(24)
window.add(box)
box.pack_start(Gtk.Label(label="Independent mouse and keyboard"), False, False, 0)
entry = Gtk.Entry()
entry.set_placeholder_text("Type verification text here")


def changed(widget):
    state["text"] = widget.get_text()
    save()


entry.connect("changed", changed)
box.pack_start(entry, False, False, 0)
button = Gtk.Button(label="Count click")


def clicked(_widget):
    state["clicks"] += 1
    button.set_label(f"Clicks: {state['clicks']}")
    save()


button.connect("clicked", clicked)
box.pack_start(button, False, False, 0)
area = Gtk.EventBox()
area.set_size_request(200, 180)
area.add(Gtk.Label(label="Move, drag and scroll here"))
area.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)


def event(_widget, value):
    if value.type == Gdk.EventType.MOTION_NOTIFY:
        state["motion"] = [round(value.x), round(value.y)]
    elif value.type == Gdk.EventType.BUTTON_PRESS:
        state["presses"] += 1
    elif value.type == Gdk.EventType.BUTTON_RELEASE:
        state["releases"] += 1
    elif value.type == Gdk.EventType.SCROLL:
        state["scrolls"] += 1
    save()
    return False


area.connect("event", event)
box.pack_start(area, True, True, 0)
choose = Gtk.Button(label="Choose a verification file")
selected = Gtk.Label(label="No file selected")
sample = runtime / "verification-file.txt"
sample.write_text("Explicit isolated file-picker payload", encoding="utf-8")
sample.chmod(0o600)


def pick(_widget):
    dialog = Gtk.FileChooserDialog(title="Choose an isolated verification file", transient_for=window, action=Gtk.FileChooserAction.OPEN)
    dialog.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_OPEN, Gtk.ResponseType.OK)
    dialog.set_current_folder(str(runtime))
    if dialog.run() == Gtk.ResponseType.OK:
        state["files"] = [Path(dialog.get_filename()).name]
        selected.set_text(", ".join(state["files"]))
        save()
    dialog.destroy()


choose.connect("clicked", pick)
box.pack_start(choose, False, False, 0)
box.pack_start(selected, False, False, 0)
window.show_all()
save()
Gtk.main()
