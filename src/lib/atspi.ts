import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HyprlandError } from "./hyprland.js";
import { commandExists } from "./util.js";

const execFileAsync = promisify(execFile);

export interface UiElement {
  role: string;
  name: string;
  depth: number;
  path: number[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  cx?: number;
  cy?: number;
  states: string[];
  actions?: string[];
}

export interface AtspiResult {
  ok: boolean;
  mode: "tree" | "find";
  apps: Array<{ name: string; pid: number; children: number }>;
  elements: UiElement[];
  count: number;
  truncated: boolean;
}

export interface AtspiQuery {
  mode: "tree" | "find";
  focused?: boolean;
  pid?: number;
  appName?: string;
  role?: string;
  nameContains?: string;
  interactive?: boolean;
  includeOffscreen?: boolean;
  maxDepth: number;
  maxNodes: number;
}

function resolveScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../scripts/atspi_query.py"), // dist/src/lib -> repo root
    join(here, "../../scripts/atspi_query.py"), // src/lib (tsx) -> repo root
    join(process.cwd(), "scripts/atspi_query.py"),
    process.env.SAARTHI_ATSPI_SCRIPT ?? "",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new HyprlandError("ATSPI_FAILED", "atspi_query.py not found");
}

export async function queryAtspi(q: AtspiQuery): Promise<AtspiResult> {
  if (!(await commandExists("python3"))) {
    throw new HyprlandError("ATSPI_FAILED", "python3 is not installed");
  }
  const args = [resolveScript(), "--mode", q.mode];
  if (q.focused) args.push("--focused");
  if (typeof q.pid === "number") args.push("--pid", String(q.pid));
  if (q.appName) args.push("--app-name", q.appName);
  if (q.role) args.push("--role", q.role);
  if (q.nameContains) args.push("--name", q.nameContains);
  if (q.interactive) args.push("--interactive");
  if (q.includeOffscreen) args.push("--include-offscreen");
  args.push("--max-depth", String(q.maxDepth), "--max-nodes", String(q.maxNodes));

  let stdout: string;
  try {
    const res = await execFileAsync("python3", args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    stdout = String(res.stdout);
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; killed?: boolean };
    if (e.killed) throw new HyprlandError("ATSPI_FAILED", "AT-SPI query timed out");
    // the script prints {ok:false,error} then exits non-zero — surface that
    const payload = String(e.stdout ?? "").trim();
    if (payload) stdout = payload;
    else throw new HyprlandError("ATSPI_FAILED", String(e.stderr ?? "AT-SPI query failed").trim());
  }

  let parsed: AtspiResult;
  try {
    parsed = JSON.parse(stdout) as AtspiResult;
  } catch {
    throw new HyprlandError("ATSPI_FAILED", "AT-SPI query returned invalid output");
  }
  if (!parsed.ok) {
    throw new HyprlandError("ATSPI_FAILED", (parsed as unknown as { error?: string }).error ?? "AT-SPI query failed");
  }
  return parsed;
}
