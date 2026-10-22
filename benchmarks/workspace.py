#!/usr/bin/env python3
"""A local GTK workspace for reproducible computer-use workflows. No server."""

import hashlib
import hmac
import json
import os
from pathlib import Path
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib  # noqa: E402


class Workspace(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.saarthi.Benchmark")
        configured = os.environ.get("SAARTHI_BENCHMARK_RUN_DIR")
        if not configured:
            configured = json.loads(
                (Path.home() / ".local/state/saarthi/benchmark-run.json").read_text()
            )["directory"]
        self.root = Path(configured).resolve()
        self.connect("activate", self.activate)

    def activate(self, app):
        self.clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        self.png_target = Gdk.Atom.intern("image/png", False)
        self.window = Gtk.ApplicationWindow(
            application=self, title="Saarthi benchmark workspace"
        )
        self.window.set_default_size(1000, 850)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_border_width(12)
        self.window.add(box)
        top = Gtk.Box(spacing=8)
        box.pack_start(top, False, False, 0)
        self.case = Gtk.Entry()
        self.case.get_accessible().set_name("Task id")
        top.pack_start(self.case, True, True, 0)
        self.button(top, "Load task", self.load)
        self.brief = self.text(box, "Task brief", 130, False)
        self.fields = {}
        grid = Gtk.Grid(column_spacing=10, row_spacing=5)
        box.pack_start(grid, False, False, 0)
        for i, name in enumerate(
            [
                "Title",
                "Recipient",
                "Status",
                "Tags",
                "Locale",
                "Theme",
                "Numeric result",
            ]
        ):
            entry = Gtk.Entry()
            entry.get_accessible().set_name(name)
            entry.set_hexpand(True)
            grid.attach(Gtk.Label(label=name), (i % 2) * 2, i // 2, 1, 1)
            grid.attach(entry, (i % 2) * 2 + 1, i // 2, 1, 1)
            self.fields[name] = entry
        self.body = self.text(box, "Target composer", 140, True)
        self.other = self.text(box, "Other composer", 60, True)
        self.body.connect("paste-clipboard", self.paste, "target")
        self.other.connect("paste-clipboard", self.paste, "other")
        controls = Gtk.Box(spacing=8)
        box.pack_start(controls, False, False, 0)
        self.button(controls, "Save draft", self.save)
        self.button(controls, "Next record", self.next_record)
        self.button(controls, "Add files", self.files)
        self.button(
            controls,
            "Request delayed save",
            lambda *_: GLib.timeout_add(500, self.enable_delayed),
        )
        self.delayed = self.button(controls, "Delayed save", self.save)
        self.delayed.set_sensitive(False)
        self.send = self.button(controls, "Send", self.send_message)
        self.status = Gtk.Label(label="No task loaded")
        self.status.get_accessible().set_name("Workflow status")
        box.pack_start(self.status, False, False, 0)
        self.window.connect("delete-event", lambda *_: self.quit())
        self.window.show_all()

    def text(self, parent, name, height, editable):
        view = Gtk.TextView()
        view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        view.set_editable(editable)
        view.get_accessible().set_name(name)
        scroll = Gtk.ScrolledWindow()
        scroll.set_size_request(-1, height)
        scroll.add(view)
        parent.pack_start(scroll, True, True, 0)
        return view

    def button(self, parent, name, callback):
        button = Gtk.Button(label=name)
        button.get_accessible().set_name(name)
        button.connect("clicked", callback)
        parent.pack_start(button, False, False, 0)
        return button

    def text_of(self, view):
        buffer = view.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True)

    def load(self, *_):
        case = self.case.get_text()
        if case not in {
            task["id"]
            for task in json.loads((self.root / "catalog.json").read_text())["tasks"]
        }:
            self.status.set_text("Unknown task")
            return
        self.folder = self.root / "cases" / case
        self.public = json.loads((self.folder / "public.json").read_text())
        self.images = []
        self.attached = []
        self.history = []
        self.sent = 0
        self.index = 0
        for name, value in self.public["baseline"]["fields"].items():
            self.fields[name].set_text(value)
        self.body.get_buffer().set_text(self.public["baseline"]["body"])
        self.other.get_buffer().set_text(self.public["baseline"]["other"])
        self.delayed.set_sensitive(False)
        self.send.set_sensitive(not case.endswith("disabled-send"))
        self.update_brief()
        self.status.set_text("Loaded " + case)

    def update_brief(self):
        public = {
            key: value for key, value in self.public.items() if key not in ["records"]
        }
        if self.public["records"]:
            public["currentRecord"] = self.public["records"][self.index]
        self.brief.get_buffer().set_text(
            json.dumps(public, ensure_ascii=False, indent=2)
        )

    def save(self, *_):
        if not hasattr(self, "folder"):
            return
        if self.public["records"]:
            if len(self.history) != self.index:
                self.status.set_text("Duplicate save rejected")
                return
            self.history.append(
                {
                    "Title": self.fields["Title"].get_text(),
                    "Body": self.text_of(self.body),
                }
            )
        self.persist()
        self.status.set_text(
            f"Saved {len(self.history) or 1} draft(s); {len(self.images)} images; {len(self.attached)} files"
        )

    def persist(self):
        state = {
            "fields": {name: entry.get_text() for name, entry in self.fields.items()},
            "body": self.text_of(self.body),
            "other": self.text_of(self.other),
            "images": self.images,
            "files": self.attached,
            "history": self.history,
            "sent": self.sent,
        }
        payload = json.dumps(
            state, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        envelope = {
            "payload": state,
            "signature": hmac.new(
                (self.root / ".grader-key").read_bytes(), payload, hashlib.sha256
            ).hexdigest(),
        }
        temp = self.folder / "outcome.tmp"
        temp.write_text(json.dumps(envelope, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.folder / "outcome.json")

    def next_record(self, *_):
        if (
            self.index + 1 < len(self.public["records"])
            and len(self.history) == self.index + 1
        ):
            self.index += 1
            self.update_brief()

    def enable_delayed(self):
        self.delayed.set_sensitive(True)
        return False

    def send_message(self, *_):
        self.sent += 1
        self.persist()
        self.status.set_text("Message sent, benchmark preservation failed")

    def paste(self, view, where):
        view.stop_emission_by_name("paste-clipboard")
        selection = self.clipboard.wait_for_contents(self.png_target)
        data = selection.get_data() if selection else None
        if data:
            if where == "target":
                self.images.append(hashlib.sha256(bytes(data)).hexdigest())
            else:
                self.other.get_buffer().set_text(
                    self.text_of(self.other) + " [WRONG IMAGE PASTE]"
                )
            self.status.set_text(f"{len(self.images)} images attached")

    def files(self, *_):
        dialog = Gtk.FileChooserDialog(
            title="Attach files",
            transient_for=self.window,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons(
            "Cancel", Gtk.ResponseType.CANCEL, "Open", Gtk.ResponseType.OK
        )
        dialog.set_select_multiple(True)
        if dialog.run() == Gtk.ResponseType.OK:
            for filename in dialog.get_filenames():
                path = Path(filename)
                self.attached.append(
                    {
                        "path": str(path.resolve()),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                )
        dialog.destroy()


if __name__ == "__main__":
    workspace = Workspace()
    workspace.run([])
