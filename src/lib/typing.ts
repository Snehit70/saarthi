import { execFile } from "node:child_process";
import { sanitizeTypedText } from "./input.js";
import { HyprlandError } from "./hyprland.js";

// stdin keeps text out of process listings and prevents wtype option parsing.
export function typingTimeout(text: string, delayMs = 0): number {
  const safeText = sanitizeTypedText(text);
  const timeout = 10000 + Array.from(safeText).length * delayMs;
  if (!Number.isInteger(delayMs) || delayMs < 0 || timeout > 120000) {
    throw new HyprlandError("INPUT_FAILED", "Typing duration must fit within 120 seconds; reduce text length or delay");
  }
  return timeout;
}

export async function typeText(text: string, delayMs = 0): Promise<void> {
  const timeout = typingTimeout(text, delayMs);
  const safeText = sanitizeTypedText(text);
  await new Promise<void>((resolve, reject) => {
    const args = delayMs > 0 ? ["-d", String(delayMs), "-"] : ["-"];
    const child = execFile("wtype", args, { timeout, maxBuffer: 64 * 1024 }, (error) => {
      if (error)
        reject(
          new HyprlandError(
            "INPUT_FAILED",
            "wtype failed or timed out; check the Wayland session and wtype installation",
          ),
        );
      else resolve();
    });
    child.stdin?.on("error", () => {
      /* execFile reports process errors through its callback. */
    });
    child.stdin?.end(safeText);
  });
}
