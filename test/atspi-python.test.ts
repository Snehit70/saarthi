import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks visibility, bounded traversal, and focused-app failure in the Python adapter", () => {
  expect(() => execFileSync("python3", ["test/atspi_query_test.py"], { timeout: 5000, stdio: "pipe" })).not.toThrow();
});
