import { access, constants, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function toNumberOrNull(value: string | null): number | null {
  if (value === null) return null;
  if (!/^-?\d+$/.test(value.trim())) return null;
  return Number(value);
}

export function isNumericWorkspaceName(name: string): boolean {
  return /^\d+$/.test(name.trim());
}

export async function commandExists(cmd: string): Promise<boolean> {
  const candidates = cmd.includes("/")
    ? [cmd]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir || ".", cmd));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      /* Try the next PATH entry. Do not cache changing installations. */
    }
  }
  return false;
}

export async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
