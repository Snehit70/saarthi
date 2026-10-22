"""Artifact grading checks, without GTK or desktop access."""

import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from fixtures import prepare_case, grade_case
import run as benchmark
from reference import Controller


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".grader-key").write_bytes(b"unit-test-key")
        self.folder = self.root / "cases" / "documents-exact-copy"
        self.task = {
            "id": "documents-exact-copy",
            "domain": "documents",
            "title": "Exact copy",
        }
        prepare_case(self.task, self.folder, 77)
        self.expected = json.loads((self.folder / "expected.private.json").read_text())

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, actual):
        payload = json.dumps(
            actual, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        signature = hmac.new(b"unit-test-key", payload, hashlib.sha256).hexdigest()
        (self.folder / "outcome.json").write_text(
            json.dumps({"payload": actual, "signature": signature})
        )

    def test_missing_and_malformed_outcomes_fail(self):
        self.assertFalse(grade_case(self.folder)["completed"])
        for value in ("invalid-json", "[]", '{"payload":null}'):
            (self.folder / "outcome.json").write_text(value)
            self.assertFalse(grade_case(self.folder)["completed"])

    def test_signed_exact_outcome_passes_and_unsigned_echo_fails(self):
        self.save(self.expected)
        self.assertTrue(grade_case(self.folder)["completed"])
        (self.folder / "outcome.json").write_text(json.dumps(self.expected))
        self.assertFalse(grade_case(self.folder)["completed"])

    def test_tampering_and_unrelated_changes_fail(self):
        self.save(self.expected)
        envelope = json.loads((self.folder / "outcome.json").read_text())
        envelope["payload"]["sent"] = 1
        (self.folder / "outcome.json").write_text(json.dumps(envelope))
        self.assertFalse(grade_case(self.folder)["completed"])
        for key, value in [("other", "changed"), ("sent", 1), ("body", "truncated")]:
            self.save({**self.expected, key: value})
            self.assertFalse(grade_case(self.folder)["completed"])

    def test_source_file_corruption_fails(self):
        self.save(self.expected)
        source = json.loads((self.folder / "public.json").read_text())["files"][0][
            "path"
        ]
        Path(source).write_bytes(b"corrupted")
        self.assertFalse(grade_case(self.folder)["completed"])

    def test_catalog_has_64_unique_tasks_and_fixed_splits(self):
        catalog = json.loads(
            (Path(__file__).resolve().parents[1] / "benchmarks/tasks.json").read_text()
        )["tasks"]
        self.assertEqual(len(catalog), 64)
        self.assertEqual(len({task["id"] for task in catalog}), 64)
        self.assertEqual(sum(task["split"] == "holdout" for task in catalog), 16)
        self.assertEqual(len({task["domain"] for task in catalog}), 8)

    def initialize_manifest(self):
        catalog = {
            "tasks": [
                {
                    **self.task,
                    "actionBudget": 150,
                    "timeBudgetSeconds": 900,
                    "split": "development",
                }
            ]
        }
        raw = json.dumps(catalog).encode()
        (self.root / "catalog.json").write_bytes(raw)
        manifest = dict(
            controller="unit",
            track="agent-hybrid",
            catalogSha256=hashlib.sha256(raw).hexdigest(),
            tasks={self.task["id"]: dict(state="unrun", attempts=0)},
        )
        benchmark.frozen_runtime(self.root, manifest)

    def test_generic_controller_events_and_final_verification(self):
        self.initialize_manifest()
        self.save(self.expected)
        event = dict(
            tool=["native", "click"],
            at=10,
            wallSeconds=1,
            exitCode=0,
            mutation=True,
            verificationRead=False,
        )
        path = self.root / "event.json"
        path.write_text(json.dumps(event))
        benchmark.record(self.root, self.task["id"], path)
        path.write_text(
            json.dumps(
                {
                    **event,
                    "tool": ["native", "screenshot"],
                    "at": 12,
                    "mutation": False,
                    "verificationRead": True,
                }
            )
        )
        benchmark.record(self.root, self.task["id"], path)
        result = benchmark.grade(self.root, self.task["id"])
        self.assertTrue(result["completed"])
        self.assertTrue(result["verifiedAfterFinalAction"])
        self.assertEqual(result["wallElapsedSeconds"], 3)

    def test_invalid_telemetry_and_changed_runtime_are_rejected(self):
        self.initialize_manifest()
        path = self.root / "event.json"
        event = dict(
            tool=["native", "click"],
            at=10,
            wallSeconds=1,
            exitCode=0,
            mutation=True,
            verificationRead=False,
        )
        for override in [
            dict(wallSeconds=float("nan")),
            dict(mutation="true"),
            dict(lowLevelActions=-1),
        ]:
            path.write_text(json.dumps({**event, **override}))
            with self.assertRaises(ValueError):
                benchmark.record(self.root, self.task["id"], path)
        with patch.object(benchmark, "fingerprint", return_value="modified-runtime"):
            with self.assertRaisesRegex(ValueError, "changed during evaluation"):
                benchmark.grade(self.root, self.task["id"])

    def test_unrun_tasks_remain_in_denominator(self):
        catalog = json.loads(
            (Path(__file__).resolve().parents[1] / "benchmarks/tasks.json").read_text()
        )
        (self.root / "catalog.json").write_text(json.dumps(catalog))
        manifest = dict(
            controller="unit",
            track="agent-hybrid",
            catalogSha256="unit",
            tasks={
                task["id"]: dict(state="unrun", attempts=0) for task in catalog["tasks"]
            },
        )
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        result = benchmark.report(self.root)
        self.assertEqual(
            (
                result["total"],
                result["unrun"],
                result["completionPercent"],
                result["weightedScore"],
            ),
            (64, 64, 0, 0),
        )

    def test_reference_waits_for_task_identity_without_replaying_load(self):
        controller = Controller(self.root, "0x1")
        old = dict(task=dict(id="old-task"))
        new = dict(task=dict(id=self.task["id"]), currentRecord=dict(Title="Record 1"))
        with patch.object(
            controller, "read", side_effect=[json.dumps(old), json.dumps(new)]
        ) as read:
            self.assertEqual(controller.wait_for_brief(self.task["id"]), new)
            self.assertEqual(read.call_count, 2)
        with patch.object(controller, "read", return_value=json.dumps(old)):
            with self.assertRaisesRegex(RuntimeError, "did not advance"):
                controller.wait_for_brief(self.task["id"], timeout=0)

    def test_reference_rejects_stale_sequence_and_unobserved_save(self):
        controller = Controller(self.root, "0x1")
        stale = dict(
            task=dict(id=self.task["id"]), currentRecord=dict(Title="Record 1")
        )
        with patch.object(controller, "read", return_value=json.dumps(stale)):
            with self.assertRaisesRegex(RuntimeError, "did not advance"):
                controller.wait_for_brief(
                    self.task["id"],
                    lambda source: source["currentRecord"]["Title"] == "Record 2",
                    timeout=0,
                )
        with (
            patch.object(
                controller, "command", return_value=dict(text="Duplicate save rejected")
            ) as command,
            patch("reference.time.monotonic", side_effect=[0, 10]),
        ):
            with self.assertRaisesRegex(RuntimeError, "Save was not observed"):
                controller.verify_saved(self.task["id"])
            self.assertEqual(command.call_count, 1)


if __name__ == "__main__":
    unittest.main()
