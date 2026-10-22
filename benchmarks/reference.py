#!/usr/bin/env python3
"""Scripted reference controller. This measures tooling, not agent intelligence."""

import argparse
import json
import statistics
import time
from pathlib import Path
from run import step, grade, report


class Controller:
    def __init__(self, root, window):
        self.root = root
        self.window = window

    def command(self, task, *args):
        return step(self.root, task, list(args))

    def action(self, task, name, action, text=None, role=None):
        args = [
            "ui",
            "act",
            "--window-id",
            self.window,
            "--name",
            name,
            "--action",
            action,
        ]
        if role:
            args += ["--role", role]
        if text is not None:
            args += ["--text", text]
        return self.command(task, *args)

    def batch(self, task, steps):
        path = self.root / "cases" / task / "plan.private.json"
        path.write_text(json.dumps(steps, ensure_ascii=False))
        path.chmod(0o600)
        return self.command(
            task, "ui", "batch", "--window-id", self.window, "--steps-file", str(path)
        )

    def set(self, task, name, text):
        return self.action(task, name, "set-text", text, "text")

    def click(self, task, name):
        return self.action(task, name, "invoke", role="button")

    def read(self, task, name):
        return self.command(
            task,
            "ui",
            "read-text",
            "--window-id",
            self.window,
            "--name",
            name,
            "--role",
            "text",
        )["text"]

    def images(self, task, count, reverse=False, oldest_only=False):
        images = self.command(task, "clipboard", "images", "--limit", "4")["images"]
        selected = images[:count]
        if reverse:
            selected.reverse()
        if oldest_only:
            selected = images[-1:]
        self.action(task, "Target composer", "focus", role="text")
        return self.command(
            task,
            "clipboard",
            "paste-images",
            "--window-id",
            self.window,
            "--target-name",
            "Target composer",
            "--ids",
            ",".join(image["id"] for image in selected),
        )

    def attach(self, task, path):
        self.click(task, "Add files")
        dialog = self.command(
            task,
            "window",
            "wait-for",
            "--title-contains",
            "Attach files",
            "--focused-only",
            "--timeout-ms",
            "5000",
        )["window"]
        for key, mods in [("l", "ctrl")]:
            self.command(
                task,
                "input",
                "key-press",
                "--window-id",
                dialog["id"],
                "--key",
                key,
                "--modifiers",
                mods,
            )
        self.command(task, "input", "type", "--window-id", dialog["id"], "--text", path)
        self.command(
            task, "input", "key-press", "--window-id", dialog["id"], "--key", "enter"
        )
        ready = self.command(
            task,
            "window",
            "wait-for",
            "--title-contains",
            "Saarthi benchmark workspace",
            "--focused-only",
            "--timeout-ms",
            "5000",
        )["window"]
        if ready["id"] != self.window:
            raise RuntimeError("Unexpected parent window after file selection")

    def solve(self, task):
        task_id = task["id"]
        domain = task["domain"]
        slug = task_id.removeprefix(domain + "-")
        self.batch(
            task_id,
            [
                {
                    "name": "Task id",
                    "role": "text",
                    "action": "set-text",
                    "text": task_id,
                },
                {"name": "Load task", "role": "button", "action": "invoke"},
            ],
        )
        source = json.loads(self.read(task_id, "Task brief"))
        approved = source["approved"]
        base = source["baseline"]
        rows = source["rows"]
        changes = {}
        body = None
        if domain == "clipboard":
            count = {
                "skip-text": 3,
                "single-receipt": 1,
                "two-images": 2,
                "unicode-caption": 3,
            }.get(slug, 4)
            self.images(task_id, count, reverse=slug == "oldest-first")
            if slug == "with-caption":
                body = base["body"] + "\n\n" + approved["Body"]
            if slug == "unicode-caption":
                body = approved["Body"]
        elif domain == "documents":
            changes["Title"] = approved["Title"]
            body = approved["Body"]
            if slug == "append-summary":
                body = base["body"] + "\n\n" + body
            if slug == "clear-obsolete":
                body = ""
        elif domain == "data":
            amounts = [row["amount"] for row in rows]
            if slug in ["sum-all", "net-refunds"]:
                number = sum(amounts)
            elif slug == "sum-approved":
                number = sum(
                    row["amount"] for row in rows if row["status"] == "approved"
                )
            elif slug == "count-pending":
                number = sum(row["status"] == "pending" for row in rows)
            elif slug == "max-amount":
                number = max(amounts)
            elif slug == "sum-north":
                number = sum(row["amount"] for row in rows if row["region"] == "north")
            elif slug == "median-amount":
                number = statistics.median(amounts)
            else:
                number = None
                body = json.dumps(
                    {
                        region: sum(
                            row["amount"] for row in rows if row["region"] == region
                        )
                        for region in sorted({row["region"] for row in rows})
                    },
                    ensure_ascii=False,
                )
            if number is not None:
                changes["Numeric result"] = str(number).removesuffix(".0")
            if slug == "sum-all":
                changes["Title"] = approved["Title"]
        elif domain == "forms":
            keys = {
                "registration-draft": ["Title", "Recipient", "Status", "Tags"],
                "travel-request": [key for key in approved if key != "Body"],
                "support-triage": ["Status", "Tags"],
                "settings-profile": ["Locale", "Theme"],
                "recipient-only": ["Recipient"],
                "tag-migration": ["Tags"],
                "status-transition": ["Status", "Title"],
                "all-fields": [key for key in approved if key != "Body"],
            }[slug]
            changes = {key: approved[key] for key in keys}
            if slug in ["support-triage", "all-fields"]:
                body = approved["Body"]
        elif domain == "files":
            indexes = {
                "upload-one": [0],
                "upload-four": [0, 1, 2, 3],
                "spaces-in-path": [0],
                "unicode-path": [2],
                "text-and-images": [4, 0, 1],
                "attach-caption": [0, 1],
                "preserve-duplicates": [0, 1],
                "draft-package": [0, 1, 2, 3, 4],
            }[slug]
            for index in indexes:
                self.attach(task_id, source["files"][index]["path"])
            if slug == "attach-caption":
                body = approved["Body"]
            if slug == "draft-package":
                changes = {"Title": approved["Title"], "Tags": approved["Tags"]}
        elif domain == "recovery":
            body = approved["Body"]
            if slug in ["missing-selector", "failed-invocation"]:
                try:
                    self.action(
                        task_id,
                        "Ghost composer"
                        if slug == "missing-selector"
                        else "Nonexistent control",
                        "focus" if slug == "missing-selector" else "invoke",
                    )
                except RuntimeError:
                    pass
            if slug == "focus-roundtrip":
                self.action(task_id, "Other composer", "focus", role="text")
                self.action(task_id, "Target composer", "focus", role="text")
            if slug == "disabled-send":
                changes = {"Title": approved["Title"], "Status": approved["Status"]}
        elif domain == "long-horizon":
            index = 0
            while True:
                current = source["currentRecord"]
                counts = {
                    "ten-records": 10,
                    "twenty-records": 20,
                    "thirty-records": 30,
                    "mixed-unicode": 12,
                    "large-bodies": 8,
                    "edit-and-attach": 6,
                    "recover-midway": 15,
                    "forty-records": 40,
                }
                last = index + 1 >= counts[slug]
                edits = [
                    {
                        "name": "Title",
                        "role": "text",
                        "action": "set-text",
                        "text": current["Title"],
                    },
                    {
                        "name": "Target composer",
                        "role": "text",
                        "action": "set-text",
                        "text": current["Body"],
                    },
                ]
                if slug == "edit-and-attach" and last:
                    self.batch(task_id, edits)
                    self.images(task_id, 1, oldest_only=True)
                    self.click(task_id, "Save draft")
                else:
                    edits.append(
                        {"name": "Save draft", "role": "button", "action": "invoke"}
                    )
                    if not last:
                        edits.extend(
                            [
                                {
                                    "name": "Next record",
                                    "role": "button",
                                    "action": "invoke",
                                },
                                {
                                    "name": "Task brief",
                                    "role": "text",
                                    "action": "read-text",
                                },
                            ]
                        )
                    result = self.batch(task_id, edits)
                    if not last:
                        source = json.loads(result["steps"][-1]["text"])
                        deadline = time.monotonic() + 2
                        while (
                            source["currentRecord"]["Title"] == current["Title"]
                            and time.monotonic() < deadline
                        ):
                            source = json.loads(self.read(task_id, "Task brief"))
                index += 1
                if last:
                    break
                if slug == "recover-midway" and index == 7:
                    try:
                        self.action(task_id, "Ghost composer", "focus")
                    except RuntimeError:
                        pass
            self.command(
                task_id,
                "ui",
                "read-text",
                "--window-id",
                self.window,
                "--name",
                "Workflow status",
                "--role",
                "label",
            )
            return
        else:
            key = {
                "title-only": "Title",
                "body-only": "Body",
                "locale-only": "Locale",
                "theme-only": "Theme",
                "tags-only": "Tags",
                "numeric-only": "Numeric result",
            }.get(slug)
            if key == "Body":
                body = approved[key]
            elif key:
                changes[key] = approved[key]
            elif slug == "clipboard-preserved":
                self.images(task_id, 2)
            else:
                changes = {key: approved[key] for key in ["Title", "Status", "Tags"]}
                body = approved["Body"]
        edits = [
            {"name": name, "role": "text", "action": "set-text", "text": value}
            for name, value in changes.items()
        ]
        if body is not None:
            edits.append(
                {
                    "name": "Target composer",
                    "role": "text",
                    "action": "set-text",
                    "text": body,
                }
            )
        if domain == "recovery" and slug == "long-empty-edit":
            edits.insert(
                0,
                {
                    "name": "Target composer",
                    "role": "text",
                    "action": "set-text",
                    "text": "",
                },
            )
        reads = [
            {"name": name, "role": "text", "action": "read-text"} for name in changes
        ]
        if body is not None:
            reads.append(
                {"name": "Target composer", "role": "text", "action": "read-text"}
            )
        if edits:
            self.batch(task_id, edits + reads)
        if domain == "recovery" and slug == "delayed-control":
            self.click(task_id, "Request delayed save")
            time.sleep(0.6)
            self.click(task_id, "Delayed save")
        else:
            self.click(task_id, "Save draft")
        self.command(
            task_id,
            "ui",
            "read-text",
            "--window-id",
            self.window,
            "--name",
            "Workflow status",
            "--role",
            "label",
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--window-id", required=True)
    parser.add_argument("--domain")
    parser.add_argument("--task-id")
    args = parser.parse_args()
    controller = Controller(args.run_dir, args.window_id)
    tasks = json.loads((args.run_dir / "catalog.json").read_text())["tasks"]
    for task in tasks:
        if args.domain and task["domain"] != args.domain:
            continue
        if args.task_id and task["id"] != args.task_id:
            continue
        stop = False
        try:
            controller.solve(task)
        except Exception as error:
            print(json.dumps({"task": task["id"], "error": str(error)}), flush=True)
            stop = "focus changed" in str(error).lower() or "WINDOW_NOT_FOUND" in str(
                error
            )
        result = grade(args.run_dir, task["id"])
        print(
            json.dumps(
                {
                    "task": task["id"],
                    "completed": result["completed"],
                    "correctness": result["correctness"],
                    "actions": result["actions"],
                }
            ),
            flush=True,
        )
        if stop:
            break
    print(json.dumps(report(args.run_dir), indent=2), flush=True)
