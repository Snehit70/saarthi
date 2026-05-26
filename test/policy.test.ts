import { describe, expect, it } from "vitest";
import { parseLaunchCommand, resolveWorkspaceRange, type LaunchPolicy, type WorkspacePolicy } from "../src/lib/policy.js";

const launchPolicy: LaunchPolicy = {
  allowedAppAliases: ["firefox"],
  deniedExecutables: ["sudo", "pkexec", "doas", "su"],
  deniedSubstrings: ["&&", "||", ";", "|", "`", "$(", ">", "<"],
  maxCommandLength: 240,
  maxLaunchesPerMinute: 30,
  allowCustomCommand: true,
};

const workspacePolicy: WorkspacePolicy = {
  min: 1,
  max: 10,
  defaultRangeStart: 1,
  defaultRangeEnd: 10,
};

describe("parseLaunchCommand", () => {
  it("parses safe multi-token command", () => {
    const parsed = parseLaunchCommand("flatpak run app.zen_browser.zen", launchPolicy);
    expect(parsed.executable).toBe("flatpak");
    expect(parsed.args).toEqual(["run", "app.zen_browser.zen"]);
    expect(parsed.normalized).toBe("flatpak run app.zen_browser.zen");
  });

  it("rejects blocked shell sequence", () => {
    expect(() => parseLaunchCommand("firefox && rm -rf /", launchPolicy)).toThrow("blocked pattern");
  });

  it("rejects denied executable", () => {
    expect(() => parseLaunchCommand("sudo firefox", launchPolicy)).toThrow("Privilege escalation commands are not allowed");
  });

  it("rejects quoting/escaping", () => {
    expect(() => parseLaunchCommand("firefox \"https://example.com\"", launchPolicy)).toThrow("unsupported quoting");
  });
});

describe("resolveWorkspaceRange", () => {
  it("uses policy defaults when omitted", () => {
    expect(resolveWorkspaceRange(workspacePolicy)).toEqual({ rangeStart: 1, rangeEnd: 10 });
  });

  it("accepts bounded user range", () => {
    expect(resolveWorkspaceRange(workspacePolicy, 2, 4)).toEqual({ rangeStart: 2, rangeEnd: 4 });
  });

  it("rejects out-of-policy range", () => {
    expect(() => resolveWorkspaceRange(workspacePolicy, 0, 4)).toThrow("Workspace range must be within 1-10");
  });
});
