import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HyprlandError, cursorPosition, moveCursor } from "./hyprland.js";
import { commandExists, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

export type MouseButton = "left" | "middle" | "right";

// ydotool button codes: low bits select the button, 0x40 = press, 0x80 = release,
// 0xC0 = press+release (a click).
const BTN_BASE: Record<MouseButton, number> = { left: 0x00, right: 0x01, middle: 0x02 };
function buttonCode(button: MouseButton, kind: "click" | "down" | "up"): string {
  const mod = kind === "click" ? 0xc0 : kind === "down" ? 0x40 : 0x80;
  return "0x" + (BTN_BASE[button] | mod).toString(16).toUpperCase();
}

async function ensureYdotool(): Promise<void> {
  if (!(await commandExists("ydotool"))) {
    throw new HyprlandError("INPUT_FAILED", "ydotool is not installed");
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export async function performMouseMove(x: number, y: number): Promise<void> {
  await moveCursor(x, y);
}

/** Move the cursor from its current position to (x,y) along an eased path. */
export async function performEasedMove(x: number, y: number, steps: number, stepDelayMs: number): Promise<void> {
  let fromX = x;
  let fromY = y;
  try {
    const cur = await cursorPosition();
    fromX = cur.x;
    fromY = cur.y;
  } catch {
    // no cursor position available; fall back to a direct move
  }
  const n = Math.max(1, steps);
  for (let i = 1; i <= n; i += 1) {
    const t = easeInOut(i / n);
    const px = Math.round(fromX + (x - fromX) * t);
    const py = Math.round(fromY + (y - fromY) * t);
    await moveCursor(px, py);
    if (stepDelayMs > 0 && i < n) await sleep(stepDelayMs);
  }
}

export async function performMouseClick(
  x: number,
  y: number,
  button: MouseButton,
  settleMs: number,
  clickCount = 1,
): Promise<void> {
  await ensureYdotool();
  await performMouseMove(x, y);
  if (settleMs > 0) await sleep(settleMs);
  const count = Math.max(1, clickCount);
  for (let i = 0; i < count; i += 1) {
    await execFileAsync("ydotool", ["click", buttonCode(button, "click")]);
    if (i < count - 1) await sleep(45); // double/triple-click interval
  }
}

/** Press at (fromX,fromY), drag along an eased path to (toX,toY), then release. */
export async function performMouseDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  button: MouseButton,
  steps: number,
  stepDelayMs: number,
  settleMs: number,
): Promise<void> {
  await ensureYdotool();
  await performMouseMove(fromX, fromY);
  if (settleMs > 0) await sleep(settleMs);
  await execFileAsync("ydotool", ["click", buttonCode(button, "down")]);
  const n = Math.max(1, steps);
  for (let i = 1; i <= n; i += 1) {
    const t = easeInOut(i / n);
    const px = Math.round(fromX + (toX - fromX) * t);
    const py = Math.round(fromY + (toY - fromY) * t);
    await moveCursor(px, py);
    if (stepDelayMs > 0) await sleep(stepDelayMs);
  }
  if (settleMs > 0) await sleep(settleMs);
  await execFileAsync("ydotool", ["click", buttonCode(button, "up")]);
}

export async function performMouseScroll(axis: "vertical" | "horizontal", amount: number): Promise<void> {
  await ensureYdotool();
  // ydotool click wheel codes: 0xC4 wheel-up, 0xC5 wheel-down, 0xC6 wheel-left, 0xC7 wheel-right
  const steps = Math.min(50, Math.max(1, Math.abs(Math.trunc(amount))));
  let wheelCode = "0xC4";
  if (axis === "vertical") {
    wheelCode = amount >= 0 ? "0xC4" : "0xC5";
  } else {
    wheelCode = amount >= 0 ? "0xC7" : "0xC6";
  }
  await execFileAsync("ydotool", ["click", "--repeat", String(steps), wheelCode]);
}
