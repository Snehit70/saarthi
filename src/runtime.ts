import { join } from "node:path";
import { homedir } from "node:os";
import { loadPolicyConfig } from "./lib/policy.js";
import { createPersistentLaunchRateLimiter } from "./lib/apps.js";
import type { GridSession } from "./lib/pointer.js";
import { readStateSync, removeStateSync, statePath, writeStateAtomicSync } from "./lib/state.js";
import { projectRoot } from "./lib/paths.js";

export const dryRun = process.env.SAARTHI_DRY_RUN === "1";
export const SESSION_ID =
  process.env.SAARTHI_SESSION_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
process.env.SAARTHI_SESSION_ID = SESSION_ID;

export const screenshotDirDefault = join(homedir(), "Pictures", "saarthi");
export const auditLogPath = join(homedir(), ".local", "state", "saarthi", "audit.jsonl");
export const rootDir = projectRoot();
export const runLogPath = join(rootDir, "logs", "actions", "run.jsonl");

export const policy = await loadPolicyConfig(rootDir);
export const assertLaunchRateLimit = createPersistentLaunchRateLimiter(policy.launch.maxLaunchesPerMinute);

// Mutable holder so grid handlers (split across modules) share one live session.
// ESM import bindings are read-only, so the session lives on a holder object.
export const gridSessionPath = statePath("grid-session.json");
export const gridSession: { current: GridSession | null } = {
  current: readStateSync<GridSession>(gridSessionPath),
};

export function persistGridSession(session: GridSession): void {
  gridSession.current = session;
  writeStateAtomicSync(gridSessionPath, session);
}

export function clearGridSession(): void {
  gridSession.current = null;
  removeStateSync(gridSessionPath);
}
