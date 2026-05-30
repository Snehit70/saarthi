import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Live status feed consumed by the desktop overlay HUD. Writing is best-effort
// and must never affect tool behavior, so every failure is swallowed and writes
// are fire-and-forget (never awaited by callers).

const STATUS_PATH = join(homedir(), ".local", "state", "saarthi", "status.json");
const STATUS_TMP = `${STATUS_PATH}.tmp`;
const MAX_STEPS = 6;
const ENABLED = process.env.SAARTHI_STATUS !== "0";

export type StepState = "running" | "done" | "error";
export type ToolKind = "read" | "act";

export interface Step {
  id: number;
  tool: string;
  label: string;
  kind: ToolKind;
  state: StepState;
  ts: string;
}

interface StatusSnapshot {
  schema: 1;
  sessionId: string;
  state: "active" | "idle";
  updatedAt: string;
  current: Step | null;
  recent: Step[];
}

let seq = 0;
const recent: Step[] = [];
let dirEnsured = false;

function sessionId(): string {
  return process.env.SAARTHI_SESSION_ID ?? "unknown";
}

async function flush(state: "active" | "idle"): Promise<void> {
  if (!ENABLED) return;
  const snapshot: StatusSnapshot = {
    schema: 1,
    sessionId: sessionId(),
    state,
    updatedAt: new Date().toISOString(),
    current: state === "active" ? recent[recent.length - 1] ?? null : null,
    recent: recent.slice(),
  };
  try {
    if (!dirEnsured) {
      await mkdir(dirname(STATUS_PATH), { recursive: true });
      dirEnsured = true;
    }
    await writeFile(STATUS_TMP, JSON.stringify(snapshot), "utf8");
    await rename(STATUS_TMP, STATUS_PATH);
  } catch {
    // best-effort; the overlay is optional
  }
}

/** Record that a tool call has started. Returns the step id for completion. */
export function emitActive(tool: string, kind: ToolKind, label: string): number {
  const step: Step = {
    id: seq++,
    tool,
    label,
    kind,
    state: "running",
    ts: new Date().toISOString(),
  };
  recent.push(step);
  while (recent.length > MAX_STEPS) recent.shift();
  void flush("active");
  return step.id;
}

/** Record that a previously started tool call has finished. */
export function emitDone(id: number, ok: boolean): void {
  const step = recent.find((s) => s.id === id);
  if (step) step.state = ok ? "done" : "error";
  void flush("idle");
}
