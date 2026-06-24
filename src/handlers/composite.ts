import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audit } from "../lib/audit.js";
import { formatError, HyprlandError, sendShortcut } from "../lib/hyprland.js";
import { captureScreenshot } from "../lib/screenshot.js";
import type { WindowId } from "../lib/types.js";
import { commandExists, sleep } from "../lib/util.js";
import {
  normalizeKey,
  normalizeModifiers,
  sanitizeTypedText,
  toHyprShortcutKey,
  toHyprShortcutMods,
} from "../lib/input.js";
import { cellToRelativePoint, ensureGridSessionFresh, resolvePointerCoordinates } from "../lib/pointer.js";
import { performMouseClick } from "../lib/mouse.js";
import { performFindTextOnScreen, resolveTextClickPoint } from "../lib/text-locate.js";
import { server } from "../registry.js";
import { dryRun, gridSession, persistGridSession, screenshotDirDefault } from "../runtime.js";

const execFileAsync = promisify(execFile);

server.registerTool(
  "click_wait_retry",
  {
    title: "Click Wait Retry",
    description: "Cycle: find text with OCR, click its center, wait, then verify expected text appears.",
    inputSchema: {
      clickText: z.string().min(1).max(120),
      expectText: z.string().min(1).max(120),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      maxAttempts: z.number().int().min(1).max(8).default(3),
      waitAfterClickMs: z.number().int().min(100).max(8000).default(1000),
      confidenceMin: z.number().min(0).max(100).default(35),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ clickText, expectText, target, monitorName, windowId, maxAttempts, waitAfterClickMs, confidenceMin }) => {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let lastAttempt = 0;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        lastAttempt = attempt;
        const clickFound = await performFindTextOnScreen({
          query: clickText,
          target,
          monitorName,
          windowId: windowId as WindowId | undefined,
          confidenceMin,
          limit: 1,
        });
        const match = clickFound.matches[0];
        if (!match) {
          if (attempt === maxAttempts) throw new HyprlandError("ACTION_TIMEOUT", `Could not find click text: ${clickText}`);
          await sleep(waitAfterClickMs);
          continue;
        }
        const cx = match.x + Math.floor(match.width / 2);
        const cy = match.y + Math.floor(match.height / 2);
        const resolved = await resolvePointerCoordinates(cx, cy, target, monitorName, windowId as WindowId | undefined);
        if (!dryRun) {
          await performMouseClick(resolved.x, resolved.y, "left", 80);
        }
        await sleep(waitAfterClickMs);
        const verifyFound = await performFindTextOnScreen({
          query: expectText,
          target,
          monitorName,
          windowId: windowId as WindowId | undefined,
          confidenceMin,
          limit: 1,
        });
        if (verifyFound.matches.length > 0) {
          await audit(
            "click_wait_retry",
            { clickText, expectText, target, attempt, x: resolved.x, y: resolved.y, success: true },
            dryRun,
            {
              startedAt,
              endedAt: new Date().toISOString(),
              status: "completed",
              result: "ok",
              durationMs: Date.now() - startedMs,
              attempt,
            },
          );
          return {
            content: [{ type: "text", text: JSON.stringify({ success: true, attempts: attempt, click: { x: resolved.x, y: resolved.y }, dryRun }, null, 2) }],
            structuredContent: { success: true, attempts: attempt, click: { x: resolved.x, y: resolved.y }, dryRun },
          };
        }
      }
      throw new HyprlandError("ACTION_TIMEOUT", `Expected text did not appear: ${expectText}`);
    } catch (error) {
      const code = error instanceof HyprlandError ? error.code : "ACTION_TIMEOUT";
      await audit(
        "click_wait_retry",
        {
          clickText,
          expectText,
          target,
          success: false,
          errorMessage: formatError(error),
        },
        dryRun,
        {
          startedAt,
          endedAt: new Date().toISOString(),
          status: "error",
          result: "error",
          errorCode: code,
          durationMs: Date.now() - startedMs,
          attempt: lastAttempt || null,
        },
      );
      throw error;
    }
  },
);

