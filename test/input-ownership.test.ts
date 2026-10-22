import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withDesktopInput, inputOwnershipSignal } from "../src/lib/input-ownership.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "saarthi-owner-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("rejects another transaction without running its operation and releases after completion", async () => {
  const path = join(root, "input.lock");
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = withDesktopInput(async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, path);
  await ready;
  let ran = false;
  await expect(
    withDesktopInput(async () => {
      ran = true;
    }, path),
  ).rejects.toMatchObject({ code: "INPUT_BUSY" });
  expect(ran).toBe(false);
  release();
  await held;
  await expect(withDesktopInput(async () => "available", path)).resolves.toBe("available");
});

it("supports nested actions in the same transaction and releases after failure", async () => {
  const path = join(root, "input.lock");
  await expect(
    withDesktopInput(async () => {
      expect(inputOwnershipSignal()?.aborted).toBe(false);
      return withDesktopInput(async () => {
        throw new Error("action failed");
      }, path);
    }, path),
  ).rejects.toThrow("action failed");
  await expect(withDesktopInput(async () => true, path)).resolves.toBe(true);
});

it("releases kernel ownership when the parent process is killed", async () => {
  const path = join(root, "input.lock");
  const script = join(root, "owner.mts");
  await writeFile(
    script,
    `import { withDesktopInput } from ${JSON.stringify(resolve("src/lib/input-ownership.ts"))}; await withDesktopInput(async () => { process.stdout.write("ready\\n"); await new Promise(() => {}); }, ${JSON.stringify(path)});`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("exit", () => reject(new Error("Owner exited before ready")));
      child.once("error", reject);
    });
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exit;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(withDesktopInput(async () => true, path)).resolves.toBe(true);
  } finally {
    child.kill("SIGKILL");
  }
}, 10000);
