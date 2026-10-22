import { open, realpath, stat } from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { BROWSERS, type BrowserId } from "./browser-catalog.js";
import { HyprlandError } from "./hyprland.js";

export interface NativeProfile {
  browser: BrowserId;
  directory: string;
  name: string;
  path: string;
  userDataDir: string;
  isLastUsed: boolean;
  source: string;
}
const roots: Partial<Record<BrowserId, string[]>> = {
  helium: ["net.imput.helium", "helium"],
  chrome: ["google-chrome", "google-chrome-beta", "google-chrome-unstable"],
  chromium: ["chromium"],
  brave: ["BraveSoftware/Brave-Browser"],
  vivaldi: ["vivaldi"],
  edge: ["microsoft-edge"],
};
async function boundedJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.size > 8 * 1024 * 1024
    )
      throw new Error("Invalid browser profile metadata");
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 8 * 1024 * 1024)
      throw new Error("Profile metadata exceeds 8 MiB");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await file.close();
  }
}
export async function discoverBrowserProfiles(
  browser: BrowserId,
  configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
): Promise<NativeProfile[]> {
  if (!isAbsolute(configRoot))
    throw new HyprlandError(
      "INPUT_FAILED",
      "Browser config root must be absolute",
    );
  const output: NativeProfile[] = [];
  const seen = new Set<string>();
  for (const suffix of roots[browser] ?? []) {
    const root = join(configRoot, suffix),
      source = join(root, "Local State");
    let data;
    try {
      data = await boundedJson(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const profile = (
      data as {
        profile?: {
          info_cache?: Record<string, { name?: unknown }>;
          last_used?: unknown;
        };
      }
    ).profile;
    if (!profile?.info_cache || typeof profile.info_cache !== "object")
      continue;
    for (const [directory, entry] of Object.entries(profile.info_cache)) {
      if (
        !directory ||
        directory !== basename(directory) ||
        directory === "." ||
        directory === ".." ||
        /[\x00-\x1f]/.test(directory)
      )
        continue;
      const path = join(root, directory);
      try {
        if (
          !(await stat(path)).isDirectory() ||
          (await realpath(path)) !== path
        )
          continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      output.push({
        browser,
        directory,
        name: typeof entry.name === "string" ? entry.name : directory,
        path,
        userDataDir: root,
        isLastUsed: profile.last_used === directory,
        source,
      });
    }
  }
  return output.sort(
    (a, b) =>
      a.directory.localeCompare(b.directory, "en", { numeric: true }) ||
      a.userDataDir.localeCompare(b.userDataDir),
  );
}
export async function resolveBrowserProfile(
  browser: BrowserId,
  selector: string,
): Promise<NativeProfile> {
  if (BROWSERS.find((row) => row.id === browser)?.family !== "chromium")
    throw new HyprlandError(
      "INPUT_FAILED",
      "Explicit native profile selection currently supports Chromium-family browsers; use the browser adapter for other profiles",
    );
  const profiles = await discoverBrowserProfiles(browser);
  const exact = profiles.filter((profile) => profile.directory === selector);
  const matches = exact.length
    ? exact
    : profiles.filter(
        (profile) => profile.name.toLowerCase() === selector.toLowerCase(),
      );
  if (matches.length !== 1)
    throw new HyprlandError(
      "INPUT_FAILED",
      matches.length
        ? "Profile name is ambiguous; use an exact directory from browser profiles"
        : "Unknown browser profile; run browser profiles and use its exact directory or display name. Numeric position is not a profile identity",
    );
  return matches[0];
}
