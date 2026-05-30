import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  focusedWorkspaceName,
  hyprctlDispatch,
  HyprlandError,
  listWindows,
  pickFirstEmptyWorkspace,
} from "../lib/hyprland.js";
import { parseLaunchCommand, resolveWorkspaceRange } from "../lib/policy.js";
import { APP_CATALOG, isLaunchCommandAvailable, resolveAppLaunchCommand } from "../lib/apps.js";
import { waitForWindow } from "../lib/pointer.js";
import { server } from "../server.js";
import { assertLaunchRateLimit, dryRun, policy } from "../runtime.js";

server.registerTool(
  "app_list",
  {
    title: "App List",
    description: "List known app launch aliases with one-line descriptions.",
    inputSchema: {
      installedOnly: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ installedOnly }) => {
    const entries = await Promise.all(
      APP_CATALOG.filter((app) => policy.launch.allowedAppAliases.includes(app.name)).map(async (app) => {
        let launchCommand: string | null = null;
        for (const cmd of app.commands) {
          if (await isLaunchCommandAvailable(cmd, policy.launch)) {
            launchCommand = parseLaunchCommand(cmd, policy.launch).normalized;
            break;
          }
        }
        return {
          name: app.name,
          description: app.description,
          installed: launchCommand !== null,
          launchCommand,
        };
      }),
    );

    const filtered = installedOnly ? entries.filter((e) => e.installed) : entries;
    return {
      content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      structuredContent: { apps: filtered },
    };
  },
);

