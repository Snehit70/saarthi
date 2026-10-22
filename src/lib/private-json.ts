import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { HyprlandError } from "./hyprland.js";

/** Read through one descriptor, with a size bound even if the file grows. */
export async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077))
      throw new HyprlandError("INPUT_FAILED", "Plan/step file must be owned by you, private (chmod 600), regular, and at most 1 MiB");
    const data = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1024 * 1024) throw new HyprlandError("INPUT_FAILED", "Plan/step file exceeds 1 MiB");
    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally { await file.close(); }
}
