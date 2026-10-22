import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HyprlandError, assertWindowFocus } from "./hyprland.js";
import { statePath } from "./state.js";
import { performUiAction } from "./ui-action.js";
import { sendShortcut } from "./hyprland.js";
import type { WindowId } from "./types.js";
import { sleep } from "./util.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export interface ClipboardImage {
  id: string;
  format: string;
  width: number;
  height: number;
}
export interface ExportedClipboardImage extends ClipboardImage {
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}

function clipboardProcess(
  command: "cliphist" | "wl-paste" | "wl-copy",
  args: string[],
  input?: Buffer,
  maxBuffer = MAX_IMAGE_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 5000, encoding: "buffer", maxBuffer }, (error, stdout, stderr) => {
      if (
        error &&
        command === "wl-paste" &&
        args[0] === "--list-types" &&
        error.code === 1 &&
        String(stderr).trim() === "Nothing is copied"
      )
        resolve(Buffer.alloc(0));
      else if (error)
        reject(new HyprlandError("INPUT_FAILED", `${command} failed or timed out; check clipboard availability`));
      else resolve(Buffer.from(stdout));
    });
    child.stdin?.on("error", () => {});
    // wl-copy forks a selection owner. Its inherited output pipes must not
    // keep execFile waiting until the timeout after the launcher has exited.
    if (command === "wl-copy")
      child.once("exit", () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    child.stdin?.end(input);
  });
}

export function parseImageHistory(text: string): ClipboardImage[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\d+)\t\[\[ binary data .+?\s(png|jpeg|jpg|gif|webp|bmp)\s+(\d+)x(\d+)\s*\]\]$/i);
    if (!match) return [];
    const width = Number(match[3]),
      height = Number(match[4]);
    return width > 0 && height > 0 ? [{ id: match[1], format: match[2].toLowerCase(), width, height }] : [];
  });
}

export function imageMime(data: Buffer): { mime: string; extension: string } {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", extension: "png" };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" };
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return { mime: "image/gif", extension: "gif" };
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP")
    return { mime: "image/webp", extension: "webp" };
  if (data.subarray(0, 2).toString() === "BM") return { mime: "image/bmp", extension: "bmp" };
  throw new HyprlandError("INPUT_FAILED", "Clipboard history entry is not a supported image");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export async function listClipboardImages(limit = 10): Promise<ClipboardImage[]> {
  return parseImageHistory((await clipboardProcess("cliphist", ["list"], undefined, 4 * 1024 * 1024)).toString()).slice(
    0,
    limit,
  );
}

export async function exportClipboardImages(count: number, ids?: string[]): Promise<ExportedClipboardImage[]> {
  const history = await listClipboardImages(10000);
  const selected = ids ? ids.map((id) => history.find((image) => image.id === id)) : history.slice(0, count);
  if (selected.length !== count || selected.some((image) => !image))
    throw new HyprlandError("INPUT_FAILED", `Expected ${count} available clipboard images`);
  if (new Set(selected.map((image) => image!.id)).size !== count)
    throw new HyprlandError("INPUT_FAILED", "Clipboard image ids must be unique");
  const root = statePath("clipboard-exports");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "images-"));
  const output: ExportedClipboardImage[] = [];
  for (const image of selected) {
    const data = await clipboardProcess("cliphist", ["decode"], Buffer.from(image!.id));
    const format = imageMime(data);
    const path = join(directory, `${output.length + 1}-${image!.id}.${format.extension}`);
    await writeFile(path, data, { mode: 0o600, flag: "wx" });
    output.push({ ...image!, ...format, path, sha256: sha256(data), bytes: data.length });
  }
  return output;
}

export async function assertClipboardDestination(windowId: WindowId, targetName: string): Promise<void> {
  await performUiAction({ windowId, name: targetName, action: "inspect", requireFocusedEditable: true });
}

export async function pasteClipboardImages(args: {
  windowId: WindowId;
  targetName: string;
  count: number;
  ids?: string[];
  settleMs: number;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const started = Date.now();
  let validationMs = 0;
  const validate = async () => {
    const start = Date.now();
    await assertClipboardDestination(args.windowId, args.targetName);
    validationMs += Date.now() - start;
  };
  await validate();
  const images = await exportClipboardImages(args.count, args.ids);
  if (args.dryRun) return { sentImages: 0, dryRun: true, images, verificationRequired: true };
  const offeredTypes = (await clipboardProcess("wl-paste", ["--list-types"], undefined, 65536))
    .toString()
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const originalMime =
    offeredTypes.find((type) => type === "image/png") ??
    offeredTypes.find((type) => type.startsWith("text/plain")) ??
    offeredTypes[0];
  if (originalMime?.startsWith("x-kde-passwordManagerHint"))
    throw new HyprlandError("INPUT_FAILED", "Cannot snapshot the current clipboard selection");
  const original = originalMime
    ? await clipboardProcess("wl-paste", ["--no-newline", "--type", originalMime])
    : undefined;
  let lastInjected: ExportedClipboardImage | undefined;
  let sentImages = 0;
  let restored = false;
  try {
    for (const image of images) {
      if (lastInjected) {
        const current = await clipboardProcess("wl-paste", ["--no-newline", "--type", lastInjected.mime]).catch(
          () => null,
        );
        if (!current || sha256(current) !== lastInjected.sha256)
          throw new HyprlandError(
            "INPUT_FAILED",
            "Clipboard changed during the workflow; stopped before replacing the new selection",
          );
      }
      await assertWindowFocus(args.windowId);
      const { readFile } = await import("node:fs/promises");
      await clipboardProcess("wl-copy", ["--type", image.mime], await readFile(image.path));
      lastInjected = image;
      const selected = await clipboardProcess("wl-paste", ["--no-newline", "--type", image.mime]);
      if (sha256(selected) !== image.sha256)
        throw new HyprlandError("INPUT_FAILED", "Clipboard selection changed before paste");
      await validate();
      await sendShortcut("CTRL", "V");
      sentImages += 1;
      if (args.settleMs) await sleep(args.settleMs);
    }
  } finally {
    if (lastInjected) {
      const current = await clipboardProcess("wl-paste", ["--no-newline", "--type", lastInjected.mime]).catch(
        () => null,
      );
      if (current && sha256(current) === lastInjected.sha256) {
        await clipboardProcess("wl-copy", originalMime ? ["--type", originalMime] : ["--clear"], original);
        restored = true;
      }
    }
  }
  return {
    sentImages,
    images,
    clipboardRestored: restored,
    restoredMime: restored ? (originalMime ?? null) : null,
    originalTypes: offeredTypes,
    timings: { totalMs: Date.now() - started, validationMs },
    verificationRequired: true,
  };
}