server.registerTool(
  "action_step",
  {
    title: "Action Step",
    description: "Atomic loop: capture before screenshot, perform one action, capture after screenshot, and verify outcome.",
    inputSchema: {
      action: z.enum(["click_text", "grid_click", "mouse_click", "key_press", "type_text"]),
      verify: z.enum(["none", "text_present", "text_absent"]).default("none"),
      taskId: z.string().min(1).max(128).optional(),
      stepId: z.string().min(1).max(128).optional(),
      target: z.enum(["full", "monitor", "active_window", "window"]).default("active_window"),
      monitorName: z.string().optional(),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      settleMs: z.number().int().min(0).max(5000).default(250),
      outputDir: z.string().optional(),
      filenamePrefix: z.string().min(1).max(64).default("action-step"),
      query: z.string().min(1).max(120).optional(),
      confidenceMin: z.number().min(0).max(100).default(35),
      matchIndex: z.number().int().min(0).max(20).default(0),
      offsetX: z.number().int().min(-500).max(500).default(0),
      offsetY: z.number().int().min(-500).max(500).default(0),
      button: z.enum(["left", "middle", "right"]).default("left"),
      cellId: z.number().int().min(1).optional(),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      key: z.string().min(1).max(32).optional(),
      modifiers: z.array(z.string().min(1).max(16)).max(4).default([]),
      repeat: z.number().int().min(1).max(20).default(1),
      text: z.string().min(1).max(4000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const dir = args.outputDir ?? screenshotDirDefault;
    await mkdir(dir, { recursive: true });
    const safePrefix = args.filenamePrefix.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let beforePath: string | null = null;
    let afterPath: string | null = null;
    let actionSummary: Record<string, unknown> = { action: args.action };
    let verification: Record<string, unknown> = { mode: args.verify };
    let verified = true;
    try {
      const before = await captureScreenshot({ target: args.target, monitorName: args.monitorName, windowId: args.windowId as WindowId | undefined });
      beforePath = join(dir, `${stamp}-${safePrefix}-before.png`);
      await writeFile(beforePath, before.png);

      if (args.action === "click_text") {
        if (!args.query) throw new HyprlandError("INPUT_FAILED", "query is required for action=click_text");
        const point = await resolveTextClickPoint({
          query: args.query,
          target: args.target,
          monitorName: args.monitorName,
          windowId: args.windowId as WindowId | undefined,
          confidenceMin: args.confidenceMin,
          matchIndex: args.matchIndex,
          offsetX: args.offsetX,
          offsetY: args.offsetY,
        });
        if (!dryRun) {
          await performMouseClick(point.absoluteX, point.absoluteY, args.button, 80);
        }
        actionSummary = { action: "click_text", query: args.query, button: args.button, absoluteX: point.absoluteX, absoluteY: point.absoluteY };
      } else if (args.action === "grid_click") {
        if (!args.cellId) throw new HyprlandError("INPUT_FAILED", "cellId is required for action=grid_click");
        if (!gridSession.current) throw new HyprlandError("WINDOW_NOT_FOUND", "No active grid session. Call grid_show first.");
        gridSession.current = await ensureGridSessionFresh(gridSession.current);
        persistGridSession(gridSession.current);
        const point = cellToRelativePoint(gridSession.current, args.cellId);
        const absX = gridSession.current.originAbsoluteX + point.x;
        const absY = gridSession.current.originAbsoluteY + point.y;
        if (!dryRun) {
          await performMouseClick(absX, absY, args.button, 80);
        }
        actionSummary = { action: "grid_click", cellId: args.cellId, button: args.button, absoluteX: absX, absoluteY: absY };
      } else if (args.action === "mouse_click") {
        if (typeof args.x !== "number" || typeof args.y !== "number") {
          throw new HyprlandError("INPUT_FAILED", "x and y are required for action=mouse_click");
        }
        const resolved = await resolvePointerCoordinates(args.x, args.y, args.target, args.monitorName, args.windowId as WindowId | undefined);
        if (!dryRun) {
          await performMouseClick(resolved.x, resolved.y, args.button, 80);
        }
        actionSummary = { action: "mouse_click", x: args.x, y: args.y, button: args.button, absoluteX: resolved.x, absoluteY: resolved.y };
      } else if (args.action === "key_press") {
        if (!args.key) throw new HyprlandError("INPUT_FAILED", "key is required for action=key_press");
        const safeKey = normalizeKey(args.key);
        const safeMods = normalizeModifiers(args.modifiers);
        if (!dryRun) {
          const modPart = toHyprShortcutMods(safeMods);
          const keyPart = toHyprShortcutKey(safeKey);
          for (let i = 0; i < args.repeat; i += 1) {
            await sendShortcut(modPart, keyPart);
            if (args.settleMs > 0 && i < args.repeat - 1) await sleep(args.settleMs);
          }
        }
        actionSummary = { action: "key_press", key: safeKey, modifiers: safeMods, repeat: args.repeat };
      } else if (args.action === "type_text") {
        if (!args.text) throw new HyprlandError("INPUT_FAILED", "text is required for action=type_text");
        const safeText = sanitizeTypedText(args.text);
        if (!dryRun) {
          if (!(await commandExists("wtype"))) throw new HyprlandError("INPUT_FAILED", "wtype is not installed");
          await execFileAsync("wtype", [safeText]);
        }
        actionSummary = { action: "type_text", textLength: safeText.length };
      }

      if (args.settleMs > 0) await sleep(args.settleMs);

      const after = await captureScreenshot({ target: args.target, monitorName: args.monitorName, windowId: args.windowId as WindowId | undefined });
      afterPath = join(dir, `${stamp}-${safePrefix}-after.png`);
      await writeFile(afterPath, after.png);

      if (args.verify !== "none") {
        if (!args.query) {
          throw new HyprlandError("INPUT_FAILED", "query is required for verify=text_present|text_absent");
        }
        const found = await performFindTextOnScreen({
          query: args.query,
          target: args.target,
          monitorName: args.monitorName,
          windowId: args.windowId as WindowId | undefined,
          confidenceMin: args.confidenceMin,
          limit: 1,
        });
        const present = found.matches.length > 0;
        verified = args.verify === "text_present" ? present : !present;
        verification = { mode: args.verify, query: args.query, present, matches: found.matches };
      }

      await audit(
        "action_step",
        {
          action: args.action,
          verify: args.verify,
          target: args.target,
          monitorName: args.monitorName ?? null,
          windowId: args.windowId ?? null,
          beforePath,
          afterPath,
          verified,
          actionSummary,
          verification,
        },
        dryRun,
        {
          taskId: args.taskId ?? null,
          stepId: args.stepId ?? null,
          startedAt,
          endedAt: new Date().toISOString(),
          status: verified ? "completed" : "error",
          result: verified ? "ok" : "error",
          durationMs: Date.now() - startedMs,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: verified, beforePath, afterPath, action: actionSummary, verification, dryRun }, null, 2),
          },
        ],
        structuredContent: { ok: verified, beforePath, afterPath, action: actionSummary, verification, dryRun },
      };
    } catch (error) {
      const errorCode = error instanceof HyprlandError ? error.code : "ACTION_TIMEOUT";
      await audit(
        "action_step",
        {
          action: args.action,
          verify: args.verify,
          target: args.target,
          monitorName: args.monitorName ?? null,
          windowId: args.windowId ?? null,
          beforePath,
          afterPath,
          verified: false,
          actionSummary,
          verification,
          errorMessage: formatError(error),
        },
        dryRun,
        {
          taskId: args.taskId ?? null,
          stepId: args.stepId ?? null,
          startedAt,
          endedAt: new Date().toISOString(),
          status: "error",
          result: "error",
          errorCode,
          durationMs: Date.now() - startedMs,
        },
      );
      throw error;
    }
  },
);