server.registerTool(
  "app_launch",
  {
    title: "App Launch",
    description: "Launch an app command, optionally in a specific or empty workspace.",
    inputSchema: {
      command: z.string().min(1).max(240).optional(),
      appName: z.string().min(1).max(64).optional(),
      workspace: z.string().optional(),
      preferEmptyWorkspace: z.boolean().default(false),
      rangeStart: z.number().int().min(1).max(99).optional(),
      rangeEnd: z.number().int().min(1).max(99).optional(),
      keepCurrentWorkspace: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ command, appName, workspace, preferEmptyWorkspace, rangeStart, rangeEnd, keepCurrentWorkspace }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (command && !policy.launch.allowCustomCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Custom launch command is disabled by policy");
    }
    const resolvedCommand = command ?? (appName ? await resolveAppLaunchCommand(appName, policy.launch) : null);
    if (!resolvedCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "No launch command available. Provide command or a valid installed appName.");
    }
    const parsed = parseLaunchCommand(resolvedCommand, policy.launch);
    if (!(await isLaunchCommandAvailable(parsed.normalized, policy.launch))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Launch executable not found in PATH");
    }

    const effectiveRange = resolveWorkspaceRange(policy.workspace, rangeStart, rangeEnd);
    let targetWorkspace = workspace;
    if (!targetWorkspace && preferEmptyWorkspace) {
      const windows = await listWindows({ includeHidden: false });
      targetWorkspace = pickFirstEmptyWorkspace(windows, effectiveRange.rangeStart, effectiveRange.rangeEnd) ?? undefined;
    }

    assertLaunchRateLimit();
    const originalWorkspace = keepCurrentWorkspace ? await focusedWorkspaceName() : null;
    const launchCommand = targetWorkspace ? `[workspace ${targetWorkspace}] ${parsed.normalized}` : parsed.normalized;

    const payload = {
      appName: appName ?? null,
      command: parsed.normalized,
      workspace: targetWorkspace ?? null,
      preferEmptyWorkspace,
      rangeStart: effectiveRange.rangeStart,
      rangeEnd: effectiveRange.rangeEnd,
      keepCurrentWorkspace,
      launchCommand,
    };

    if (dryRun) {
      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: `DRY_RUN launch ${launchCommand}` }],
        structuredContent: { launchCommand, workspace: targetWorkspace ?? null, dryRun: true },
      };
    }
    try {
      await hyprctlDispatch("exec", launchCommand);

      if (keepCurrentWorkspace && originalWorkspace && targetWorkspace && originalWorkspace !== targetWorkspace) {
        try {
          await hyprctlDispatch("workspace", originalWorkspace);
        } catch {
          // Keep launch success even if workspace restore fails.
        }
      }

      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ launched: true, workspace: targetWorkspace ?? null, appName: appName ?? null, command: parsed.normalized }, null, 2),
          },
        ],
        structuredContent: { launched: true, workspace: targetWorkspace ?? null, appName: appName ?? null, command: parsed.normalized },
      };
    } catch (err) {
      const errorCode = err instanceof HyprlandError ? err.code : "APP_LAUNCH_FAILED";
      await audit("app_launch", payload, dryRun, {
        requestId,
        result: "error",
        errorCode,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  },
);

server.registerTool(
  "app_launch_and_wait",
  {
    title: "App Launch And Wait",
    description: "Launch app and wait for a matching window.",
    inputSchema: {
      command: z.string().min(1).max(240).optional(),
      appName: z.string().min(1).max(64).optional(),
      workspace: z.string().optional(),
      preferEmptyWorkspace: z.boolean().default(false),
      rangeStart: z.number().int().min(1).max(99).optional(),
      rangeEnd: z.number().int().min(1).max(99).optional(),
      keepCurrentWorkspace: z.boolean().default(true),
      classEquals: z.string().optional(),
      classContains: z.string().optional(),
      titleContains: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(120000).default(12000),
      pollMs: z.number().int().min(50).max(5000).default(200),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (args.command && !policy.launch.allowCustomCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Custom launch command is disabled by policy");
    }
    const resolvedCommand = args.command ?? (args.appName ? await resolveAppLaunchCommand(args.appName, policy.launch) : null);
    if (!resolvedCommand) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "No launch command available. Provide command or a valid installed appName.");
    }
    const parsed = parseLaunchCommand(resolvedCommand, policy.launch);
    if (!(await isLaunchCommandAvailable(parsed.normalized, policy.launch))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Launch executable not found in PATH");
    }

    const effectiveRange = resolveWorkspaceRange(policy.workspace, args.rangeStart, args.rangeEnd);
    let targetWorkspace = args.workspace;
    if (!targetWorkspace && args.preferEmptyWorkspace) {
      const windows = await listWindows({ includeHidden: false });
      targetWorkspace = pickFirstEmptyWorkspace(windows, effectiveRange.rangeStart, effectiveRange.rangeEnd) ?? undefined;
    }
    assertLaunchRateLimit();
    const originalWorkspace = args.keepCurrentWorkspace ? await focusedWorkspaceName() : null;
    const launchCommand = targetWorkspace ? `[workspace ${targetWorkspace}] ${parsed.normalized}` : parsed.normalized;
    const payload = {
      appName: args.appName ?? null,
      command: parsed.normalized,
      workspace: targetWorkspace ?? null,
      preferEmptyWorkspace: args.preferEmptyWorkspace,
      rangeStart: effectiveRange.rangeStart,
      rangeEnd: effectiveRange.rangeEnd,
      keepCurrentWorkspace: args.keepCurrentWorkspace,
      classEquals: args.classEquals ?? null,
      classContains: args.classContains ?? null,
      titleContains: args.titleContains ?? null,
      timeoutMs: args.timeoutMs,
      pollMs: args.pollMs,
      launchCommand,
    };

    try {
      if (!dryRun) {
        await hyprctlDispatch("exec", launchCommand);
        if (args.keepCurrentWorkspace && originalWorkspace && targetWorkspace && originalWorkspace !== targetWorkspace) {
          try {
            await hyprctlDispatch("workspace", originalWorkspace);
          } catch {
            // keep success
          }
        }
      }

      const wait = await waitForWindow(
        {
          classEquals: args.classEquals,
          classContains: args.classContains,
          titleContains: args.titleContains,
          workspace: targetWorkspace,
        },
        args.timeoutMs,
        args.pollMs,
      );
      if (dryRun) {
        await audit("app_launch_and_wait", payload, dryRun, {
          requestId,
          result: "ok",
          errorCode: null,
          durationMs: Date.now() - started,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ dryRun: true, launchCommand, waitedAttempts: wait.attempts }, null, 2) }],
          structuredContent: { dryRun: true, launchCommand, waitedAttempts: wait.attempts },
        };
      }
      if (!wait.found) {
        throw new HyprlandError("WINDOW_NOT_FOUND", `Launch succeeded but no matching window appeared within ${args.timeoutMs}ms`);
      }
      await audit("app_launch_and_wait", { ...payload, attempts: wait.attempts }, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ launchCommand, workspace: targetWorkspace ?? null, window: wait.found, attempts: wait.attempts }, null, 2) }],
        structuredContent: { launchCommand, workspace: targetWorkspace ?? null, window: wait.found, attempts: wait.attempts },
      };
    } catch (err) {
      const errorCode = err instanceof HyprlandError ? err.code : "APP_LAUNCH_FAILED";
      await audit("app_launch_and_wait", payload, dryRun, {
        requestId,
        result: "error",
        errorCode,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  },
);
