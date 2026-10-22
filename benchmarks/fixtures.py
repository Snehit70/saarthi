"""Seeded public inputs and an independent artifact oracle for SaarthiBench."""

import hashlib
import hmac
import json
import random
import statistics
import struct
import zlib
from pathlib import Path

FIELDS = ["Title", "Recipient", "Status", "Tags", "Locale", "Theme", "Numeric result"]


def png(color):
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 24, 24, 8, 2, 0, 0, 0))
        + chunk(
            b"IDAT",
            zlib.compress(b"".join(b"\0" + bytes(color) * 24 for _ in range(24))),
        )
        + chunk(b"IEND", b"")
    )


def prepare_case(task, folder, seed):
    rng = random.Random(f"{seed}:{task['id']}")
    folder.mkdir(parents=True)
    fields = dict(
        zip(
            FIELDS,
            [
                "Original title",
                "review@example.test",
                "draft",
                "keep,original",
                "en-IN",
                "system",
                "0",
            ],
        )
    )
    body = "Existing draft.\nPreserve this unless instructed otherwise."
    other = f"Unrelated draft must stay unchanged: {rng.randrange(100000, 999999)}"
    approved = {
        "Title": f"Approved {task['title']} {rng.randrange(1000, 9999)}",
        "Recipient": f"person{rng.randrange(100, 999)}@example.test",
        "Status": "review-ready",
        "Tags": "approved,important",
        "Locale": "hi-IN",
        "Theme": "dark",
        "Numeric result": str(rng.randrange(100, 900)),
        "Body": f"Approved report {rng.randrange(10000, 99999)}.\n\nAction items:\n1. Verify the source.\n2. Preserve unrelated work.\n\nनमस्ते, review complete.",
    }
    rows = [
        {
            "id": i + 1,
            "amount": rng.randrange(10, 1000),
            "status": ["approved", "pending"][i % 2],
            "region": ["north", "south", "west"][i % 3],
        }
        for i in range(12 + rng.randrange(6))
    ]
    if task["id"].endswith("net-refunds"):
        for row in rows[::4]:
            row["amount"] = -row["amount"]
    sources = []
    for i, name in enumerate(
        ["receipt 1.png", "receipt 2.png", "रसीद 3.png", "receipt 4.png"]
    ):
        path = folder / name
        data = png(
            (rng.randrange(1, 255), rng.randrange(1, 255), rng.randrange(1, 255))
        )
        path.write_bytes(data)
        sources.append(
            {"path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest()}
        )
    if task["id"].endswith("preserve-duplicates"):
        Path(sources[1]["path"]).write_bytes(Path(sources[0]["path"]).read_bytes())
        sources[1]["sha256"] = sources[0]["sha256"]
    text_path = folder / "brief notes.txt"
    text_path.write_text("Fixture notes only.\n", encoding="utf-8")
    sources.append(
        {
            "path": str(text_path.resolve()),
            "sha256": hashlib.sha256(text_path.read_bytes()).hexdigest(),
        }
    )
    expected_fields = fields.copy()
    expected_body = body
    expected_images = []
    expected_files = []
    history = []
    slug = task["id"].removeprefix(task["domain"] + "-")
    domain = task["domain"]
    if domain == "clipboard":
        count = {
            "skip-text": 3,
            "single-receipt": 1,
            "two-images": 2,
            "unicode-caption": 3,
        }.get(slug, 4)
        expected_images = [source["sha256"] for source in reversed(sources[:4])][:count]
        if slug == "oldest-first":
            expected_images.reverse()
        if slug == "with-caption":
            expected_body = body + "\n\n" + approved["Body"]
        if slug == "unicode-caption":
            expected_body = approved["Body"]
    elif domain == "documents":
        expected_fields["Title"] = approved["Title"]
        expected_body = approved["Body"]
        if slug == "long-article":
            approved["Body"] = "\n\n".join(
                f"Paragraph {i}: " + approved["Body"] for i in range(40)
            )
            expected_body = approved["Body"]
        if slug == "append-summary":
            expected_body = body + "\n\n" + approved["Body"]
        if slug == "clear-obsolete":
            expected_body = ""
        if slug == "exact-copy":
            approved["Body"] = (
                "Tabs\tstay.\nSymbols: <>& $() -M ctrl\nClosing sentence.\n"
            )
            expected_body = approved["Body"]
    elif domain == "data":
        values = [row["amount"] for row in rows]
        number = {
            "sum-all": lambda: sum(values),
            "sum-approved": lambda: sum(
                row["amount"] for row in rows if row["status"] == "approved"
            ),
            "count-pending": lambda: sum(row["status"] == "pending" for row in rows),
            "max-amount": lambda: max(values),
            "net-refunds": lambda: sum(values),
            "sum-north": lambda: sum(
                row["amount"] for row in rows if row["region"] == "north"
            ),
            "median-amount": lambda: statistics.median(values),
        }
        if slug == "group-summary":
            expected_body = json.dumps(
                {
                    region: sum(
                        row["amount"] for row in rows if row["region"] == region
                    )
                    for region in sorted({row["region"] for row in rows})
                },
                ensure_ascii=False,
            )
        else:
            expected_fields["Numeric result"] = str(number[slug]()).removesuffix(".0")
        if slug == "sum-all":
            expected_fields["Title"] = approved["Title"]
    elif domain == "forms":
        keys = {
            "registration-draft": ["Title", "Recipient", "Status", "Tags"],
            "travel-request": FIELDS,
            "support-triage": ["Status", "Tags"],
            "settings-profile": ["Locale", "Theme"],
            "recipient-only": ["Recipient"],
            "tag-migration": ["Tags"],
            "status-transition": ["Status", "Title"],
            "all-fields": FIELDS,
        }[slug]
        for key in keys:
            expected_fields[key] = approved[key]
        if slug in ["support-triage", "all-fields"]:
            expected_body = approved["Body"]
    elif domain == "files":
        indices = {
            "upload-one": [0],
            "upload-four": [0, 1, 2, 3],
            "spaces-in-path": [0],
            "unicode-path": [2],
            "text-and-images": [4, 0, 1],
            "attach-caption": [0, 1],
            "preserve-duplicates": [0, 1],
            "draft-package": [0, 1, 2, 3, 4],
        }[slug]
        expected_files = [sources[i] for i in indices]
        if slug == "attach-caption":
            expected_body = approved["Body"]
        if slug == "draft-package":
            expected_fields.update(
                {"Title": approved["Title"], "Tags": approved["Tags"]}
            )
    elif domain == "recovery":
        expected_body = approved["Body"]
        if slug == "disabled-send":
            expected_fields.update(
                {"Title": approved["Title"], "Status": approved["Status"]}
            )
        if slug == "long-empty-edit":
            approved["Body"] = "\n".join([approved["Body"]] * 30)
            expected_body = approved["Body"]
    elif domain == "long-horizon":
        count = {
            "ten-records": 10,
            "twenty-records": 20,
            "thirty-records": 30,
            "mixed-unicode": 12,
            "large-bodies": 8,
            "edit-and-attach": 6,
            "recover-midway": 15,
            "forty-records": 40,
        }[slug]
        for i in range(count):
            article = f"Record {i + 1}, seed {seed}, reference {rng.randrange(10000, 99999)}.\n\nPreserve exact text. नमस्ते."
            if slug == "large-bodies":
                article = "\n\n".join([article] * 30)
            history.append(
                {"Title": f"Record {i + 1}: {task['title']}", "Body": article}
            )
        expected_fields["Title"] = history[-1]["Title"]
        expected_body = history[-1]["Body"]
        if slug == "edit-and-attach":
            expected_images = [sources[0]["sha256"]]
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
            expected_body = approved[key]
        elif key:
            expected_fields[key] = approved[key]
        elif slug == "clipboard-preserved":
            expected_images = [source["sha256"] for source in reversed(sources[:4])][:2]
        else:
            for key in ["Title", "Status", "Tags"]:
                expected_fields[key] = approved[key]
            expected_body = approved["Body"]
    public = {
        "task": task,
        "baseline": {"fields": fields, "body": body, "other": other},
        "approved": approved,
        "rows": rows,
        "files": sources,
        "records": history,
    }
    expected = {
        "fields": expected_fields,
        "body": expected_body,
        "other": other,
        "images": expected_images,
        "files": expected_files,
        "history": history,
        "sent": 0,
    }
    (folder / "public.json").write_text(
        json.dumps(public, ensure_ascii=False), encoding="utf-8"
    )
    (folder / "expected.private.json").write_text(
        json.dumps(expected, ensure_ascii=False), encoding="utf-8"
    )
    return public


def grade_case(folder):
    expected = json.loads((folder / "expected.private.json").read_text())
    output = folder / "outcome.json"
    if not output.exists():
        return {
            "completed": False,
            "correctness": 0,
            "checks": {},
            "reason": "No saved workflow artifact",
        }
    try:
        envelope = json.loads(output.read_text())
        if (
            not isinstance(envelope, dict)
            or not isinstance(envelope.get("payload"), dict)
            or not isinstance(envelope.get("signature"), str)
        ):
            raise ValueError("Invalid envelope")
    except (ValueError, OSError):
        return {
            "completed": False,
            "correctness": 0,
            "checks": {},
            "reason": "Malformed workflow artifact",
        }
    actual = envelope["payload"]
    key = (folder.parents[1] / ".grader-key").read_bytes()
    payload = json.dumps(
        actual, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    signature = hmac.new(key, payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, envelope.get("signature", "")):
        return {
            "completed": False,
            "correctness": 0,
            "checks": {},
            "reason": "Artifact is not authenticated by the fixture application",
        }
    checks = {
        f"field:{key}": actual.get("fields", {}).get(key) == value
        for key, value in expected["fields"].items()
    }
    checks.update(
        {
            "body": actual.get("body") == expected["body"],
            "other-composer": actual.get("other") == expected["other"],
            "image-order": actual.get("images") == expected["images"],
            "files": actual.get("files") == expected["files"],
            "no-send": actual.get("sent") == 0,
        }
    )
    public = json.loads((folder / "public.json").read_text())
    checks["source-files-preserved"] = all(
        Path(source["path"]).is_file()
        and hashlib.sha256(Path(source["path"]).read_bytes()).hexdigest()
        == source["sha256"]
        for source in public["files"]
    )
    if expected["history"]:
        checks["history"] = actual.get("history") == expected["history"]
    return {
        "completed": all(checks.values()),
        "correctness": sum(checks.values()) / len(checks),
        "checks": checks,
    }
