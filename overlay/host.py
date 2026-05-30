#!/usr/bin/env python3
"""saarthi overlay host.

Renders overlay/index.html inside a transparent, click-through, always-on-top
WebKit2GTK surface anchored to the top-right via wlr-layer-shell. Watches
~/.local/state/saarthi/status.json and pushes each update into the page through
window.saarthiUpdate(). The window appears while saarthi is active and fades out
shortly after it goes idle.

Stack (all present on Fedora + Hyprland with zero extra installs):
  GTK 3 · GtkLayerShell 0.1 · WebKit2 4.1 · PyGObject

Run:  python3 overlay/host.py          (live, follows status.json)
      python3 overlay/host.py --demo    (built-in animation, no saarthi needed)
"""

import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, GtkLayerShell, WebKit2  # noqa: E402

try:
    import cairo  # for click-through input region
except Exception:  # pragma: no cover
    cairo = None

HERE = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.path.join(HERE, "index.html")
STATUS_PATH = os.path.join(
    GLib.get_user_state_dir(), "saarthi", "status.json"
)  # ~/.local/state/saarthi/status.json

IDLE_LINGER_MS = 3500  # keep visible this long after going idle
TOP_MARGIN = 14
RIGHT_MARGIN = 14


class Overlay:
    def __init__(self, demo: bool = False):
        self.demo = demo
        self.ready = False
        self.hide_source = None

        self.win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.win.set_decorated(False)
        self.win.set_resizable(False)
        self.win.set_app_paintable(True)
        self.win.set_default_size(330, 280)

        # transparent visual
        screen = self.win.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.win.set_visual(visual)

        self._init_layer_shell()

        # webview
        self.web = WebKit2.WebView()
        self.web.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        s = self.web.get_settings()
        s.set_property("enable-write-console-messages-to-stdout", True)
        s.set_property("enable-developer-extras", True)
        uri = "file://" + HTML_PATH + ("?demo=1" if demo else "")
        self.web.load_uri(uri)
        self.web.connect("load-changed", self._on_load)
        self.win.add(self.web)

        self.win.connect("realize", self._on_realize)
        self.win.connect("destroy", Gtk.main_quit)

        if not demo:
            self._watch_status()

    def _init_layer_shell(self):
        try:
            GtkLayerShell.init_for_window(self.win)
            GtkLayerShell.set_namespace(self.win, "saarthi-overlay")
            GtkLayerShell.set_layer(self.win, GtkLayerShell.Layer.OVERLAY)
            GtkLayerShell.set_anchor(self.win, GtkLayerShell.Edge.TOP, True)
            GtkLayerShell.set_anchor(self.win, GtkLayerShell.Edge.RIGHT, True)
            GtkLayerShell.set_margin(self.win, GtkLayerShell.Edge.TOP, TOP_MARGIN)
            GtkLayerShell.set_margin(self.win, GtkLayerShell.Edge.RIGHT, RIGHT_MARGIN)
            # never grab keyboard focus
            GtkLayerShell.set_keyboard_mode(self.win, GtkLayerShell.KeyboardMode.NONE)
        except Exception as e:
            print(f"[saarthi-overlay] layer-shell unavailable, normal window: {e}",
                  file=sys.stderr)

    def _on_realize(self, _widget):
        self._make_click_through()

    def _make_click_through(self):
        """Empty input region => pointer events pass through to apps below."""
        if cairo is None:
            return
        gdkwin = self.win.get_window()
        if gdkwin is None:
            return
        try:
            gdkwin.input_shape_combine_region(cairo.Region(), 0, 0)
        except Exception:
            pass

    def _on_load(self, _web, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.ready = True
            if not self.demo:
                self._push(self._read_status())  # initial state

    # ── status following ────────────────────────────────────────────
    def _watch_status(self):
        try:
            os.makedirs(os.path.dirname(STATUS_PATH), exist_ok=True)
        except Exception:
            pass
        gfile = Gio.File.new_for_path(STATUS_PATH)
        self.monitor = gfile.monitor_file(Gio.FileMonitorFlags.NONE, None)
        self.monitor.set_rate_limit(40)
        self.monitor.connect("changed", self._on_status_changed)

    def _on_status_changed(self, _mon, _f, _o, event):
        if event in (
            Gio.FileMonitorEvent.CHANGES_DONE_HINT,
            Gio.FileMonitorEvent.CREATED,
            Gio.FileMonitorEvent.CHANGED,
        ):
            self._push(self._read_status())

    def _read_status(self):
        try:
            with open(STATUS_PATH, "r", encoding="utf-8") as fh:
                return fh.read()
        except FileNotFoundError:
            return None
        except Exception:
            return None

    # ── show / hide / push ──────────────────────────────────────────
    def _push(self, raw):
        if raw is None:
            return
        try:
            snap = json.loads(raw)
        except Exception:
            return

        if snap.get("state") == "active":
            self._cancel_hide()
            self._show()
        else:
            self._schedule_hide()

        if self.ready:
            js = "window.saarthiUpdate && window.saarthiUpdate(%s)" % json.dumps(raw)
            # evaluate_javascript (WebKit 2.40+) supersedes the deprecated
            # run_javascript; fall back on older WebKit2GTK builds.
            if hasattr(self.web, "evaluate_javascript"):
                self.web.evaluate_javascript(js, -1, None, None, None, None, None)
            else:
                self.web.run_javascript(js, None, None, None)

    def _show(self):
        if not self.win.get_visible():
            self.win.show_all()
            self._make_click_through()

    def _schedule_hide(self):
        self._cancel_hide()
        self.hide_source = GLib.timeout_add(IDLE_LINGER_MS, self._do_hide)

    def _cancel_hide(self):
        if self.hide_source is not None:
            GLib.source_remove(self.hide_source)
            self.hide_source = None

    def _do_hide(self):
        self.hide_source = None
        self.win.hide()
        return False

    def run(self):
        # demo mode shows immediately; live mode waits for the first active push
        if self.demo:
            self.win.show_all()
            self._make_click_through()
        Gtk.main()


def main():
    demo = "--demo" in sys.argv
    Overlay(demo=demo).run()


if __name__ == "__main__":
    main()
