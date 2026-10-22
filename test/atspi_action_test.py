"""Semantic actions fail closed and verify writes without a real desktop."""

import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import atspi_query_test

query = atspi_query_test.query
sys.modules["atspi_query"] = query
spec = importlib.util.spec_from_file_location(
    "action", Path(__file__).resolve().parents[1] / "scripts/atspi_action.py"
)
action = importlib.util.module_from_spec(spec)
spec.loader.exec_module(action)


class SemanticTests(unittest.TestCase):
    def setUp(self):
        self.node = atspi_query_test.Node(
            "Editor", states=("visible", "showing", "enabled", "editable", "focused")
        )
        self.node.get_role_name = lambda: "text"
        self.node.clear_cache = lambda: None
        self.node.value = ""

        def write(value):
            self.node.value = value
            return True

        self.node.set_text_contents = write
        self.node.get_action_iface = lambda: object()
        self.app = atspi_query_test.Node("App", children=[self.node])
        self.app.get_process_id = lambda: 42
        self.desktop = atspi_query_test.Node(children=[self.app])
        self.request = dict(
            windowId="0x1",
            pid=42,
            windowTitle="Workspace",
            bounds=dict(x=0, y=0, width=800, height=600),
            name="Editor",
            action="set-text",
            text="नमस्ते\n$()",
        )
        self.element = dict(name="Editor", path=[0], x=10, y=20, w=100, h=40)
        self.patches = [
            patch.object(action.Atspi, "get_desktop", return_value=self.desktop),
            patch.object(
                action,
                "collect",
                side_effect=lambda app, args, out, *rest: out.append(self.element),
            ),
            patch.object(
                action.subprocess,
                "run",
                return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps({"address": "0x1"})
                ),
            ),
            patch.object(
                action.Atspi,
                "Text",
                SimpleNamespace(get_text=lambda node, start, end: node.value),
                create=True,
            ),
            patch.object(
                action.Atspi,
                "Component",
                SimpleNamespace(grab_focus=lambda node: True),
                create=True,
            ),
            patch.object(
                action.Atspi,
                "Action",
                SimpleNamespace(
                    get_n_actions=lambda node: 1,
                    get_action_name=lambda node, i: "click",
                    do_action=lambda node, i: True,
                ),
                create=True,
            ),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()

    def test_exact_write_is_read_back(self):
        self.assertTrue(action.perform(self.request)["verified"])
        self.assertEqual(
            action.perform({**self.request, "action": "read-text"})["text"],
            self.request["text"],
        )

    def test_readback_mismatch_fails(self):
        self.node.set_text_contents = lambda value: True
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            action.perform(self.request)

    def test_focus_drift_prevents_write(self):
        action.subprocess.run.return_value.stdout = json.dumps({"address": "0x2"})
        with self.assertRaisesRegex(RuntimeError, "focus changed"):
            action.perform(self.request)
        self.assertEqual(self.node.value, "")

    def test_disabled_stale_password_and_unfocused_destinations_fail(self):
        for states in [
            ("visible", "showing"),
            ("visible", "showing", "enabled", "stale"),
        ]:
            self.node.states = states
            with self.assertRaises(RuntimeError):
                action.perform(self.request)
        self.node.states = ("visible", "showing", "enabled", "editable")
        with self.assertRaisesRegex(RuntimeError, "focused editable"):
            action.perform(
                {**self.request, "action": "inspect", "requireFocusedEditable": True}
            )
        self.node.get_role_name = lambda: "password text"
        with self.assertRaisesRegex(RuntimeError, "Password"):
            action.perform({**self.request, "action": "read-text"})

    def test_ambiguous_selector_and_action_refusal_fail(self):
        action.collect.side_effect = lambda app, args, out, *rest: out.extend(
            [self.element, self.element]
        )
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            action.perform(self.request)
        action.collect.side_effect = lambda app, args, out, *rest: out.append(
            self.element
        )
        action.Atspi.Action.do_action = lambda node, i: False
        with self.assertRaisesRegex(RuntimeError, "refused"):
            action.perform({**self.request, "action": "invoke"})


if __name__ == "__main__":
    unittest.main()
