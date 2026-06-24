#!/usr/bin/env node
import "./register-tools.js";
import { executeCli } from "./cli/execute.js";
import { flushIdleSync } from "./lib/status.js";
import { registry } from "./registry.js";

const result = await executeCli(process.argv.slice(2), registry);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;

process.on("exit", () => flushIdleSync());
