import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPersistentLaunchRateLimiter } from "../src/lib/apps.js";
import { readStateSync, removeStateSync, writeStateAtomicSync } from "../src/lib/state.js";

describe("cross-invocation state", () => {
  it("atomically persists and removes serializable state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-state-"));
    const path = join(dir, "nested", "grid-session.json");
    writeStateAtomicSync(path, { id: "grid-1", cell: 14 });
    expect(readStateSync(path)).toEqual({ id: "grid-1", cell: 14 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ id: "grid-1", cell: 14 });
    removeStateSync(path);
    expect(readStateSync(path)).toBeNull();
  });

  it("enforces launch limits across independent limiter instances and prunes old timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-rate-"));
    const path = join(dir, "launch-timestamps.json");
    let now = 100_000;
    const firstProcess = createPersistentLaunchRateLimiter(2, path, () => now);
    const secondProcess = createPersistentLaunchRateLimiter(2, path, () => now);

    firstProcess();
    secondProcess();
    expect(() => createPersistentLaunchRateLimiter(2, path, () => now)()).toThrow("Launch rate limit exceeded");

    now += 60_001;
    expect(() => createPersistentLaunchRateLimiter(2, path, () => now)()).not.toThrow();
    expect(readStateSync(path)).toEqual([now]);
  });
});
