import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  if (process.env.SAARTHI_ROOT) return resolve(process.env.SAARTHI_ROOT);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../.."), resolve(here, "../../..")];
  const root = candidates.find((candidate) => existsSync(join(candidate, "config", "policy.json")));
  if (!root) throw new Error("Could not locate Saarthi project root; set SAARTHI_ROOT");
  return root;
}
