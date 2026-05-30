import { beforeEach, describe, expect, it, vi } from "vitest";

// Promisify-compatible execFile mock: lib code does `promisify(execFile)` at
// import, so the mock exposes the util.promisify.custom hook and routes calls
// through a vi.fn the tests configure per case.
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

import { comparePngFiles } from "../src/lib/diff.js";

function magickError(stderr: string): Error {
  const e = new Error("magick differ") as Error & { stderr: string };
  e.stderr = stderr;
  return e;
}

function withMagick(magick: () => any): void {
  cp.impl.mockImplementation((cmd: string) => {
    if (cmd === "which") return { stdout: "/usr/bin/magick\n", stderr: "" };
    if (cmd === "magick") return magick();
    // Benign default: vitest's mock cleanup phase can invoke the spy with no
    // args after the test body; never let that throw and fail the assertion.
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => cp.impl.mockReset());

describe("comparePngFiles", () => {
  it("parses normalised RMSE when images differ (magick exits 1)", async () => {
    withMagick(() => {
      throw magickError("8242.64 (0.125775)");
    });
    const r = await comparePngFiles("a.png", "b.png");
    expect(r.normalized).toBeCloseTo(0.125775, 5);
    expect(r.raw).toBeCloseTo(8242.64, 2);
  });

  it("returns zero distance for identical images (exit 0)", async () => {
    withMagick(() => ({ stderr: "0 (0)" }));
    const r = await comparePngFiles("a.png", "a.png");
    expect(r.normalized).toBe(0);
    expect(r.raw).toBe(0);
  });

  it("treats a size mismatch as maximally different", async () => {
    withMagick(() => {
      throw magickError("compare: images differ in size; widths or heights differ");
    });
    const r = await comparePngFiles("a.png", "b.png");
    expect(r.normalized).toBe(1);
    expect(Number.isNaN(r.raw)).toBe(true);
  });

  it("throws when ImageMagick is unavailable", async () => {
    cp.impl.mockImplementation((cmd: string) => {
      if (cmd === "which") throw new Error("not found");
      return { stdout: "", stderr: "" };
    });
    await expect(comparePngFiles("a.png", "b.png")).rejects.toThrow(/ImageMagick/);
  });
});
