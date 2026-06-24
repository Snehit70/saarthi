import { z } from "zod";
import type { RegisteredTool, ToolRegistry, ToolResult } from "../registry.js";
import { humanizeAction } from "../lib/humanize.js";
import { recordStepDone, recordStepStart } from "../lib/status.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CliDispatch = (tool: RegisteredTool, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

const PRIMARY_POSITIONALS: Record<string, string> = {
  workspace_focus: "workspace",
  window_get: "windowId",
  window_focus: "windowId",
  grid_cell_rect: "cellId",
  grid_cell_to_point: "cellId",
  grid_click: "cellId",
  grid_move: "cellId",
  browser_open_url: "url",
};

const ERROR_EXIT_CODES: Record<string, number> = {
  PLATFORM_UNSUPPORTED: 10,
  NO_SOCKET: 10,
  WINDOW_NOT_FOUND: 11,
  ACTIVE_WINDOW_MISSING: 11,
  WINDOW_NOT_ACTIONABLE: 11,
  DISPATCH_FAILED: 12,
  SCREENSHOT_FAILED: 13,
  INPUT_FAILED: 14,
  NUMERIC_INVALID: 14,
  OCR_FAILED: 15,
  ATSPI_FAILED: 15,
  APP_LAUNCH_FAILED: 16,
  ACTION_TIMEOUT: 17,
  TMUX_UNAVAILABLE: 20,
  TMUX_NO_SERVER: 20,
  TMUX_TARGET_NOT_FOUND: 21,
  TMUX_TARGET_AMBIGUOUS: 22,
  TMUX_PANE_BUSY: 23,
  TMUX_COMMAND_TIMEOUT: 24,
  TMUX_FAILED: 25,
};

function success(stdout: string): CliResult {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`, stderr: "" };
}

function failure(message: string, exitCode = 2): CliResult {
  return { exitCode, stdout: "", stderr: message.endsWith("\n") ? message : `${message}\n` };
}

function rootHelp(registry: ToolRegistry): string {
  return [
    "Usage: saarthi <noun> <verb> [options]",
    "",
    "Commands:",
    ...registry.nouns().map((noun) => `  ${noun}`),
    "",
    "Run 'saarthi <noun> --help' to list that noun's verbs.",
  ].join("\n");
}

function nounHelp(noun: string, registry: ToolRegistry): string | null {
  const tools = registry.verbs(noun);
  if (tools.length === 0) return null;
  return [
    `Usage: saarthi ${noun} <verb> [options]`,
    "",
    "Verbs:",
    ...tools.map((tool) => `  ${tool.verb.padEnd(24)}${tool.config.description ?? ""}`),
  ].join("\n");
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const inner = current._def.innerType ?? current._def.schema;
    if (!inner) return current;
    current = inner;
  }
}

function optionName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function commandHelp(tool: RegisteredTool): string {
  const options = Object.entries(tool.config.inputSchema).map(([field, schema]) => {
    const base = unwrap(schema);
    const typeName = base._def.typeName === "ZodBoolean" ? "" : ` <${base._def.typeName.replace("Zod", "").toLowerCase()}>`;
    const description = schema.description ? `  ${schema.description}` : "";
    return `  --${optionName(field)}${typeName}${description}`;
  });
  return [
    `Usage: saarthi ${tool.noun} ${tool.verb} [options]`,
    "",
    tool.config.description ?? tool.config.title ?? tool.name,
    ...(options.length > 0 ? ["", "Options:", ...options] : []),
    "  --json                  Emit structured JSON",
    "  --help                  Show command help",
  ].join("\n");
}

function coerceValue(schema: z.ZodTypeAny, value: string): unknown {
  const base = unwrap(schema);
  if (base._def.typeName === "ZodNumber") return Number(value);
  if (base._def.typeName === "ZodBoolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  if (base._def.typeName === "ZodArray") return value.split(",").filter(Boolean);
  return value;
}

function parseArguments(tool: RegisteredTool, argv: string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const fields = new Map(Object.keys(tool.config.inputSchema).map((field) => [optionName(field), field]));
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const negated = token.startsWith("--no-");
    const flag = token.slice(negated ? 5 : 2);
    const field = fields.get(flag);
    if (!field) throw new Error(`Unknown option: ${token}`);
    const schema = tool.config.inputSchema[field];
    const base = unwrap(schema);
    if (base._def.typeName === "ZodBoolean") {
      raw[field] = !negated;
      continue;
    }
    if (negated) throw new Error(`Option is not boolean: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    raw[field] = coerceValue(schema, value);
    index += 1;
  }

  const primary = PRIMARY_POSITIONALS[tool.name];
  if (positionals.length > 0 && primary) raw[primary] = coerceValue(tool.config.inputSchema[primary], positionals[0]);
  if (positionals.length > (primary ? 1 : 0)) throw new Error(`Unexpected positional argument: ${positionals[primary ? 1 : 0]}`);
  return z.object(tool.config.inputSchema).parse(raw);
}

function humanText(result: ToolResult): string {
  return result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "ok";
}

function errorResult(error: unknown): CliResult {
  if (error instanceof z.ZodError) {
    return failure(error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("\n"));
  }
  const candidate = error as { code?: string; message?: string };
  const message = candidate?.message ?? String(error);
  const details = Array.isArray((candidate as { candidates?: unknown }).candidates)
    ? `\nCandidates: ${JSON.stringify((candidate as { candidates: unknown[] }).candidates)}`
    : "";
  return failure(candidate?.code ? `[${candidate.code}] ${message}${details}` : message, candidate?.code ? (ERROR_EXIT_CODES[candidate.code] ?? 1) : 2);
}

export async function executeCli(
  argv: string[],
  registry: ToolRegistry,
  dispatch: CliDispatch = (tool, args) => tool.handler(args),
): Promise<CliResult> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return success(rootHelp(registry));
  const noun = argv[0];
  if (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h") {
    const help = nounHelp(noun, registry);
    return help ? success(help) : failure(`Unknown command noun: ${noun}`);
  }
  const verb = argv[1];
  const tool = registry.get(noun, verb);
  if (!tool) return failure(`Unknown command: ${noun} ${verb}`);
  if (argv[2] === "--help" || argv[2] === "-h") return success(commandHelp(tool));

  const json = argv.includes("--json");
  const commandArgv = argv.slice(2).filter((token) => token !== "--json");
  try {
    const args = parseArguments(tool, commandArgv);
    const instrument = !tool.name.startsWith("overlay_task_");
    const stepId = instrument
      ? recordStepStart(
          tool.name,
          tool.config.annotations?.readOnlyHint === true ? "read" : "act",
          humanizeAction(tool.name, args, { redactText: process.env.SAARTHI_REDACT_TYPED === "1" }),
        )
      : null;
    let result: ToolResult;
    try {
      result = await dispatch(tool, args);
      if (stepId !== null) recordStepDone(stepId, true);
    } catch (error) {
      if (stepId !== null) recordStepDone(stepId, false);
      throw error;
    }
    return success(json ? JSON.stringify(result.structuredContent ?? { text: humanText(result) }) : humanText(result));
  } catch (error) {
    return errorResult(error);
  }
}
