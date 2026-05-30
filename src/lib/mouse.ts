import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HyprlandError, hyprctlDispatch } from "./hyprland.js";
import { commandExists, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

export async function performMouseMove(x: number, y: number): Promise<void> {
  await hyprctlDispatch("movecursor", `${x} ${y}`);
}

export async function performMouseClick(
  x: number,
  y: number,
  button: "left" | "middle" | "right",
  settleMs: number,
): Promise<void> {
  if (!(await commandExists("ydotool"))) {
    throw new HyprlandError("INPUT_FAILED", "ydotool is not installed");
  }
  const buttonCode = button === "left" ? "0xC0" : button === "middle" ? "0xC2" : "0xC1";
  await performMouseMove(x, y);
  if (settleMs > 0) await sleep(settleMs);
  await execFileAsync("ydotool", ["click", buttonCode]);
}

export async function performMouseScroll(axis: "vertical" | "horizontal", amount: number): Promise<void> {
  if (!(await commandExists("ydotool"))) {
    throw new HyprlandError("INPUT_FAILED", "ydotool is not installed");
  }
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
