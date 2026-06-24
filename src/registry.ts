import type { z } from "zod";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
}

export type ToolHandler = (args: any) => ToolResult | Promise<ToolResult>;

export interface RegisteredTool {
  name: string;
  noun: string;
  verb: string;
  config: ToolConfig;
  handler: ToolHandler;
}

const COMMAND_OVERRIDES: Record<string, [string, string]> = {
  desktop_screenshot: ["screenshot", "capture"],
  desktop_screenshot_area: ["screenshot", "area"],
  desktop_screenshot_save: ["screenshot", "save"],
  type_text: ["input", "type"],
  key_press: ["input", "key-press"],
  window_focus_and_type: ["input", "focus-and-type"],
  find_text_on_screen: ["text", "find"],
  resolve_text_point: ["text", "resolve-point"],
  click_text: ["text", "click"],
  wait_for_text: ["observe", "wait-for-text"],
  wait_for_stable: ["observe", "wait-for-stable"],
  screenshot_compare: ["observe", "screenshot-compare"],
  metrics_report: ["observability", "metrics-report"],
  session_trace_export: ["observability", "session-trace-export"],
  desktop_health: ["observability", "desktop-health"],
  action_step: ["composite", "action-step"],
  action_verify_window_state: ["composite", "verify-window-state"],
  click_wait_retry: ["composite", "click-wait-retry"],
};

function commandFor(name: string): [string, string] {
  const override = COMMAND_OVERRIDES[name];
  if (override) return override;
  const separator = name.indexOf("_");
  if (separator < 1 || separator === name.length - 1) {
    throw new Error(`Tool name must contain a noun and verb: ${name}`);
  }
  return [name.slice(0, separator), name.slice(separator + 1).replaceAll("_", "-")];
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly commands = new Map<string, RegisteredTool>();

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    const [noun, verb] = commandFor(name);
    const commandKey = `${noun} ${verb}`;
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    if (this.commands.has(commandKey)) throw new Error(`Command already registered: ${commandKey}`);
    const tool = { name, noun, verb, config, handler };
    this.tools.set(name, tool);
    this.commands.set(commandKey, tool);
  }

  get(noun: string, verb: string): RegisteredTool | undefined {
    return this.commands.get(`${noun} ${verb}`);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  nouns(): string[] {
    return [...new Set(this.list().map((tool) => tool.noun))].sort();
  }

  verbs(noun: string): RegisteredTool[] {
    return this.list().filter((tool) => tool.noun === noun).sort((a, b) => a.verb.localeCompare(b.verb));
  }
}

export const registry = new ToolRegistry();

// Preserve the old registration call shape so handler bodies remain mechanical.
export const server = registry;
