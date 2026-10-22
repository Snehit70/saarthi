import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { imageMime } from "./clipboard.js";
import { HyprlandError } from "./hyprland.js";

export interface FileSearch {
  directory: string;
  nameContains: string;
  type: "any" | "image";
  maxDepth: number;
  limit: number;
  maxVisited: number;
}
export async function findFiles(
  query: FileSearch,
): Promise<Record<string, unknown>> {
  const start = performance.now(),
    directory = await realpath(query.directory);
  if (!(await lstat(directory)).isDirectory())
    throw new HyprlandError("INPUT_FAILED", "Search root must be a directory");
  const needle=query.nameContains.toLowerCase();
  const queue = [{ path: directory, depth: 0 }];
  const files: Array<Record<string, unknown>> = [];
  let visited = 0,
    matches = 0,
    truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const entries = await opendir(current.path,{bufferSize:512});
    try {
      for await (const entry of entries) {
        if (visited >= query.maxVisited) {
          truncated = true;
          break;
        }
        visited++;
        const path = join(current.path, entry.name);
        // Never traverse symlinked folders or select links outside the root.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && current.depth < query.maxDepth) {
          queue.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (
          !entry.isFile() ||
          !entry.name
            .toLowerCase()
            .includes(needle)
        )
          continue;
        let file;
        try {
          file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if (
            ["ENOENT", "ELOOP"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
        try {
          const stat = await file.stat();
          if (!stat.isFile()) continue;
          let mime: string | undefined;
          if (query.type === "image") {
            const header = Buffer.alloc(16);
            const { bytesRead } = await file.read(header, 0, 16, 0);
            try {
              mime = imageMime(header.subarray(0, bytesRead)).mime;
            } catch {
              continue;
            }
          }
          matches++;
          if (files.length < query.limit)
            files.push({
              name: entry.name,
              path,
              relativePath: relative(directory, path),
              bytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              mime,
              device: String(stat.dev),
              inode: String(stat.ino),
            });
        } finally {
          await file.close();
        }
      }
    } finally {
      await entries.close().catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
          throw error;
      });
    }
    if (truncated) break;
  }
  files.sort((a, b) =>
    String(a.relativePath).localeCompare(String(b.relativePath), "en", {
      numeric: true,
    }),
  );
  return {
    directory,
    files,
    matches,
    visited,
    complete: !truncated,
    truncated: truncated || matches > query.limit,
    limit: query.limit,
    elapsedMs: Math.round(performance.now() - start),
  };
}
