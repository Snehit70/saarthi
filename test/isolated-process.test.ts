import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  ownsProcess,
  processIdentity,
  terminateSession,
} from "../src/lib/isolated-process.js";
import { isolatedRuntime } from "../src/lib/isolated-environment.js";

it("rejects stale process identity and cleans up only processes with both private markers", async () => {
  const id = randomBytes(8).toString("hex");
  const runtime = isolatedRuntime(id);
  const owned = spawn("sleep", ["30"], {
    env: { ...process.env, SAARTHI_DESKTOP_ID: id, XDG_RUNTIME_DIR: runtime },
    stdio: "ignore",
  });
  const foreign = spawn("sleep", ["30"], {
    env: {
      ...process.env,
      SAARTHI_DESKTOP_ID: id,
      XDG_RUNTIME_DIR: "/not-the-private-runtime",
    },
    stdio: "ignore",
  });
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        owned.once("spawn", resolve);
        owned.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        foreign.once("spawn", resolve);
        foreign.once("error", reject);
      }),
    ]);
    const identity = await processIdentity(owned.pid!);
    expect(await ownsProcess(identity, id, runtime)).toBe(true);
    expect(
      await ownsProcess({ ...identity, startTime: "0" }, id, runtime),
    ).toBe(false);
    expect(
      await ownsProcess(await processIdentity(foreign.pid!), id, runtime),
    ).toBe(false);
    expect(await terminateSession(id, runtime)).toBeGreaterThan(0);
    expect(await ownsProcess(identity, id, runtime)).toBe(false);
    expect((await processIdentity(foreign.pid!)).pid).toBe(foreign.pid);
  } finally {
    owned.kill("SIGKILL");
    foreign.kill("SIGKILL");
  }
}, 10000);
