import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandExists } from "../src/lib/util.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "saarthi-path-"));
  vi.stubEnv("PATH", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("finds executable files on PATH and by absolute path", async () => {
  const executable = join(directory, "browser");
  await writeFile(executable, "");
  await chmod(executable, 0o700);
  expect(await commandExists("browser")).toBe(true);
  expect(await commandExists(executable)).toBe(true);
});

it("rejects non-executable files and executable directories", async () => {
  await writeFile(join(directory, "file"), "", { mode: 0o600 });
  await mkdir(join(directory, "folder"));
  expect(await commandExists("file")).toBe(false);
  expect(await commandExists("folder")).toBe(false);
});

it("continues past unavailable PATH entries", async () => {
  await writeFile(join(directory, "browser"), "", { mode: 0o700 });
  vi.stubEnv("PATH", `${join(directory, "missing")}${delimiter}${directory}`);
  expect(await commandExists("browser")).toBe(true);
});

it("returns false for a missing command without running a resolver", async () => {
  expect(await commandExists("missing")).toBe(false);
});
