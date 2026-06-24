import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HyprlandError } from "../lib/hyprland.js";
import { captureScreenshot } from "../lib/screenshot.js";
import { performFindTextOnScreen } from "../lib/text-locate.js";
import { resolvePointerCoordinates } from "../lib/pointer.js";
import { comparePngFiles } from "../lib/diff.js";
import { sleep } from "../lib/util.js";
import type { WindowId } from "../lib/types.js";
import { server } from "../registry.js";

const TARGET = z.enum(["full", "monitor", "active_window", "window"]);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

async function captureToFile(
  dir: string,
  name: string,
  target: z.infer<typeof TARGET>,
  monitorName?: string,
  windowId?: string,
): Promise<string> {
  const shot = await captureScreenshot({ target, monitorName, windowId: windowId as WindowId | undefined });
  const path = join(dir, name);
  await writeFile(path, shot.png);
  return path;
}

// ── wait_for_text ──────────────────────────────────────────────────────────
server.registerTool(
  "wait_for_text",
  {
    title: "Wait For Text",
    description: "Poll the screen with OCR until text appears (or disappears), or a timeout elapses.",
    inputSchema: {
      query: z.string().min(1).max(200),
      target: TARGET.default("full"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      mode: z.enum(["appear", "disappear"]).default("appear"),
      timeoutMs: z.number().int().min(200).max(60000).default(8000),
      pollMs: z.number().int().min(100).max(5000).default(400),
      confidenceMin: z.number().min(0).max(100).default(55),
    },
    annotations: READ_ONLY,
  },
  async ({ query, target, monitorName, windowId, mode, timeoutMs, pollMs, confidenceMin }) => {
    const started = Date.now();
    let attempts = 0;
    let lastMatch: Awaited<ReturnType<typeof performFindTextOnScreen>>["matches"][number] | null = null;

    while (Date.now() - started <= timeoutMs) {
      attempts += 1;
      const found = await performFindTextOnScreen({ query, target, monitorName, windowId: windowId as WindowId | undefined, confidenceMin, limit: 1 });
      const present = found.matches.length > 0;
      if (present) lastMatch = found.matches[0];
      const success = mode === "appear" ? present : !present;
      if (success) {
        let point: Record<string, number> | null = null;
        if (mode === "appear" && lastMatch) {
          const relativeX = lastMatch.x + Math.floor(lastMatch.width / 2);
          const relativeY = lastMatch.y + Math.floor(lastMatch.height / 2);
          const r = await resolvePointerCoordinates(relativeX, relativeY, target, monitorName, windowId as WindowId | undefined);
          point = { relativeX, relativeY, absoluteX: r.x, absoluteY: r.y };
        }
        const out = { ok: true, mode, query, attempts, elapsedMs: Date.now() - started, match: point };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
      }
      await sleep(pollMs);
    }
    const out = { ok: false, mode, query, attempts, elapsedMs: Date.now() - started, match: null };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
  },
);

// ── wait_for_stable ────────────────────────────────────────────────────────
server.registerTool(
  "wait_for_stable",
  {
    title: "Wait For Stable",
    description: "Capture a target repeatedly until it stops changing (settles) for N consecutive frames, or a timeout elapses.",
    inputSchema: {
      target: TARGET.default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      timeoutMs: z.number().int().min(200).max(60000).default(8000),
      pollMs: z.number().int().min(100).max(5000).default(350),
      threshold: z.number().min(0).max(1).default(0.01),
      stableFrames: z.number().int().min(2).max(10).default(2),
    },
    annotations: READ_ONLY,
  },
  async ({ target, monitorName, windowId, timeoutMs, pollMs, threshold, stableFrames }) => {
    const dir = await mkdtemp(join(tmpdir(), "saarthi-stable-"));
    const started = Date.now();
    try {
      let prev = await captureToFile(dir, "a.png", target, monitorName, windowId);
      let frames = 1;
      let stable = 0;
      let lastDiff: number | null = null;
      while (Date.now() - started <= timeoutMs) {
        await sleep(pollMs);
        const cur = await captureToFile(dir, frames % 2 === 0 ? "a.png" : "b.png", target, monitorName, windowId);
        frames += 1;
        const { normalized } = await comparePngFiles(prev, cur);
        lastDiff = normalized;
        stable = normalized <= threshold ? stable + 1 : 0;
        prev = cur;
        if (stable >= stableFrames - 1) {
          const out = { stable: true, frames, elapsedMs: Date.now() - started, lastDiff, threshold };
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
        }
      }
      const out = { stable: false, frames, elapsedMs: Date.now() - started, lastDiff, threshold };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ── screenshot_compare ─────────────────────────────────────────────────────
server.registerTool(
  "screenshot_compare",
  {
    title: "Screenshot Compare",
    description: "Compare two PNGs (or a baseline vs a fresh capture) and return a normalised diff score. Pass pathA+pathB, or baselinePath plus a capture target.",
    inputSchema: {
      pathA: z.string().optional(),
      pathB: z.string().optional(),
      baselinePath: z.string().optional(),
      target: TARGET.default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      threshold: z.number().min(0).max(1).default(0.02),
      saveDiffPath: z.string().optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ pathA, pathB, baselinePath, target, monitorName, windowId, threshold, saveDiffPath }) => {
    let a: string;
    let b: string;
    let dir: string | null = null;
    try {
      if (pathA && pathB) {
        a = pathA;
        b = pathB;
      } else if (baselinePath) {
        dir = await mkdtemp(join(tmpdir(), "saarthi-cmp-"));
        a = baselinePath;
        b = await captureToFile(dir, "current.png", target, monitorName, windowId);
      } else {
        throw new HyprlandError("NUMERIC_INVALID", "Provide pathA + pathB, or baselinePath with a capture target");
      }
      const { normalized, raw } = await comparePngFiles(a, b, saveDiffPath);
      const out = {
        changed: normalized > threshold,
        diffScore: normalized,
        raw,
        threshold,
        diffPath: saveDiffPath ?? null,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  },
);
