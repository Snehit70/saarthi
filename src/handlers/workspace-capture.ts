import { z } from "zod";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { server } from "../registry.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { getWindowOrThrow, listWindows, HyprlandError } from "../lib/hyprland.js";
import { audit } from "../lib/audit.js";
import { dryRun, screenshotDirDefault } from "../runtime.js";

server.registerTool(
  "screenshot_workspace",
  {
    title: "Workspace Capture",
    description:
      "Capture each mapped window surface in an inactive workspace without focusing or switching. Returns a private image set, not a synthetic claim of the exact compositor scene.",
    inputSchema: { workspace: z.string().min(1).max(80), maxWindows: z.number().int().min(1).max(30).default(12) },
    annotations: { readOnlyHint: true, desktopInput: false },
  },
  async ({ workspace, maxWindows }) => {
    const windows = (await listWindows({})).filter(
      (window) => window.workspace === workspace && window.mapped && !window.hidden,
    );
    if (!windows.length) throw new HyprlandError("SCREENSHOT_FAILED", "Workspace has no mapped windows to capture");
    if (windows.length > maxWindows)
      throw new HyprlandError("SCREENSHOT_FAILED", "Workspace exceeds max-windows; choose an explicit larger bound");
    await mkdir(screenshotDirDefault, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(screenshotDirDefault, "workspace-"));
    const images = [];
    for (const window of windows) {
      const current = await getWindowOrThrow(window.id);
      if (current.workspace !== workspace)
        throw new HyprlandError("SCREENSHOT_FAILED", "Window left the selected workspace before capture");
      const capture = await captureScreenshot({ target: "window", windowId: window.id });
      const after = await getWindowOrThrow(window.id);
      if (after.workspace !== workspace)
        throw new HyprlandError("SCREENSHOT_FAILED", "Window left the selected workspace during capture");
      const path = join(directory, `${images.length + 1}-${window.id}.png`);
      await writeFile(path, capture.png, { mode: 0o600 });
      images.push({
        windowId: window.id,
        path,
        width: capture.width,
        height: capture.height,
        position: window.position,
      });
    }
    const result = {
      workspace,
      images,
      captureMethod: "window-surfaces",
      viewMutationRequested: false,
      sceneComposition: false,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    await audit("screenshot_workspace", { workspace, windowCount: images.length }, dryRun);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  },
);
