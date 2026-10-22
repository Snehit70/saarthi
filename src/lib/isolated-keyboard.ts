import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { projectRoot } from "./paths.js";
import {
  isolatedEnvironment,
  isolatedRuntime,
} from "./isolated-environment.js";
import { spawnOwned, ownsProcess, signalOwned } from "./isolated-process.js";
import {
  saveDesktop,
  assertDesktop,
  type DesktopRecord,
} from "./isolated-desktop.js";
import { inputOwnershipSignal } from "./input-ownership.js";
import { readPrivateJson } from "./private-json.js";
import { HyprlandError } from "./hyprland.js";

/** Each invocation creates a bounded Wayland client. It retains its device after
 * completion without accepting commands. Retire the previous client only once
 * the replacement is active, avoiding a null keymap in headless Sway. */
export async function privateKeyboard(
  record: DesktopRecord,
  args: string[],
  text?: string,
): Promise<void> {
  await assertDesktop(record);
  if (record.inputBlocked)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private keyboard action is unresolved; inspect, then stop and recreate this desktop",
    );
  record.inputBlocked = true;
  await saveDesktop(record);
  const runtime = isolatedRuntime(record.id);
  const receipt = join(
    runtime,
    `keyboard-${randomBytes(12).toString("hex")}.json`,
  );
  const previous = record.keyboard;
  const current = await spawnOwned(
    join(projectRoot(), "dist/native/keyboard"),
    [join(runtime, record.display), receipt, ...args],
    isolatedEnvironment(record.id, record.display),
    join(runtime, "input-devices.log"),
    text,
  );
  record.keyboard = current;
  // Persist before polling. An interrupted invocation leaves a known device,
  // rather than an untracked helper or an automatic replay of uncertain input.
  await saveDesktop(record);
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (inputOwnershipSignal()?.aborted)
        throw new Error("Private input lease was lost");
      if (!(await ownsProcess(current, record.id, runtime)))
        throw new Error("Private keyboard exited");
      try {
        const result = await readPrivateJson(receipt);
        if ((result as { complete?: boolean }).complete !== true)
          throw new Error("Invalid keyboard receipt");
        if (previous)
          await signalOwned(record.id, runtime, [previous], "SIGTERM");
        record.inputBlocked = false;
        await saveDesktop(record);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Private keyboard action timed out");
  } catch (error) {
    // Do not destroy an active keyboard on an uncertain action. Keep its identity
    // for explicit stop; callers inspect the application before doing more work.
    throw new HyprlandError(
      "INPUT_FAILED",
      error instanceof Error ? error.message : "Private keyboard failed",
    );
  } finally {
    await rm(receipt, { force: true });
    await rm(`${receipt}.tmp`, { force: true });
  }
}
