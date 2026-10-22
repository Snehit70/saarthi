import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks visibility, bounded traversal, and focused-app failure in the Python adapter", () => {
  expect(() => execFileSync("python3", ["test/atspi_query_test.py"], { timeout: 5000, stdio: "pipe" })).not.toThrow();
});

it("checks benchmark outcome authentication and preservation", () => {
  expect(() => execFileSync("python3", ["test/benchmark_test.py"], { timeout: 5000, stdio: "pipe" })).not.toThrow();
});

it("checks semantic action readback and rejection paths", () => {
  expect(() => execFileSync("python3", ["test/atspi_action_test.py"], { timeout: 5000, stdio: "pipe" })).not.toThrow();
});
