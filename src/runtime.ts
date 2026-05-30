import { join } from "node:path";
import { homedir } from "node:os";
import { loadPolicyConfig } from "./lib/policy.js";
import { createLaunchRateLimiter } from "./lib/apps.js";
import type { GridSession } from "./lib/pointer.js";

export const dryRun = process.env.USE_MCP_DRY_RUN === "1";
export const SESSION_ID =
  process.env.SAARTHI_SESSION_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
process.env.SAARTHI_SESSION_ID = SESSION_ID;

export const screenshotDirDefault = join(homedir(), "Pictures", "saarthi");
export const auditLogPath = join(homedir(), ".local", "state", "saarthi", "audit.jsonl");
export const runLogPath = join(process.cwd(), "logs", "actions", "run.jsonl");

export const policy = await loadPolicyConfig(process.cwd());
export const assertLaunchRateLimit = createLaunchRateLimiter(policy.launch.maxLaunchesPerMinute);

// Mutable holder so grid handlers (split across modules) share one live session.
// ESM import bindings are read-only, so the session lives on a holder object.
export const gridSession: { current: GridSession | null } = { current: null };
