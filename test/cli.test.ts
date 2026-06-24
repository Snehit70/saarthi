import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeCli } from "../src/cli/execute.js";
import { ToolRegistry } from "../src/registry.js";

function testRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerTool(
    "workspace_list",
    {
      title: "Workspace List",
      description: "List workspaces.",
      inputSchema: { includeWindowCounts: z.boolean().default(true) },
      annotations: { readOnlyHint: true },
    },
    async ({ includeWindowCounts }) => ({
      content: [{ type: "text", text: `counts=${includeWindowCounts}` }],
      structuredContent: { workspaces: [], includeWindowCounts },
    }),
  );
  registry.registerTool(
    "workspace_focus",
    {
      title: "Workspace Focus",
      description: "Focus a workspace.",
      inputSchema: { workspace: z.string().min(1) },
    },
    async ({ workspace }) => ({
      content: [{ type: "text", text: `focused ${workspace}` }],
      structuredContent: { workspace },
    }),
  );
  registry.registerTool(
    "input_key_press",
    {
      title: "Key Press",
      description: "Press a key chord.",
      inputSchema: {
        key: z.string().min(1),
        modifiers: z.array(z.string().min(1)).default([]),
        repeat: z.number().int().min(1).default(1),
      },
    },
    async ({ key, modifiers, repeat }) => ({
      content: [{ type: "text", text: "pressed" }],
      structuredContent: { key, modifiers, repeat },
    }),
  );
  registry.registerTool(
    "workspace_fail",
    { title: "Fail", description: "Fail predictably.", inputSchema: {} },
    async () => {
      throw Object.assign(new Error("missing workspace"), { code: "WINDOW_NOT_FOUND" });
    },
  );
  return registry;
}

describe("CLI public interface", () => {
  it("discovers nouns and verbs through generated help", async () => {
    const root = await executeCli(["--help"], testRegistry());
    expect(root).toMatchObject({ exitCode: 0, stderr: "" });
    expect(root.stdout).toContain("workspace");

    const noun = await executeCli(["workspace", "--help"], testRegistry());
    expect(noun).toMatchObject({ exitCode: 0, stderr: "" });
    expect(noun.stdout).toContain("list");
    expect(noun.stdout).toContain("focus");
  });

  it("emits human text by default and structured content with --json", async () => {
    const human = await executeCli(["workspace", "list", "--no-include-window-counts"], testRegistry());
    expect(human).toEqual({ exitCode: 0, stdout: "counts=false\n", stderr: "" });

    const json = await executeCli(["workspace", "list", "--json"], testRegistry());
    expect(JSON.parse(json.stdout)).toEqual({ workspaces: [], includeWindowCounts: true });
    expect(json).toMatchObject({ exitCode: 0, stderr: "" });
  });

  it("accepts a natural positional and reports validation errors only on stderr", async () => {
    const positional = await executeCli(["workspace", "focus", "3", "--json"], testRegistry());
    expect(JSON.parse(positional.stdout)).toEqual({ workspace: "3" });

    const invalid = await executeCli(["workspace", "focus"], testRegistry());
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("workspace");
  });

  it("coerces number and array flags through the zod schema", async () => {
    const result = await executeCli(
      ["input", "key-press", "--key", "k", "--modifiers", "CTRL,SHIFT", "--repeat", "2", "--json"],
      testRegistry(),
    );
    expect(JSON.parse(result.stdout)).toEqual({ key: "k", modifiers: ["CTRL", "SHIFT"], repeat: 2 });
  });

  it("maps operational codes to stable exits and includes the code on stderr", async () => {
    const result = await executeCli(["workspace", "fail"], testRegistry());
    expect(result).toMatchObject({ exitCode: 11, stdout: "" });
    expect(result.stderr).toContain("[WINDOW_NOT_FOUND]");
  });

  it("supports explicit test dispatch without an environment bypass", async () => {
    process.env.SAARTHI_CLI_SMOKE_FIXTURE = "1";
    const normal = await executeCli(["workspace", "list", "--json"], testRegistry());
    expect(JSON.parse(normal.stdout)).toEqual({ workspaces: [], includeWindowCounts: true });

    const injected = await executeCli(["workspace", "list", "--json"], testRegistry(), (tool, args) => ({
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { tool: tool.name, arguments: args },
    }));
    expect(JSON.parse(injected.stdout)).toMatchObject({ tool: "workspace_list" });
    delete process.env.SAARTHI_CLI_SMOKE_FIXTURE;
  });
});
