import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const AUDIT_PATH = join(homedir(), ".local", "state", "saarthi", "audit.jsonl");

interface AuditEvent {
  timestamp: string;
  action: string;
  payload: Record<string, unknown>;
  dryRun: boolean;
  result?: "ok" | "error";
  errorCode?: string | null;
  durationMs?: number;
  requestId?: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}

export async function audit(
  action: string,
  payload: Record<string, unknown>,
  dryRun: boolean,
  extra?: {
    result?: "ok" | "error";
    errorCode?: string | null;
    durationMs?: number;
    requestId?: string;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
  },
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    action,
    payload,
    dryRun,
    result: extra?.result,
    errorCode: extra?.errorCode,
    durationMs: extra?.durationMs,
    requestId: extra?.requestId,
    beforeState: extra?.beforeState,
    afterState: extra?.afterState,
  };

  await mkdir(dirname(AUDIT_PATH), { recursive: true });
  await appendFile(AUDIT_PATH, `${JSON.stringify(event)}\n`, "utf8");
}
