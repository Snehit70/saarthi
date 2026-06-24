import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRoot } from "../src/lib/paths.js";

const originalCwd = process.cwd();

afterEach(() => process.chdir(originalCwd));

describe("installed asset resolution", () => {
  it("locates the package policy independently of the caller working directory", () => {
    process.chdir(mkdtempSync(join(tmpdir(), "saarthi-cwd-")));
    expect(projectRoot()).toBe(originalCwd);
  });
});
