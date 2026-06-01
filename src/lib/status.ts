import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Live status feed consumed by the desktop overlay HUD. Writing is best-effort
// and must never affect tool behavior, so every failure is swallowed and writes
// are fire-and-forget (never awaited by callers).

const STATUS_PATH = join(homedir(), ".local", "state", "saarthi", "status.json");
const MAX_STEPS = 25;
const ENABLED = process.env.SAARTHI_STATUS !== "0";

export type StepState = "running" | "done" | "error";
export type ToolKind = "read" | "act";
export type TaskState = "working" | "waiting" | "dormant_waiting" | "complete" | "error" | "timeout";
export type TaskCompleteStatus = "done" | "error" | "timeout";

export interface Step {
  id: number;
  tool: string;
  label: string;
  kind: ToolKind;
  state: StepState;
  ts: string;
}

interface StatusSnapshot {
  schema: 2;
  sessionId: string;
  state: "active" | "idle";
  updatedAt: string;
  task: Task | null;
  current: Step | null;
  recent: Step[];
}

interface TaskStats {
  steps: number;
  reads: number;
  acts: number;
  errors: number;
  retries: number;
}

export interface Task {
  id: string;
  label: string;
  state: TaskState;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  seed: number;
  stats: TaskStats;
}

let seq = 0;
let tmpSeq = 0;
const recent: Step[] = [];
const running = new Set<number>();
let task: Task | null = null;
let dirEnsured = false;
let flushChain: Promise<void> = Promise.resolve();

function sessionId(): string {
  return process.env.SAARTHI_SESSION_ID ?? "unknown";
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTaskId(): string {
  return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function makeTaskSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function blankStats(): TaskStats {
  return { steps: 0, reads: 0, acts: 0, errors: 0, retries: 0 };
}

function isActive(t: Task | null): t is Task {
  return t !== null && t.state !== "complete" && t.state !== "error" && t.state !== "timeout";
}

function clearSteps(): void {
  recent.length = 0;
  running.clear();
}

/** Build a brand-new task in its starting (waiting, no steps) state. */
function freshTask(label: string): Task {
  const id = makeTaskId();
  const ts = nowIso();
  return {
    id,
    label,
    state: "waiting",
    startedAt: ts,
    updatedAt: ts,
    completedAt: null,
    seed: makeTaskSeed(`${sessionId()}:${id}:${label}`),
    stats: blankStats(),
  };
}

/** Return the live task, or start a fresh one when none is active. */
function ensureTask(label = "desktop task"): Task {
  if (isActive(task)) return task;
  task = freshTask(label);
  clearSteps();
  return task;
}

function currentStep(): Step | null {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const step = recent[i];
    if (step && step.state === "running") return step;
  }
  return null;
}

function topLevelState(): "active" | "idle" {
  return isActive(task) ? "active" : "idle";
}

async function writeSnapshot(snapshot: StatusSnapshot): Promise<void> {
  try {
    if (!dirEnsured) {
      await mkdir(dirname(STATUS_PATH), { recursive: true });
      dirEnsured = true;
    }
    // Unique temp per write so a write never clobbers another's temp file; each
    // rename is atomic.
    const tmp = `${STATUS_PATH}.${process.pid}.${(tmpSeq += 1)}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), "utf8");
    await rename(tmp, STATUS_PATH);
  } catch {
    // best-effort; the overlay is optional
  }
}

function flush(): void {
  if (!ENABLED) return;
  // Snapshot the state synchronously at call time, then serialize the IO on a
  // single chain. Flushes are fire-and-forget, so without serialization their
  // renames can land out of call order and a stale snapshot (e.g. a step still
  // "running") could overwrite a newer one ("done"/"error"). Chaining keeps the
  // on-disk file consistent with the last logical state.
  const snapshot: StatusSnapshot = {
    schema: 2,
    sessionId: sessionId(),
    state: topLevelState(),
    updatedAt: nowIso(),
    task: task ? { ...task, stats: { ...task.stats } } : null,
    current: currentStep(),
    recent: recent.slice(),
  };
  flushChain = flushChain.then(() => writeSnapshot(snapshot));
}

export function startTask(label = "desktop task"): Task {
  // An explicit start always begins a clean task, even if one was mid-flight.
  task = freshTask(label);
  clearSteps();
  void flush();
  return task;
}

export function pingTask(state: Extract<TaskState, "waiting" | "dormant_waiting"> = "waiting"): Task {
  const activeTask = ensureTask();
  activeTask.state = running.size > 0 ? "working" : state;
  activeTask.updatedAt = nowIso();
  void flush();
  return activeTask;
}

export function completeTask(status: TaskCompleteStatus = "done"): Task {
  const activeTask = ensureTask();
  const ts = nowIso();
  activeTask.state = status === "done" ? "complete" : status;
  activeTask.updatedAt = ts;
  activeTask.completedAt = ts;
  running.clear();
  void flush();
  return activeTask;
}

/** Record that a tool call has started. Returns the step id for completion. */
export function recordStepStart(tool: string, kind: ToolKind, label: string): number {
  const activeTask = ensureTask("desktop task");
  const step: Step = {
    id: seq++,
    tool,
    label,
    kind,
    state: "running",
    ts: nowIso(),
  };
  recent.push(step);
  while (recent.length > MAX_STEPS) recent.shift();
  running.add(step.id);
  activeTask.state = "working";
  activeTask.updatedAt = step.ts;
  activeTask.stats.steps += 1;
  if (kind === "read") activeTask.stats.reads += 1;
  if (kind === "act") activeTask.stats.acts += 1;
  if (label.toLowerCase().includes("retry") || tool.toLowerCase().includes("retry")) activeTask.stats.retries += 1;
  void flush();
  return step.id;
}

/** Record that a previously started tool call has finished. */
export function recordStepDone(id: number, ok: boolean): void {
  const step = recent.find((s) => s.id === id);
  if (step) step.state = ok ? "done" : "error";
  running.delete(id);
  if (isActive(task)) {
    if (!ok) task.stats.errors += 1;
    task.state = running.size > 0 ? "working" : "waiting";
    task.updatedAt = nowIso();
  }
  void flush();
}

export const emitActive = recordStepStart;
export const emitDone = recordStepDone;
