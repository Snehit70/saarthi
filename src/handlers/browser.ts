import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  discoverLocalBrowsers,
  spawnZen,
  validateBrowserUrl,
  waitForZenWindowAfterLaunch,
  ZEN_LAUNCH_COMMAND,
  zenWindows,
} from "../lib/browser.js";
import { hyprctlDispatch, HyprlandError, listWindows } from "../lib/hyprland.js";
import { isLaunchCommandAvailable } from "../lib/apps.js";
import { server } from "../server.js";
import { assertLaunchRateLimit, dryRun, policy } from "../runtime.js";

server.registerTool(
  "browser_discover",
  {
    title: "Browser Discover",
    description: "Discover local browser installs, configured profiles, default handlers, and running Zen windows.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const discovery = await discoverLocalBrowsers(policy.launch, await listWindows({ includeHidden: false }));
    return {
      content: [{ type: "text", text: JSON.stringify(discovery, null, 2) }],
      structuredContent: { discovery },
    };
  },
);

server.registerTool(
  "browser_focus",
  {
    title: "Browser Focus",
    description: "Focus the best existing Zen browser window, optionally matching title text.",
    inputSchema: {
      titleContains: z.string().min(1).max(120).optional(),
      includeHidden: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ titleContains, includeHidden }) => {
    const matches = zenWindows(await listWindows({ includeHidden }), titleContains);
    if (matches.length === 0) {
      throw new HyprlandError("WINDOW_NOT_FOUND", titleContains ? `No Zen window matched title: ${titleContains}` : "No Zen window found");
    }
    const best = matches[0];
    await audit("browser_focus", { titleContains: titleContains ?? null, includeHidden, windowId: best.id }, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN focus Zen window ${best.id}` }],
        structuredContent: { focused: false, window: best, candidates: matches },
      };
    }
    await hyprctlDispatch("focuswindow", `address:${best.id}`);
    return {
      content: [{ type: "text", text: JSON.stringify({ focused: true, window: best }, null, 2) }],
      structuredContent: { focused: true, window: best, candidates: matches },
    };
  },
);

server.registerTool(
  "browser_open_url",
  {
    title: "Browser Open URL",
    description: "Open an allowed URL in the local Zen Flatpak browser, with optional existing-window reuse.",
    inputSchema: {
      url: z.string().min(1).max(2048),
      reuseExisting: z.boolean().default(false),
      titleContains: z.string().min(1).max(120).optional(),
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
  async ({ url, reuseExisting, titleContains, timeoutMs, pollMs }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedUrl = validateBrowserUrl(url);
    if (!policy.launch.allowedAppAliases.includes("zen")) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Zen browser launches are disabled by policy");
    }
    if (!(await isLaunchCommandAvailable(ZEN_LAUNCH_COMMAND, policy.launch))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Zen Flatpak is not available");
    }
    assertLaunchRateLimit();

    const beforeWindows = await listWindows({ includeHidden: false });
    const baselineIds = new Set(beforeWindows.map((window) => window.id));
    const reusable = reuseExisting ? zenWindows(beforeWindows, titleContains)[0] ?? null : null;
    const mode = reusable ? "new-tab" : "new-window";
    const payload = {
      browser: "zen-flatpak",
      command: ZEN_LAUNCH_COMMAND,
      url: normalizedUrl,
      reuseExisting,
      titleContains: titleContains ?? null,
      mode,
      reusedWindowId: reusable?.id ?? null,
      timeoutMs,
      pollMs,
    };

    try {
      if (dryRun) {
        await audit("browser_open_url", payload, dryRun, {
          requestId,
          result: "ok",
          errorCode: null,
          durationMs: Date.now() - started,
        });
        return {
          content: [{ type: "text", text: `DRY_RUN open ${normalizedUrl} in Zen (${mode})` }],
          structuredContent: {
            opened: false,
            dryRun: true,
            browser: "zen-flatpak",
            url: normalizedUrl,
            mode,
            reusedWindow: reusable,
          },
        };
      }

      if (reusable) {
        await hyprctlDispatch("focuswindow", `address:${reusable.id}`);
      }
      await spawnZen(normalizedUrl, mode);

      const wait = await waitForZenWindowAfterLaunch({
        baselineIds,
        preferNewWindow: !reusable,
        titleContains,
        timeoutMs,
        pollMs,
        listWindows: () => listWindows({ includeHidden: false }),
      });
      const window = wait.window;
      const attempts = wait.attempts;
      if (!window) {
        throw new HyprlandError("WINDOW_NOT_FOUND", `Zen did not expose a matching window within ${timeoutMs}ms`);
      }
      await hyprctlDispatch("focuswindow", `address:${window.id}`);
      const wasNewWindow = wait.wasNewWindow;
      await audit("browser_open_url", { ...payload, windowId: window.id, attempts, wasNewWindow }, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ opened: true, browser: "zen-flatpak", url: normalizedUrl, mode, window, attempts }, null, 2) }],
        structuredContent: { opened: true, browser: "zen-flatpak", url: normalizedUrl, mode, window, attempts, wasNewWindow },
      };
    } catch (err) {
      const errorCode = err instanceof HyprlandError ? err.code : "APP_LAUNCH_FAILED";
      await audit("browser_open_url", payload, dryRun, {
        requestId,
        result: "error",
        errorCode,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  },
);
