import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  discoverLocalBrowsers,
  requireZenShortcut,
  shortcutToHypr,
  spawnZen,
  typeWithWtype,
  validateBrowserUrl,
  waitForZenReadiness,
  waitForZenWindowAfterLaunch,
  ZEN_LAUNCH_COMMAND,
  zenWindows,
  type BrowserReadinessMode,
} from "../lib/browser.js";
import { hyprctlDispatch, HyprlandError, listWindows } from "../lib/hyprland.js";
import type { WindowInfo } from "../lib/types.js";
import { isLaunchCommandAvailable } from "../lib/apps.js";
import { sanitizeTypedText } from "../lib/input.js";
import { server } from "../server.js";
import { assertLaunchRateLimit, dryRun, policy } from "../runtime.js";

type BrowserOpenMode = "new-tab" | "new-window" | "current-tab";
type BrowserGatedAction = "read" | "navigate" | "type-field" | "send" | "commit-submit" | "destructive" | "payment";

const GATED_BROWSER_ACTIONS = new Set<BrowserGatedAction>(["send", "commit-submit", "destructive", "payment"]);

async function focusZenWindow(args: { windowId?: string; titleContains?: string; includeHidden?: boolean }): Promise<ReturnType<typeof zenWindows>[number]> {
  const matches = zenWindows(await listWindows({ includeHidden: args.includeHidden ?? false }), args.titleContains);
  const best = args.windowId ? matches.find((window) => window.id === args.windowId) : matches[0];
  if (!best) {
    throw new HyprlandError("WINDOW_NOT_FOUND", args.windowId ? `Zen window not found: ${args.windowId}` : "No Zen window found");
  }
  if (!dryRun) await hyprctlDispatch("focuswindow", `address:${best.id}`);
  return best;
}

async function sendShortcut(mods: string, key: string): Promise<void> {
  await hyprctlDispatch("sendshortcut", `${mods},${key}`);
}

