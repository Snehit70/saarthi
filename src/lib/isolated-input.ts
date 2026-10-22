import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import {
  desktopRequest,
  desktopWindows,
  assertDesktop,
  type DesktopRecord,
  type DesktopWindow,
} from "./isolated-desktop.js";
import {
  isolatedEnvironment,
  isolatedRuntime,
} from "./isolated-environment.js";
import { projectRoot } from "./paths.js";
import {
  normalizeKey,
  normalizeModifiers,
  sanitizeTypedText,
} from "./input.js";
import { inputOwnershipSignal } from "./input-ownership.js";
import { HyprlandError } from "./hyprland.js";
import { privateKeyboard } from "./isolated-keyboard.js";
import { audit } from "./audit.js";
import { recordStepStart, recordStepDone } from "./status.js";

const run = promisify(execFile);
export const isolatedActionSchema = z
  .object({
    action: z.enum(["focus", "move", "click", "drag", "scroll", "type", "key"]),
    windowId: z.number().int().positive(),
    pid: z.number().int().positive(),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    endX: z.number().int().min(0).optional(),
    endY: z.number().int().min(0).optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clicks: z.number().int().min(1).max(2).default(1),
    durationMs: z.number().int().min(100).max(2000).default(200),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    steps: z.number().int().min(1).max(20).default(3),
    text: z.string().min(1).max(4000).optional(),
    key: z.string().min(1).max(30).optional(),
    modifiers: z.array(z.string()).max(4).default([]),
    confirmed: z.boolean().default(false),
    actionKind: z
      .enum(["edit", "navigate", "send", "submit", "delete", "payment"])
      .default("edit"),
  })
  .strict();
export type IsolatedAction = z.infer<typeof isolatedActionSchema>;
export function validateIsolatedActions(
  raw: unknown,
  desktop: Pick<DesktopRecord, "width" | "height">,
): IsolatedAction[] {
  const actions = z.array(isolatedActionSchema).min(1).max(10).parse(raw);
  for (const action of actions) {
    if (["move", "click", "drag", "scroll"].includes(action.action)) {
      if (
        action.x === undefined ||
        action.y === undefined ||
        action.x >= desktop.width ||
        action.y >= desktop.height
      )
        throw new HyprlandError(
          "INPUT_FAILED",
          "Pointer coordinates must fit the isolated desktop",
        );
    } else if (action.x !== undefined || action.y !== undefined)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Coordinates only apply to pointer actions",
      );
    if (
      action.action === "drag" &&
      (action.endX === undefined ||
        action.endY === undefined ||
        action.endX >= desktop.width ||
        action.endY >= desktop.height)
    )
      throw new HyprlandError(
        "INPUT_FAILED",
        "Drag endpoint must fit the isolated desktop",
      );
    if (
      action.action !== "drag" &&
      (action.endX !== undefined || action.endY !== undefined)
    )
      throw new HyprlandError("INPUT_FAILED", "Only drag accepts an endpoint");
    if (action.action === "scroll" && !action.direction)
      throw new HyprlandError("INPUT_FAILED", "Scroll requires direction");
    if (action.action === "type") {
      if (action.text === undefined)
        throw new HyprlandError("INPUT_FAILED", "Typing requires text");
      sanitizeTypedText(action.text);
      if (/[\r\n\t]/.test(action.text))
        throw new HyprlandError(
          "INPUT_FAILED",
          "Use explicit key actions for Enter/Tab; typed text must not dispatch shortcuts",
        );
    } else if (action.text !== undefined)
      throw new HyprlandError("INPUT_FAILED", "Only typing accepts text");
    if (action.action === "key") {
      if (!action.key)
        throw new HyprlandError("INPUT_FAILED", "Key action requires a key");
      action.key = normalizeKey(action.key);
      action.modifiers = normalizeModifiers(action.modifiers);
      if (
        !action.confirmed &&
        (action.key === "enter" || action.key === "delete") &&
        action.actionKind !== "navigate"
      )
        throw new HyprlandError(
          "INPUT_FAILED",
          "Enter/Delete require confirmed=true or an explicit navigation action kind",
        );
    } else if (action.key !== undefined || action.modifiers.length)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Only key actions accept key/modifiers",
      );
    if (
      ["click", "key"].includes(action.action) &&
      !action.confirmed &&
      ["send", "submit", "delete", "payment"].includes(action.actionKind)
    )
      throw new HyprlandError(
        "INPUT_FAILED",
        "This action requires confirmation",
      );
  }
  return actions;
}
async function target(
  record: DesktopRecord,
  action: IsolatedAction,
  requireFocus = true,
): Promise<DesktopWindow> {
  const window = (await desktopWindows(record)).find(
    (window) => window.id === action.windowId && window.pid === action.pid,
  );
  if (!window || (requireFocus && !window.focused))
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private window identity/focus changed; inspect before acting",
    );
  return window;
}
export function pointInside(
  window: DesktopWindow,
  x: number,
  y: number,
): boolean {
  return (
    x >= window.rect.x &&
    y >= window.rect.y &&
    x < window.rect.x + window.rect.width &&
    y < window.rect.y + window.rect.height
  );
}
const keyCodes: Record<string, number> = {
  enter: 28,
  tab: 15,
  escape: 1,
  backspace: 14,
  delete: 111,
  left: 105,
  right: 106,
  up: 103,
  down: 108,
  home: 102,
  end: 107,
  page_up: 104,
  page_down: 109,
  f5: 63,
};
for (const [letters, start] of [
  ["qwertyuiop", 16],
  ["asdfghjkl", 30],
  ["zxcvbnm", 44],
  ["123456789", 2],
] as const)
  [...letters].forEach((letter, index) => {
    keyCodes[letter] = start + index;
  });
