"""AT-SPI traversal regressions without a running bus or GI installation."""

import argparse
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


gi = ModuleType("gi")
gi.require_version = lambda *args: None
repository = ModuleType("gi.repository")
repository.Atspi = SimpleNamespace(
    init=lambda: None,
    get_desktop=lambda index: None,
    CoordType=SimpleNamespace(SCREEN=0),
    StateType=SimpleNamespace(
        **{
            s.upper(): s
            for s in [
                "visible",
                "showing",
                "defunct",
                "stale",
                "focused",
                "focusable",
                "sensitive",
                "enabled",
                "selected",
                "checked",
                "expanded",
                "editable",
            ]
        }
    ),
)
with patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
    spec = importlib.util.spec_from_file_location(
        "atspi_query", Path(__file__).resolve().parents[1] / "scripts/atspi_query.py"
    )
    query = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(query)


class Node:
    def __init__(self, name="Button", states=("visible", "showing"), children=()):
        self.name, self.states, self.children = name, states, children
        self.child_reads = 0

    def get_role_name(self):
        return "push button"

    def get_name(self):
        return self.name

    def get_state_set(self):
        return SimpleNamespace(contains=lambda state: state in self.states)

    def get_extents(self, coord):
        return SimpleNamespace(x=10, y=20, width=100, height=40)

    def get_action_iface(self):
        return None

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        self.child_reads += 1
        return self.children[index]


def args(**overrides):
    defaults = dict(
        mode="find",
        max_depth=10,
        max_children=64,
        max_nodes=100,
        max_visited=1000,
        interactive=False,
        role=None,
        name=None,
        include_offscreen=False,
    )
    return argparse.Namespace(**{**defaults, **overrides})


class TraversalTests(unittest.TestCase):
    def test_wayland_frame_coordinates_translate_to_compositor_position(self):
        child = Node("Target")
        frame = Node("Workspace", children=[child])
        frame.get_role_name = lambda: "frame"
        frame.get_extents = lambda coord: SimpleNamespace(
            x=0, y=0, width=800, height=600
        )
        output = []
        query.collect(
            frame,
            args(
                name="Target",
                window_title="Workspace",
                window_bounds=dict(x=-800, y=40, width=800, height=600),
            ),
            output,
            [100],
        )
        self.assertEqual((output[0]["x"], output[0]["y"]), (-790, 60))

    def test_other_window_frame_is_not_traversed(self):
        frame = Node("Other", children=[Node("Target")])
        frame.get_role_name = lambda: "frame"
        output = []
        query.collect(
            frame,
            args(
                name="Target",
                window_title="Workspace",
                window_bounds=dict(x=50, y=40, width=800, height=600),
            ),
            output,
            [100],
        )
        self.assertEqual(output, [])
        self.assertEqual(frame.child_reads, 0)

    def test_unmatched_nodes_skip_component_rpcs(self):
        node = Node("Unrelated")
        node.get_extents = lambda coord: self.fail("Unmatched component RPC")
        node.get_state_set = lambda: self.fail("Unmatched state RPC")
        query.collect(node, args(name="Target"), [], [100])

    def test_requires_both_visibility_states_for_find_and_tree(self):
        for mode in ("find", "tree"):
            for states in ((), ("visible",), ("showing",)):
                output = []
                query.collect(Node(states=states), args(mode=mode), output, [100])
                self.assertEqual(output, [])
            output = []
            query.collect(Node(), args(mode=mode), output, [100])
            self.assertEqual(output[0]["cx"], 60)

    def test_explicit_offscreen_inspection_is_supported(self):
        output = []
        query.collect(Node(states=()), args(include_offscreen=True), output, [100])
        self.assertEqual(len(output), 1)

    def test_hidden_parent_does_not_prevent_visible_descendant_search(self):
        output = []
        query.collect(Node(states=(), children=[Node("Child")]), args(), output, [100])
        self.assertEqual([element["name"] for element in output], ["Child"])

    def test_defunct_and_stale_nodes_are_never_returned(self):
        for state in ("defunct", "stale"):
            output = []
            query.collect(
                Node(states=("visible", "showing", state)),
                args(include_offscreen=True),
                output,
                [100],
            )
            self.assertEqual(output, [])

    def test_unmatched_nodes_consume_traversal_budget(self):
        root = Node(children=[Node() for _ in range(64)])
        visited, output = [0, False], []
        query.collect(
            root, args(name="never matches", max_visited=5), output, [100], visited
        )
        self.assertEqual(visited, [5, True])
        self.assertEqual(root.child_reads, 4)
        self.assertEqual(output, [])

    def test_result_budget_stops_child_enumeration(self):
        root = Node(children=[Node() for _ in range(64)])
        output = []
        query.collect(root, args(), output, [1])
        self.assertEqual(len(output), 1)
        self.assertEqual(root.child_reads, 0)

    def test_focused_query_fails_instead_of_scanning_every_app(self):
        with (
            patch.object(sys, "argv", ["atspi_query.py", "--focused"]),
            patch.object(query, "focused_pid", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "Cannot resolve focused"):
                query.main()

    def test_invalid_focused_pids_are_rejected(self):
        for pid in (0, -1, True, None, "100"):
            with patch.object(
                query.subprocess,
                "run",
                return_value=SimpleNamespace(
                    returncode=0, stdout=__import__("json").dumps({"pid": pid})
                ),
            ):
                self.assertIsNone(query.focused_pid())


if __name__ == "__main__":
    unittest.main()