function defaultReadinessMode(url: string, requested?: BrowserReadinessMode): BrowserReadinessMode {
  if (requested) return requested;
  return url.startsWith("about:") ? "none" : "title-change";
}

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
    description:
      "Open an allowed URL in the local Zen Flatpak browser. Defaults to a keyboard-driven new tab in an existing Zen window so pinned tabs and the current page are not clobbered; falls back to a new Zen window when no Zen window exists.",
    inputSchema: {
      url: z.string().min(1).max(2048),
      mode: z.enum(["new-tab", "new-window", "current-tab"]).optional().describe("Default: new-tab"),
      reuseExisting: z.boolean().optional().describe("Deprecated compatibility flag: true maps to mode='new-tab'; false maps to mode='new-window' only when mode is omitted by an older client."),
      titleContains: z.string().min(1).max(120).optional(),
      currentTabReason: z.enum(["blank-page-verified", "user-said-here"]).optional(),
      timeoutMs: z.number().int().min(100).max(120000).default(45000),
      pollMs: z.number().int().min(50).max(5000).default(200),
      typeDelayMs: z.number().int().min(0).max(1000).default(0),
      readiness: z.enum(["none", "title-change", "title-contains"]).optional().describe("Default: title-change for http(s), none for about: URLs."),
      readyTitleContains: z.string().min(1).max(120).optional(),
      readyTimeoutMs: z.number().int().min(0).max(120000).default(12000),
      readyPollMs: z.number().int().min(50).max(5000).default(250),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, mode, reuseExisting, titleContains, currentTabReason, timeoutMs, pollMs, typeDelayMs, readiness, readyTitleContains, readyTimeoutMs, readyPollMs }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedUrl = validateBrowserUrl(url);
    const requestedMode: BrowserOpenMode = mode ?? (reuseExisting === false ? "new-window" : "new-tab");
    const readinessMode = defaultReadinessMode(normalizedUrl, readiness);
    if (readinessMode === "title-contains" && !readyTitleContains) {
      throw new HyprlandError("INPUT_FAILED", "readiness='title-contains' requires readyTitleContains");
    }
    if (requestedMode === "current-tab" && !currentTabReason) {
      throw new HyprlandError("INPUT_FAILED", "current-tab navigation requires currentTabReason='blank-page-verified' or 'user-said-here'");
    }
    if (!policy.launch.allowedAppAliases.includes("zen")) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Zen browser launches are disabled by policy");
    }
    if (!(await isLaunchCommandAvailable(ZEN_LAUNCH_COMMAND, policy.launch))) {
      throw new HyprlandError("APP_LAUNCH_FAILED", "Zen Flatpak is not available");
    }
    assertLaunchRateLimit();

    const beforeWindows = await listWindows({ includeHidden: false });
    const baselineIds = new Set(beforeWindows.map((window) => window.id));
    const reusable = requestedMode !== "new-window" ? zenWindows(beforeWindows, titleContains)[0] ?? null : null;
    // Honest reporting: a deliberate new-window stays "new-window"; only the
    // no-Zen-window-existed case is a fallback.
    const effectiveMode: BrowserOpenMode | "new-window-fallback" = reusable
      ? requestedMode
      : requestedMode === "new-window"
        ? "new-window"
        : "new-window-fallback";
    const payload = {
      browser: "zen-flatpak",
      command: ZEN_LAUNCH_COMMAND,
      url: normalizedUrl,
      mode: requestedMode,
      effectiveMode,
      reuseExisting: reuseExisting ?? null,
      titleContains: titleContains ?? null,
      reusedWindowId: reusable?.id ?? null,
      currentTabReason: currentTabReason ?? null,
      timeoutMs,
      pollMs,
      typeDelayMs,
      readiness: readinessMode,
      readyTitleContains: readyTitleContains ?? null,
      readyTimeoutMs,
      readyPollMs,
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
          content: [{ type: "text", text: `DRY_RUN open ${normalizedUrl} in Zen (${effectiveMode})` }],
          structuredContent: {
            opened: false,
            dryRun: true,
            browser: "zen-flatpak",
            url: normalizedUrl,
            mode: requestedMode,
            effectiveMode,
            reusedWindow: reusable,
            readiness: {
              ready: false,
              mode: readinessMode,
              reason: "dry-run",
              titleBefore: reusable?.title ?? null,
              titleAfter: reusable?.title ?? null,
            },
          },
        };
      }

      // Acquire the target window via whichever navigation strategy applies,
      // then run one shared readiness + audit + return tail.
      const listLive = () => listWindows({ includeHidden: false });
      let target: WindowInfo;
      let attempts: number;
      let wasNewWindow: boolean;
      let titleBefore: string | null;

      if (reusable) {
        // Existing Zen window: drive navigation from the keyboard so pinned tabs
        // and the current page survive (optional new tab, focus URL bar, type, go).
        titleBefore = reusable.title;
        await hyprctlDispatch("focuswindow", `address:${reusable.id}`);
        if (requestedMode === "new-tab") await sendShortcut("CTRL", "T");
        await sendShortcut("CTRL", "L");
        await typeWithWtype(normalizedUrl, typeDelayMs);
        await sendShortcut("", "RETURN");
        target = reusable;
        attempts = 1;
        wasNewWindow = false;
      } else {
        // No reusable window: spawn a fresh Zen window and wait for it to appear.
        titleBefore = null;
        await spawnZen(normalizedUrl, "new-window");
        const wait = await waitForZenWindowAfterLaunch({
          baselineIds,
          preferNewWindow: true,
          titleContains,
          timeoutMs,
          pollMs,
          listWindows: listLive,
        });
        if (!wait.window) {
          throw new HyprlandError("WINDOW_NOT_FOUND", `Zen did not expose a matching window within ${timeoutMs}ms`);
        }
        await hyprctlDispatch("focuswindow", `address:${wait.window.id}`);
        target = wait.window;
        attempts = wait.attempts;
        wasNewWindow = wait.wasNewWindow;
      }

      const ready = await waitForZenReadiness({
        windowId: target.id,
        titleBefore,
        mode: readinessMode,
        titleContains: readyTitleContains,
        timeoutMs: readyTimeoutMs,
        pollMs: readyPollMs,
        listWindows: listLive,
      });
      await audit("browser_open_url", { ...payload, windowId: target.id, attempts, wasNewWindow }, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
        afterState: { readiness: ready },
      });
      const result = { opened: true, browser: "zen-flatpak", url: normalizedUrl, mode: requestedMode, effectiveMode, window: ready.window, attempts, wasNewWindow, readiness: ready };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
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

