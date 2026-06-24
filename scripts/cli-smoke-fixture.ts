#!/usr/bin/env node
import "../src/register-tools.js";
import { executeCli } from "../src/cli/execute.js";
import { registry } from "../src/registry.js";

const result = await executeCli(process.argv.slice(2), registry, (tool, args) => ({
  content: [{ type: "text", text: tool.name }],
  structuredContent: { tool: tool.name, arguments: args },
}));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
