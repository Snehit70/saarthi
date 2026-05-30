import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HyprlandError } from "./hyprland.js";
import { commandExists } from "./util.js";

const execFileAsync = promisify(execFile);

export interface DiffResult {
  /** Normalised RMSE distance in [0,1]; 0 = identical. */
  normalized: number;
  /** Raw RMSE metric (unnormalised). */
  raw: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

// `magick compare -metric RMSE a b out` prints e.g. `8242.64 (0.125775)` to
// stderr, where the parenthetical is the normalised distance. It exits 0 when
// images are within fuzz, 1 when they differ (metric still printed), 2 on error.
function parse(stderr: string): DiffResult {
  const norm = stderr.match(/\(([\d.eE+-]+)\)/);
  const rawMatch = stderr.match(/^\s*([\d.eE+-]+)/);
  return {
    normalized: norm ? clamp01(Number(norm[1])) : 1,
    raw: rawMatch ? Number(rawMatch[1]) : Number.NaN,
  };
}

/**
 * Compare two PNG files and return a normalised difference score. Optionally
 * writes a visual diff image to `diffOut`.
 */
export async function comparePngFiles(a: string, b: string, diffOut?: string): Promise<DiffResult> {
  if (!(await commandExists("magick"))) {
    throw new HyprlandError("SCREENSHOT_FAILED", "ImageMagick (magick) is not installed");
  }
  const out = diffOut ?? "null:";
  const args = ["compare", "-metric", "RMSE", a, b, out];
  try {
    const { stderr } = await execFileAsync("magick", args);
    return parse(String(stderr)); // exit 0 (within fuzz)
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/\([\d.eE+-]+\)/.test(stderr)) return parse(stderr); // exit 1: differ, metric present
    if (/widths or heights differ/i.test(stderr)) return { normalized: 1, raw: Number.NaN };
    throw new HyprlandError("SCREENSHOT_FAILED", stderr.trim() || "image compare failed");
  }
}
