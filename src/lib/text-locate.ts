import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { HyprlandError } from "./hyprland.js";
import { captureScreenshot } from "./screenshot.js";
import { parseTesseractTsv } from "./ocr.js";
import type { TextMatch } from "./ocr.js";
import { resolvePointerCoordinates } from "./pointer.js";
import type { PointerTarget } from "./pointer.js";
import { commandExists } from "./util.js";
import type { WindowId } from "./types.js";

const execFileAsync = promisify(execFile);

export async function performFindTextOnScreen(input: {
  query: string;
  target: "full" | "monitor" | "active_window" | "window";
  monitorName?: string;
  windowId?: WindowId;
  confidenceMin: number;
  limit: number;
}): Promise<{ matches: TextMatch[]; width: number; height: number; target: string }> {
  if (!(await commandExists("tesseract"))) {
    throw new HyprlandError("OCR_FAILED", "tesseract is not installed");
  }
  const shot = await captureScreenshot({ target: input.target, monitorName: input.monitorName, windowId: input.windowId });
  const tempDir = await mkdtemp(join(tmpdir(), "saarthi-ocr-"));
  const imagePath = join(tempDir, "screen.png");
  try {
    await writeFile(imagePath, shot.png);
    const { stdout, stderr } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "6", "tsv"]);
    if (stderr && String(stderr).trim()) {
      throw new HyprlandError("OCR_FAILED", String(stderr).trim());
    }
    const needle = input.query.toLowerCase();
    const words = parseTesseractTsv(String(stdout))
      .filter((w) => w.confidence >= input.confidenceMin)
      .filter((w) => w.text.toLowerCase().includes(needle))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, input.limit);
    return { matches: words, width: shot.width, height: shot.height, target: shot.target };
  } catch (error) {
    if (error instanceof HyprlandError) throw error;
    throw new HyprlandError("OCR_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function resolveTextClickPoint(input: {
  query: string;
  target: PointerTarget;
  monitorName?: string;
  windowId?: WindowId;
  confidenceMin: number;
  matchIndex: number;
  offsetX: number;
  offsetY: number;
}): Promise<{
  match: TextMatch;
  absoluteX: number;
  absoluteY: number;
  relativeX: number;
  relativeY: number;
  target: PointerTarget;
}> {
  const found = await performFindTextOnScreen({
    query: input.query,
    target: input.target,
    monitorName: input.monitorName,
    windowId: input.windowId,
    confidenceMin: input.confidenceMin,
    limit: Math.max(1, input.matchIndex + 1),
  });
  const match = found.matches[input.matchIndex];
  if (!match) {
    throw new HyprlandError("OCR_FAILED", `No OCR match for '${input.query}' at index ${input.matchIndex}`);
  }

  const relativeX = match.x + Math.floor(match.width / 2) + input.offsetX;
  const relativeY = match.y + Math.floor(match.height / 2) + input.offsetY;
  const resolved = await resolvePointerCoordinates(relativeX, relativeY, input.target, input.monitorName, input.windowId);
  return {
    match,
    absoluteX: resolved.x,
    absoluteY: resolved.y,
    relativeX,
    relativeY,
    target: input.target,
  };
}
