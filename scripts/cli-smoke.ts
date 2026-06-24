import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import "../src/register-tools.js";
import { registry, type RegisteredTool } from "../src/registry.js";

const execFileAsync = promisify(execFile);

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const inner = current._def.innerType ?? current._def.schema;
    if (!inner) return current;
    current = inner;
  }
}

function flagName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function sampleValue(field: string, schema: z.ZodTypeAny): unknown {
  const base = unwrap(schema);
  if (base._def.typeName === "ZodEnum") return base._def.values[0];
  if (base._def.typeName === "ZodBoolean") return true;
  if (base._def.typeName === "ZodArray") return [];
  if (base._def.typeName === "ZodNumber") {
    for (const candidate of [1, 100, 0, -1]) if (schema.safeParse(candidate).success) return candidate;
  }
  if (base._def.typeName === "ZodString") {
    const preferred: Record<string, string> = {
      windowId: "0x111",
      workspace: "1",
      query: "smoke",
      text: "smoke",
      key: "escape",
      command: "true",
      pathA: "/tmp/saarthi-smoke-a.png",
      pathB: "/tmp/saarthi-smoke-b.png",
    };
    for (const candidate of [preferred[field], "smoke", "1", "0x111"].filter(Boolean)) {
      if (schema.safeParse(candidate).success) return candidate;
    }
  }
  throw new Error(`Cannot generate smoke input for ${field} (${base._def.typeName})`);
}

function commandArgs(tool: RegisteredTool): string[] {
  const args: string[] = [];
  for (const [field, schema] of Object.entries(tool.config.inputSchema)) {
    if (schema.safeParse(undefined).success) continue;
    const value = sampleValue(field, schema);
    const flag = `--${flagName(field)}`;
    if (typeof value === "boolean") args.push(value ? flag : `--no-${flagName(field)}`);
    else if (Array.isArray(value)) args.push(flag, value.join(","));
    else args.push(flag, String(value));
  }
  return args;
}

async function invoke(args: string[], env: NodeJS.ProcessEnv, fixture = false): Promise<string> {
  const cliPath = fixture
    ? join(process.cwd(), "dist", "scripts", "cli-smoke-fixture.js")
    : join(process.cwd(), "dist", "src", "cli.js");
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: env.SAARTHI_SMOKE_CWD,
    env,
  });
  if (stderr.trim()) throw new Error(`${args.join(" ")} wrote stderr: ${stderr.trim()}`);
  return stdout;
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "saarthi-cli-smoke-"));
  const env = {
    ...process.env,
    SAARTHI_STATE_DIR: stateDir,
    SAARTHI_SMOKE_CWD: stateDir,
    SAARTHI_STATUS: "0",
    SAARTHI_DRY_RUN: "1",
  };
  const tools = registry.list();

  const rootHelp = await invoke(["--help"], env);
  for (const noun of registry.nouns()) {
    if (!rootHelp.includes(noun)) throw new Error(`root help omitted noun: ${noun}`);
    const nounHelp = await invoke([noun, "--help"], env);
    for (const tool of registry.verbs(noun)) {
      if (!nounHelp.includes(tool.verb)) throw new Error(`${noun} help omitted verb: ${tool.verb}`);
      const commandHelp = await invoke([noun, tool.verb, "--help"], env);
      if (!commandHelp.includes(`saarthi ${noun} ${tool.verb}`)) throw new Error(`command help malformed: ${noun} ${tool.verb}`);
    }
  }

  const readOnly = tools.filter((tool) => tool.config.annotations?.readOnlyHint === true);
  for (const tool of readOnly) {
    const stdout = await invoke([tool.noun, tool.verb, ...commandArgs(tool), "--json"], env, true);
    const payload = JSON.parse(stdout) as { tool?: string };
    if (payload.tool !== tool.name) throw new Error(`JSON smoke mismatch for ${tool.name}`);
  }

  process.stdout.write(`CLI SMOKE PASS: ${tools.length} commands in help; ${readOnly.length} read-only commands returned JSON\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`CLI SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
