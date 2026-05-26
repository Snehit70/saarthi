import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const AUDIT_PATH = join(homedir(), ".local", "state", "saarthi", "audit.jsonl");

interface AuditEvent {
  timestamp: string;
  sessionId: string | null;
  taskId?: string | null;
  stepId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status?: "started" | "completed" | "error";
  action: string;
  payload: Record<string, unknown>;
  dryRun: boolean;
  result?: "ok" | "error";
  errorCode?: string | null;
  durationMs?: number;
  requestId?: string;
  attempt?: number | null;
  retryOf?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}

export async function audit(
  action: string,
  payload: Record<string, unknown>,
  dryRun: boolean,
  extra?: {
    taskId?: string | null;
    stepId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    status?: "started" | "completed" | "error";
    result?: "ok" | "error";
    errorCode?: string | null;
    durationMs?: number;
    requestId?: string;
    attempt?: number | null;
    retryOf?: string | null;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const event: AuditEvent = {
    timestamp: now,
    sessionId: process.env.SAARTHI_SESSION_ID ?? null,
    taskId: extra?.taskId ?? null,
    stepId: extra?.stepId ?? null,
    startedAt: extra?.startedAt ?? now,
    endedAt: extra?.endedAt ?? now,
    status: extra?.status ?? "completed",
    action,
    payload,
    dryRun,
    result: extra?.result,
    errorCode: extra?.errorCode,
    durationMs: extra?.durationMs,
    requestId: extra?.requestId,
    attempt: extra?.attempt,
    retryOf: extra?.retryOf ?? null,
    beforeState: extra?.beforeState,
    afterState: extra?.afterState,
  };

  await mkdir(dirname(AUDIT_PATH), { recursive: true });
  await appendFile(AUDIT_PATH, `${JSON.stringify(event)}\n`, "utf8");
}