server.registerTool(
  "browser_vimium_hint",
  {
    title: "Browser Vimium Hint",
    description:
      "Use Zen's installed Vimium extension for in-page targeting: focus Zen, press f, type visible text to filter hints, and optionally press Enter to commit. Gated action kinds require confirmed=true before committing.",
    inputSchema: {
      visibleText: z.string().min(1).max(160),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      titleContains: z.string().min(1).max(120).optional(),
      commit: z.boolean().default(true),
      actionKind: z.enum(["read", "navigate", "type-field", "send", "commit-submit", "destructive", "payment"]).default("navigate"),
      confirmed: z.boolean().default(false),
      focusSettleMs: z.number().int().min(0).max(3000).default(120),
      hintSettleMs: z.number().int().min(0).max(3000).default(120),
      typeDelayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ visibleText, windowId, titleContains, commit, actionKind, confirmed, focusSettleMs, hintSettleMs, typeDelayMs }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeText = sanitizeTypedText(visibleText);
    const gated = commit && GATED_BROWSER_ACTIONS.has(actionKind as BrowserGatedAction);
    if (gated && !confirmed) {
      throw new HyprlandError("INPUT_FAILED", `browser_vimium_hint ${actionKind} requires confirmed=true before committing`);
    }
    const payload = { visibleTextLength: safeText.length, windowId: windowId ?? null, titleContains: titleContains ?? null, commit, actionKind, confirmed };
    try {
      const window = await focusZenWindow({ windowId, titleContains });
      await audit("browser_vimium_hint", { ...payload, windowId: window.id }, dryRun, {
        requestId,
        result: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
      });
      if (dryRun) {
        return {
          content: [{ type: "text", text: `DRY_RUN Vimium hint textLength=${safeText.length} commit=${commit}` }],
          structuredContent: { hinted: false, dryRun: true, window, commit, actionKind },
        };
      }
      if (focusSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, focusSettleMs));
      await sendShortcut("", "F");
      if (hintSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, hintSettleMs));
      await typeWithWtype(safeText, typeDelayMs);
      if (commit) await sendShortcut("", "RETURN");
      return {
        content: [{ type: "text", text: JSON.stringify({ hinted: true, committed: commit, window, actionKind }, null, 2) }],
        structuredContent: { hinted: true, committed: commit, window, actionKind },
      };
    } catch (err) {
      await audit("browser_vimium_hint", payload, dryRun, {
        requestId,
        result: "error",
        errorCode: err instanceof HyprlandError ? err.code : "INPUT_FAILED",
        durationMs: Date.now() - started,
      });
      throw err;
    }
  },
);

server.registerTool(
  "browser_space_step",
  {
    title: "Browser Space Step",
    description:
      "Step Zen spaces/workspaces forward or backward using the configured Zen shortcut. Returns the opposite restore action so callers can switch back after a scoped task.",
    inputSchema: {
      direction: z.enum(["forward", "backward"]),
      count: z.number().int().min(1).max(10).default(1),
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      titleContains: z.string().min(1).max(120).optional(),
      settleMs: z.number().int().min(0).max(3000).default(120),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ direction, count, windowId, titleContains, settleMs }) => {
    const started = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const window = await focusZenWindow({ windowId, titleContains });
    const shortcut = await requireZenShortcut(direction === "forward" ? "workspaceForward" : "workspaceBackward");
    const hyprShortcut = shortcutToHypr(shortcut);
    const restoreDirection = direction === "forward" ? "backward" : "forward";
    const payload = { direction, count, windowId: window.id, shortcut: hyprShortcut.label };
    await audit("browser_space_step", payload, dryRun, {
      requestId,
      result: "ok",
      errorCode: null,
      durationMs: Date.now() - started,
    });
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN Zen space ${direction} count=${count}` }],
        structuredContent: { stepped: false, dryRun: true, window, direction, count, restore: { direction: restoreDirection, count } },
      };
    }
    for (let i = 0; i < count; i += 1) {
      await sendShortcut(hyprShortcut.mods, hyprShortcut.key);
      if (settleMs > 0 && i < count - 1) await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ stepped: true, direction, count, window, restore: { direction: restoreDirection, count } }, null, 2) }],
      structuredContent: { stepped: true, direction, count, window, restore: { direction: restoreDirection, count } },
    };
  },
);
