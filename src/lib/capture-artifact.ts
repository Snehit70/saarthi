import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { screenshotDirDefault } from "../runtime.js";

export async function persistCapture(result: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Buffer.isBuffer(result.png)) return result;
  const png = result.png;
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (png.length < 24 || !png.subarray(0,8).equals(signature) || png.toString("ascii",12,16) !== "IHDR")
    throw new Error("Browser did not return a PNG");
  await mkdir(screenshotDirDefault, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(screenshotDirDefault, "background-"));
  const path = join(directory, "capture.png");
  await writeFile(path, png, { mode: 0o600 });
  const { png: _, ...metadata } = result;
  return { ...metadata, path, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