keyCodes["0"] = 11;
export async function performIsolatedAction(
  record: DesktopRecord,
  action: IsolatedAction,
): Promise<Record<string, unknown>> {
  if (record.inputBlocked)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private keyboard action is unresolved; inspect, then stop and recreate this desktop",
    );
  if (inputOwnershipSignal()?.aborted)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private desktop input lease was lost",
    );
  if (action.action === "focus") {
    await target(record, action, false);
    await desktopRequest(record, 0, `[con_id=${action.windowId}] focus`);
    await target(record, action, true);
    return { focused: true };
  }
  const window = await target(record, action);
  if (action.action === "type")
    await privateKeyboard(record, ["type"], action.text!);
  else if (action.action === "key") {
    const modifiers = action.modifiers.reduce(
      (bits, mod) => bits | ({ ctrl: 1, alt: 2, shift: 4, super: 8 }[mod] ?? 0),
      0,
    );
    await privateKeyboard(record, [
      "key",
      String(keyCodes[action.key!]),
      String(modifiers),
    ]);
  } else {
    if (
      !pointInside(window, action.x!, action.y!) ||
      (action.action === "drag" &&
        !pointInside(window, action.endX!, action.endY!))
    )
      throw new HyprlandError(
        "INPUT_FAILED",
        "Pointer target is outside the declared private window",
      );
    const args = [
      join(isolatedRuntime(record.id), record.display),
      String(record.width),
      String(record.height),
      action.action,
      String(action.x),
      String(action.y),
    ];
    if (action.action === "click")
      args.push(
        String({ left: 272, right: 273, middle: 274 }[action.button]),
        String(action.clicks),
      );
    if (action.action === "drag")
      args.push(
        String(action.endX),
        String(action.endY),
        String(action.durationMs),
      );
    if (action.action === "scroll")
      args.push(action.direction!, String(action.steps));
    try {
      await run(join(projectRoot(), "dist/native/pointer"), args, {
        env: isolatedEnvironment(record.id, record.display),
        timeout: 5000,
        maxBuffer: 65536,
        signal: inputOwnershipSignal(),
      });
    } catch {
      await desktopRequest(
        record,
        0,
        "seat seat0 cursor release button1",
      ).catch(() => {});
      throw new HyprlandError(
        "INPUT_FAILED",
        "Private virtual pointer failed; inspect before retrying",
      );
    }
  }
  await assertDesktop(record);
  return { acted: true, verificationRequired: true };
}
export async function runIsolatedActions(
  record: DesktopRecord,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const actions = validateIsolatedActions(raw, record);
  let completedSteps = 0;
  const results: Record<string, unknown>[] = [];
  for (const action of actions) {
    const payload = {
      desktopId: record.id,
      index: completedSteps,
      action: action.action,
      windowId: action.windowId,
      pid: action.pid,
      textLength: action.text?.length,
    };
    const step = recordStepStart(
      `desktop_${action.action}`,
      "act",
      `Isolated desktop: ${action.action}`,
    );
    await audit("desktop_input_step", payload, false, { status: "started" });
    try {
      const result = await performIsolatedAction(record, action);
      results.push(result);
      completedSteps++;
      recordStepDone(step, true);
      await audit("desktop_input_step", payload, false, { result: "ok" });
    } catch (error) {
      recordStepDone(step, false);
      await audit("desktop_input_step", payload, false, {
        result: "error",
        errorCode: "INPUT_FAILED",
      });
      throw Object.assign(
        new HyprlandError(
          "INPUT_FAILED",
          "Isolated input stopped; inspect before preparing remaining actions",
        ),
        {
          details: {
            completedSteps,
            inFlightStep: completedSteps,
            totalSteps: actions.length,
            reason: error instanceof Error ? error.message : "Operation failed",
          },
        },
      );
    }
  }
  return {
    desktopId: record.id,
    completedSteps,
    results,
    verificationRequired: true,
    hostInputRequested: false,
  };
}
