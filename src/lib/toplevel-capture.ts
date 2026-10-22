import { desktopEnvironment } from "./desktop-environment.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { projectRoot } from "./paths.js";
import { getWindowOrThrow, HyprlandError, hyprlandEnvironment } from "./hyprland.js";
import type { WindowId } from "./types.js";

const run = promisify(execFile);
const mappings = z
  .array(
    z.object({
      windowId: z.string().regex(/^0x[0-9a-f]+$/),
      identifier: z.string().min(1).max(1024),
    }),
  )
  .max(4096);

/** Capture the actual surface, including on an inactive workspace. Never
 * focus, move, or temporarily show the window as a fallback. */
export async function captureToplevel(windowId: WindowId): Promise<Buffer> {
  const before = await getWindowOrThrow(windowId);
  const env = await desktopEnvironment();
  try {
    const { stdout } = await run(join(projectRoot(), "dist/native/toplevels"), [], {
      env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const matches = mappings.parse(JSON.parse(stdout)).filter((row) => row.windowId === windowId.toLowerCase());
    if (matches.length !== 1) throw new Error("Window has no unique capture identifier");
    const current = await getWindowOrThrow(windowId);
    if (current.pid !== before.pid || current.class !== before.class)
      throw new Error("Window identity changed before capture");
    const result = await run("grim", ["-T", matches[0].identifier, "-"], {
      env,
      encoding: "buffer",
      timeout: 10000,
      maxBuffer: 25 * 1024 * 1024,
    });
    if (String(result.stderr).trim()) throw new Error("Compositor refused to capture the window surface");
    const after = await getWindowOrThrow(windowId);
    if (after.pid !== before.pid || after.class !== before.class)
      throw new Error("Window identity changed during capture");
    return Buffer.from(result.stdout);
  } catch (error) {
    if (error instanceof HyprlandError) throw error;
    throw new HyprlandError(
      "SCREENSHOT_FAILED",
      `Non-disruptive window capture failed: ${error instanceof Error ? error.message : "capture unavailable"}. Requires grim -T and the built native mapping helper; no focus fallback was attempted.`,
    );
  }
}
