import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audit } from "../lib/audit.js";
import { captureScreenshot } from "../lib/screenshot.js";
import type { WindowId } from "../lib/types.js";
import { server } from "../server.js";
import { dryRun, screenshotDirDefault } from "../runtime.js";

const execFileAsync = promisify(execFile);

server.registerTool(
  "desktop_screenshot",
  {
    title: "Desktop Screenshot",
    description: "Capture screenshot of full desktop, monitor, active window, or specific window.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId }) => {
    const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
    return {
      content: [
        {
          type: "image",
          data: shot.png.toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "text",
          text: JSON.stringify(
            {
              width: shot.width,
              height: shot.height,
              target: shot.target,
              geometry: shot.geometry,
              monitorName: shot.monitorName ?? null,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        width: shot.width,
        height: shot.height,
        target: shot.target,
        geometry: shot.geometry ?? null,
        monitorName: shot.monitorName ?? null,
      },
    };
  },
);

server.registerTool(
  "desktop_screenshot_save",
  {
    title: "Desktop Screenshot Save",
    description: "Capture screenshot and save PNG to disk.",
    inputSchema: {
      target: z.enum(["full", "monitor", "active_window", "window"]),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      filenamePrefix: z.string().min(1).max(64).default("screenshot"),
      outputDir: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ target, monitorName, windowId, filenamePrefix, outputDir }) => {
    const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
    const dir = outputDir ?? screenshotDirDefault;
    const safePrefix = filenamePrefix.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safePrefix}.png`;
    const path = join(dir, filename);

    await mkdir(dir, { recursive: true });
    await writeFile(path, shot.png);

    await audit(
      "desktop_screenshot_save",
      { target, monitorName: monitorName ?? null, windowId: windowId ?? null, path, width: shot.width, height: shot.height },
      dryRun,
    );

    return {
      content: [{ type: "text", text: JSON.stringify({ path, width: shot.width, height: shot.height, target }, null, 2) }],
      structuredContent: { path, width: shot.width, height: shot.height, target },
    };
  },
);

server.registerTool(
  "desktop_screenshot_area",
  {
    title: "Desktop Screenshot Area",
    description: "Capture screenshot for an explicit absolute area rectangle.",
    inputSchema: {
      x: z.number().int().min(-20000).max(20000),
      y: z.number().int().min(-20000).max(20000),
      width: z.number().int().min(1).max(20000),
      height: z.number().int().min(1).max(20000),
      savePath: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ x, y, width, height, savePath }) => {
    const outPath = savePath ?? join(screenshotDirDefault, `${new Date().toISOString().replace(/[:.]/g, "-")}-area.png`);
    if (dryRun) {
      await audit("desktop_screenshot_area", { x, y, width, height, path: outPath }, dryRun);
      return {
        content: [{ type: "text", text: `DRY_RUN area screenshot ${x},${y} ${width}x${height} -> ${outPath}` }],
        structuredContent: { dryRun: true, path: outPath, geometry: { x, y, width, height } },
      };
    }
    await mkdir(dirname(outPath), { recursive: true });
    const geometry = `${x},${y} ${width}x${height}`;
    await execFileAsync("grim", ["-g", geometry, outPath]);
    await audit("desktop_screenshot_area", { x, y, width, height, path: outPath }, dryRun);
    return {
      content: [{ type: "text", text: JSON.stringify({ path: outPath, geometry: { x, y, width, height } }, null, 2) }],
      structuredContent: { path: outPath, geometry: { x, y, width, height } },
    };
  },
);
