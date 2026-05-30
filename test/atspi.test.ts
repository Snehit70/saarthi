import { beforeEach, describe, expect, it, vi } from "vitest";

const cp = vi.hoisted(() => {
  const impl = vi.fn();
  const PROM = Symbol.for("nodejs.util.promisify.custom");
  function execFile(...args: any[]) {
    const cb = args[args.length - 1];
    Promise.resolve()
      .then(() => impl(args[0], args[1]))
      .then(
        (r: any) => cb(null, r?.stdout ?? "", r?.stderr ?? ""),
        (e: any) => cb(e),
      );
  }
  (execFile as any)[PROM] = (cmd: any, a: any) => Promise.resolve(impl(cmd, a));
  return { impl, execFile };
});
vi.mock("node:child_process", () => ({ execFile: cp.execFile }));

import { queryAtspi } from "../src/lib/atspi.js";

const OK_PAYLOAD = JSON.stringify({
  ok: true,
  mode: "find",
  apps: [{ name: "kitty", pid: 1, children: 2 }],
  elements: [
    {
      role: "push button",
      name: "Send",
      depth: 3,
      path: [0, 1],
      cx: 100,
      cy: 200,
      states: ["enabled", "sensitive"],
      actions: ["click"],
    },
  ],
  count: 1,
  truncated: false,
});

function withPython(py: () => any): void {
  cp.impl.mockImplementation((cmd: string) => {
    if (cmd === "which") return { stdout: "/usr/bin/python3\n", stderr: "" };
    if (cmd === "python3") return py();
    // Benign default: vitest's mock cleanup phase can invoke the spy with no
    // args after the test body; never let that throw and fail the assertion.
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => cp.impl.mockReset());

describe("queryAtspi", () => {
  it("parses a successful find result", async () => {
    withPython(() => ({ stdout: OK_PAYLOAD, stderr: "" }));
    const r = await queryAtspi({ mode: "find", maxDepth: 10, maxNodes: 100 });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.elements[0]).toMatchObject({ name: "Send", cx: 100, cy: 200 });
  });

  it("maps a script error payload to ATSPI_FAILED", async () => {
    withPython(() => {
      const e = new Error("py") as Error & { stdout: string };
      e.stdout = JSON.stringify({ ok: false, error: "no focused app" });
      throw e;
    });
    await expect(queryAtspi({ mode: "find", maxDepth: 10, maxNodes: 100 })).rejects.toThrow(
      /no focused app/,
    );
  });

  it("maps a timeout to ATSPI_FAILED", async () => {
    withPython(() => {
      const e = new Error("timeout") as Error & { killed: boolean };
      e.killed = true;
      throw e;
    });
    await expect(queryAtspi({ mode: "tree", maxDepth: 5, maxNodes: 50 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("rejects invalid JSON output", async () => {
    withPython(() => ({ stdout: "not json", stderr: "" }));
    await expect(queryAtspi({ mode: "find", maxDepth: 10, maxNodes: 100 })).rejects.toThrow(
      /invalid output/,
    );
  });
});
