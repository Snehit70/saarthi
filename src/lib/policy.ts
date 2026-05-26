import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HyprlandError } from "./hyprland.js";

export interface LaunchPolicy {
  allowedAppAliases: string[];
  deniedExecutables: string[];
  deniedSubstrings: string[];
  maxCommandLength: number;
  maxLaunchesPerMinute: number;
  allowCustomCommand: boolean;
}

export interface WorkspacePolicy {
  min: number;
  max: number;
  defaultRangeStart: number;
  defaultRangeEnd: number;
}

export interface PolicyConfig {
  launch: LaunchPolicy;
  workspace: WorkspacePolicy;
}

const DEFAULT_POLICY: PolicyConfig = {
  launch: {
    allowedAppAliases: ["zen", "zathura", "kitty", "code", "firefox", "chromium", "nautilus"],
    deniedExecutables: ["sudo", "pkexec", "doas", "su"],
    deniedSubstrings: ["&&", "||", ";", "|", "`", "$(", ">", "<"],
    maxCommandLength: 240,
    maxLaunchesPerMinute: 30,
    allowCustomCommand: true,
  },
  workspace: {
    min: 1,
    max: 10,
    defaultRangeStart: 1,
    defaultRangeEnd: 10,
  },
};

interface PartialPolicyConfig {
  launch?: Partial<LaunchPolicy>;
  workspace?: Partial<WorkspacePolicy>;
}

function normalizePolicy(raw: PartialPolicyConfig): PolicyConfig {
  const launch: LaunchPolicy = {
    allowedAppAliases: raw.launch?.allowedAppAliases ?? DEFAULT_POLICY.launch.allowedAppAliases,
    deniedExecutables: raw.launch?.deniedExecutables ?? DEFAULT_POLICY.launch.deniedExecutables,
    deniedSubstrings: raw.launch?.deniedSubstrings ?? DEFAULT_POLICY.launch.deniedSubstrings,
    maxCommandLength: raw.launch?.maxCommandLength ?? DEFAULT_POLICY.launch.maxCommandLength,
    maxLaunchesPerMinute: raw.launch?.maxLaunchesPerMinute ?? DEFAULT_POLICY.launch.maxLaunchesPerMinute,
    allowCustomCommand: raw.launch?.allowCustomCommand ?? DEFAULT_POLICY.launch.allowCustomCommand,
  };
  const workspace: WorkspacePolicy = {
    min: raw.workspace?.min ?? DEFAULT_POLICY.workspace.min,
    max: raw.workspace?.max ?? DEFAULT_POLICY.workspace.max,
    defaultRangeStart: raw.workspace?.defaultRangeStart ?? DEFAULT_POLICY.workspace.defaultRangeStart,
    defaultRangeEnd: raw.workspace?.defaultRangeEnd ?? DEFAULT_POLICY.workspace.defaultRangeEnd,
  };

  if (!Number.isInteger(launch.maxCommandLength) || launch.maxCommandLength < 20 || launch.maxCommandLength > 1024) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Invalid launch.maxCommandLength in policy");
  }
  if (!Number.isInteger(launch.maxLaunchesPerMinute) || launch.maxLaunchesPerMinute < 1 || launch.maxLaunchesPerMinute > 1000) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Invalid launch.maxLaunchesPerMinute in policy");
  }
  if (!Number.isInteger(workspace.min) || !Number.isInteger(workspace.max) || workspace.min < 1 || workspace.max > 99 || workspace.min > workspace.max) {
    throw new HyprlandError("NUMERIC_INVALID", "Invalid workspace min/max in policy");
  }
  if (
    !Number.isInteger(workspace.defaultRangeStart) ||
    !Number.isInteger(workspace.defaultRangeEnd) ||
    workspace.defaultRangeStart < workspace.min ||
    workspace.defaultRangeEnd > workspace.max ||
    workspace.defaultRangeStart > workspace.defaultRangeEnd
  ) {
    throw new HyprlandError("NUMERIC_INVALID", "Invalid workspace default range in policy");
  }

  return { launch, workspace };
}

export async function loadPolicyConfig(cwd: string): Promise<PolicyConfig> {
  const path = join(cwd, "config", "policy.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PartialPolicyConfig;
    return normalizePolicy(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_POLICY;
    }
    if (err instanceof SyntaxError) {
      throw new HyprlandError("APP_LAUNCH_FAILED", `Invalid JSON in policy file: ${path}`);
    }
    throw err;
  }
}

export interface ParsedLaunchCommand {
  raw: string;
  normalized: string;
  executable: string;
  args: string[];
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9._:@%/+,\-=]+$/;

export function parseLaunchCommand(input: string, policy: LaunchPolicy): ParsedLaunchCommand {
  const raw = input.trim();
  if (!raw) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command cannot be empty");
  }
  if (raw.length > policy.maxCommandLength) {
    throw new HyprlandError("APP_LAUNCH_FAILED", `Launch command is too long (max ${policy.maxCommandLength})`);
  }
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command contains control characters");
  }
  if (/['"\\]/.test(raw)) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command contains unsupported quoting or escaping");
  }
  const lowered = raw.toLowerCase();
  for (const blocked of policy.deniedSubstrings) {
    if (blocked && lowered.includes(blocked.toLowerCase())) {
      throw new HyprlandError("APP_LAUNCH_FAILED", `Launch command contains blocked pattern: ${blocked}`);
    }
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Launch command cannot be empty");
  }
  for (const token of tokens) {
    if (!SAFE_TOKEN_RE.test(token)) {
      throw new HyprlandError("APP_LAUNCH_FAILED", `Launch token contains unsupported characters: ${token}`);
    }
  }
  const executable = tokens[0];
  const executableBase = executable.split("/").pop()?.toLowerCase() ?? executable.toLowerCase();
  if (policy.deniedExecutables.some((d) => d.toLowerCase() === executableBase)) {
    throw new HyprlandError("APP_LAUNCH_FAILED", "Privilege escalation commands are not allowed");
  }
  return {
    raw,
    normalized: tokens.join(" "),
    executable,
    args: tokens.slice(1),
  };
}

export function resolveWorkspaceRange(
  workspace: WorkspacePolicy,
  inputStart?: number,
  inputEnd?: number,
): { rangeStart: number; rangeEnd: number } {
  const rangeStart = inputStart ?? workspace.defaultRangeStart;
  const rangeEnd = inputEnd ?? workspace.defaultRangeEnd;
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
    throw new HyprlandError("NUMERIC_INVALID", "Workspace range must be integers");
  }
  if (rangeStart < workspace.min || rangeEnd > workspace.max || rangeStart > rangeEnd) {
    throw new HyprlandError("NUMERIC_INVALID", `Workspace range must be within ${workspace.min}-${workspace.max} and start <= end`);
  }
  return { rangeStart, rangeEnd };
}
