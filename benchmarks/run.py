#!/usr/bin/env python3
"""Benchmark setup, audited CLI steps, artifact grading, and honest reports."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from fixtures import prepare_case, grade_case

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "benchmarks/tasks.json"


def fingerprint():
    paths = sorted(
        [
            *ROOT.glob("src/**/*.ts"),
            *ROOT.glob("dist/src/**/*.js"),
            *ROOT.glob("scripts/*.py"),
            *ROOT.glob("benchmarks/*.py"),
            CATALOG,
            ROOT / "config/policy.json",
        ]
    )
    digest = hashlib.sha256()
    for path in paths:
        digest.update(
            str(path.relative_to(ROOT)).encode() + b"\0" + path.read_bytes() + b"\0"
        )
    return digest.hexdigest()


def frozen_runtime(directory, manifest):
    current = fingerprint()
    if "sourceSha256" not in manifest and not (directory / "trace.jsonl").exists():
        manifest["sourceSha256"] = current
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    elif manifest.get("sourceSha256") != current:
        raise ValueError(
            "Runtime or grader changed during evaluation; prepare a new run"
        )


def prepare(directory, seed, controller):
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    key = directory / ".grader-key"
    key.write_bytes(os.urandom(32))
    key.chmod(0o600)
    raw = CATALOG.read_bytes()
    catalog = json.loads(raw)
    (directory / "catalog.json").write_bytes(raw)
    manifest = {
        "version": 1,
        "seed": seed,
        "controller": controller,
        "catalogSha256": hashlib.sha256(raw).hexdigest(),
        "sourceCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "createdAt": time.time(),
        "sourceDirty": bool(
            subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)
        ),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "track": "scripted-reference"
        if controller == "scripted-reference"
        else "agent-hybrid",
        "tasks": {},
    }
    for task in catalog["tasks"]:
        folder = directory / "cases" / task["id"]
        public = prepare_case(task, folder, seed)
        db = folder / "clipboard.db"
        for source in public["files"][:4]:
            subprocess.run(
                ["cliphist", "-db-path", str(db), "store"],
                input=Path(source["path"]).read_bytes(),
                check=True,
                stdout=subprocess.DEVNULL,
            )
            subprocess.run(
                ["cliphist", "-db-path", str(db), "store"],
                input=b"Intervening text fixture only",
                check=True,
                stdout=subprocess.DEVNULL,
            )
        manifest["tasks"][task["id"]] = {"state": "unrun", "attempts": 0}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    state = Path(
        os.environ.get("SAARTHI_STATE_DIR", str(Path.home() / ".local/state/saarthi"))
    )
    state.mkdir(parents=True, exist_ok=True)
    (state / "benchmark-run.json").write_text(json.dumps({"directory": str(directory)}))
    return {
        "runDirectory": str(directory),
        "tasks": len(catalog["tasks"]),
        "controller": controller,
        "catalogSha256": manifest["catalogSha256"],
    }


def step(directory, task_id, args):
    manifest = json.loads((directory / "manifest.json").read_text())
    frozen_runtime(directory, manifest)
    if task_id not in manifest["tasks"]:
        raise ValueError("Unknown benchmark task")
    if len(args) < 2:
        raise ValueError("Pass a Saarthi noun and verb after --")
    env = {
        **os.environ,
        "SAARTHI_SESSION_ID": f"bench-{directory.name}-{task_id}",
        "CLIPHIST_DB_PATH": str(directory / "cases" / task_id / "clipboard.db"),
        "SAARTHI_STATUS": "0",
    }
    start = time.monotonic()
    result = subprocess.run(
        ["node", str(ROOT / "dist/src/cli.js"), *args, "--json"],
        env=env,
        capture_output=True,
        text=True,
        timeout=130,
    )
    elapsed = time.monotonic() - start
    parsed = json.loads(result.stdout) if result.returncode == 0 else {}
    mutating = args[:2] not in [
        ["ui", "read-text"],
        ["window", "list"],
        ["window", "wait-for"],
        ["clipboard", "images"],
    ]
    event = {
        "mutation": mutating,
        "lowLevelActions": max(
            parsed.get("stepCount", 1), parsed.get("sentImages", 1), 1
        ),
        "taskId": task_id,
        "tool": args[:2],
        "at": time.time(),
        "wallSeconds": elapsed,
        "exitCode": result.returncode,
        "selectors": [args[args.index("--name") + 1]]
        if "--name" in args
        else [
            item.get("element", {}).get("name")
            for item in parsed.get("steps", [])
            if item.get("element")
        ],
        "clipboardRestored": parsed.get("clipboardRestored"),
        "verificationRead": (
            args[:2] == ["ui", "batch"]
            and any(
                item.get("action") == "read-text" or item.get("verified")
                for item in parsed.get("steps", [])
            )
        )
        or args[:2]
        in [
            ["ui", "read-text"],
            ["observe", "wait-for-text"],
            ["observe", "screenshot-compare"],
        ],
    }
    with (directory / "trace.jsonl").open("a") as handle:
        handle.write(json.dumps(event) + "\n")
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)


def record(directory, task_id, event_file):
    manifest = json.loads((directory / "manifest.json").read_text())
    frozen_runtime(directory, manifest)
    if task_id not in manifest["tasks"]:
        raise ValueError("Unknown task")
    event = json.loads(event_file.read_text())
    required = {"tool", "at", "wallSeconds", "exitCode", "mutation", "verificationRead"}
    if (
        not required.issubset(event)
        or not isinstance(event["tool"], list)
        or len(event["tool"]) != 2
    ):
        raise ValueError("Invalid controller event")
    if (
        any(
            type(event[key]) not in (int, float) or not math.isfinite(event[key])
            for key in ["at", "wallSeconds"]
        )
        or event["wallSeconds"] < 0
    ):
        raise ValueError("Invalid event timing")
    if (
        any(type(event[key]) is not bool for key in ["mutation", "verificationRead"])
        or type(event["exitCode"]) is not int
    ):
        raise ValueError("Invalid event flags")
    if not all(isinstance(item, str) and item for item in event["tool"]):
        raise ValueError("Invalid tool identity")
    if "lowLevelActions" in event and (
        type(event["lowLevelActions"]) is not int or event["lowLevelActions"] < 1
    ):
        raise ValueError("Invalid action count")
    event = {**event, "taskId": task_id, "imported": True}
    with (directory / "trace.jsonl").open("a") as handle:
        handle.write(json.dumps(event) + "\n")
    return {
        "recorded": True,
        "taskId": task_id,
        "note": "Imported event provenance must be verified by the external controller harness",
    }


def grade(directory, task_id):
    catalog = json.loads((directory / "catalog.json").read_text())
    task = next(task for task in catalog["tasks"] if task["id"] == task_id)
    manifest = json.loads((directory / "manifest.json").read_text())
    frozen_runtime(directory, manifest)
    if (
        hashlib.sha256((directory / "catalog.json").read_bytes()).hexdigest()
        != manifest["catalogSha256"]
    ):
        raise ValueError("Catalog changed during evaluation")
    events = (
        [
            json.loads(line)
            for line in (directory / "trace.jsonl").read_text().splitlines()
        ]
        if (directory / "trace.jsonl").exists()
        else []
    )
    events = [event for event in events if event["taskId"] == task_id]
    outcome = grade_case(directory / "cases" / task_id)
    actions = sum(event.get("lowLevelActions", 1) for event in events)
    active_seconds = sum(event["wallSeconds"] for event in events)
    elapsed = (
        (
            max(event["at"] for event in events)
            - min(event["at"] - event["wallSeconds"] for event in events)
        )
        if events
        else 0
    )
    provenance = bool(events) and any(event.get("mutation") for event in events)
    within_budget = (
        actions <= task["actionBudget"] and elapsed <= task["timeBudgetSeconds"]
    )
    completed = outcome["completed"] and provenance and within_budget
    checks = outcome.get("checks", {})
    last_mutation = max(
        (event["at"] for event in events if event.get("mutation")), default=0
    )
    final_verification = any(
        event["verificationRead"] and event["at"] > last_mutation for event in events
    )
    preservation = (
        all(
            value
            for key, value in checks.items()
            if key in ["other-composer", "no-send"]
        )
        if checks
        else False
    )
    result = {
        **outcome,
        "completed": completed,
        "provenance": provenance,
        "withinBudget": within_budget,
        "preservation": preservation,
        "actions": actions,
        "activeToolSeconds": active_seconds,
        "wallElapsedSeconds": elapsed,
        "toolErrors": sum(event["exitCode"] != 0 for event in events),
        "verificationReads": sum(event["verificationRead"] for event in events),
        "verifiedAfterFinalAction": final_verification,
        "track": manifest["track"],
        "split": task["split"],
    }
    result["weightedScore"] = round(
        100
        * completed
        * (
            0.65
            + 0.15 * outcome["correctness"]
            + 0.1 * preservation
            + 0.05 * final_verification
            + 0.05 * max(0, 1 - elapsed / task["timeBudgetSeconds"])
        ),
        2,
    )
    manifest["tasks"][task_id] = {
        "state": "passed" if completed else "failed",
        "attempts": manifest["tasks"][task_id]["attempts"] + 1,
        "result": result,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return result


def report(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    tasks = manifest["tasks"]
    rows = list(tasks.values())
    executed = [row["result"] for row in rows if "result" in row]
    return {
        "controller": manifest["controller"],
        "track": manifest["track"],
        "catalogSha256": manifest["catalogSha256"],
        "sourceSha256": manifest.get("sourceSha256"),
        "total": len(rows),
        "passed": sum(row["state"] == "passed" for row in rows),
        "failed": sum(row["state"] == "failed" for row in rows),
        "unrun": sum(row["state"] == "unrun" for row in rows),
        "completionPercent": round(
            100 * sum(row["state"] == "passed" for row in rows) / len(rows), 2
        ),
        "wallElapsedSeconds": round(
            sum(result.get("wallElapsedSeconds", 0) for result in executed), 2
        ),
        "weightedScore": round(
            sum(row["result"]["weightedScore"] for row in rows if "result" in row)
            / len(rows),
            2,
        ),
        "preservationPercent": round(
            100 * sum(result["preservation"] for result in executed) / len(executed), 2
        )
        if executed
        else 0,
        "actions": sum(result["actions"] for result in executed),
        "activeToolSeconds": round(
            sum(result["activeToolSeconds"] for result in executed), 2
        ),
        "toolErrors": sum(result["toolErrors"] for result in executed),
        "bySplit": {
            split: {
                "total": sum(
                    task["split"] == split
                    for task in json.loads((directory / "catalog.json").read_text())[
                        "tasks"
                    ]
                ),
                "passed": sum(
                    row.get("result", {}).get("split") == split
                    and row["state"] == "passed"
                    for row in rows
                ),
            }
            for split in ["development", "holdout"]
        },
        "limitation": "Scripted-reference results measure the tool stack and fixture workflows, not autonomous planning or Codex product performance."
        if manifest["track"] == "scripted-reference"
        else "Self-authored development benchmark; independent blind evaluation and repeated seeds are required for competitive claims.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "operation", choices=["prepare", "step", "record", "grade", "report"]
    )
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--seed", type=int, default=20261022)
    parser.add_argument("--controller", default="manual-agent")
    parser.add_argument("--task-id")
    parser.add_argument("--event-file", type=Path)
    argv = sys.argv[1:]
    boundary = argv.index("--") if "--" in argv else len(argv)
    command = argv[boundary + 1 :]
    args = parser.parse_args(argv[:boundary])
    try:
        if args.operation == "prepare":
            result = prepare(args.run_dir, args.seed, args.controller)
        elif args.operation == "step":
            result = step(args.run_dir, args.task_id, command)
        elif args.operation == "record":
            result = record(args.run_dir, args.task_id, args.event_file)
        elif args.operation == "grade":
            result = grade(args.run_dir, args.task_id)
        else:
            result = report(args.run_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
