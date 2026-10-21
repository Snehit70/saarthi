import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  BROWSER_IDS,
  browserWindows,
  discoverLocalBrowsers,
  selectBrowser,
  focusBrowserWindow,
  assertBrowserFocus,
  openBrowserUrl,
  defaultReadinessMode,
  validateBrowserUrl,
  requireZenShortcut,
  shortcutToHypr,
  typeWithWtype,
  focusZenWindow,
} from "../lib/browser.js";
import { HyprlandError, listWindows, sendShortcut } from "../lib/hyprland.js";
import { sanitizeTypedText } from "../lib/input.js";
import { server } from "../registry.js";
import { assertLaunchRateLimit, dryRun, policy } from "../runtime.js";

const browserTarget = {
  browser: z.enum(["auto", ...BROWSER_IDS]).default("auto"),
  windowId: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .optional(),
  titleContains: z.string().min(1).max(120).optional(),
};
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
type BrowserGatedAction = "read" | "navigate" | "type-field" | "send" | "commit-submit" | "destructive" | "payment";
const GATED_BROWSER_ACTIONS = new Set<BrowserGatedAction>(["send", "commit-submit", "destructive", "payment"]);

server.registerTool(
  "browser_discover",
  {
    title: "Browser Discover",
    description:
      "Discover supported browser installs, launch-policy availability, default handlers, profiles, and running windows.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const discovery = await discoverLocalBrowsers(policy.launch, await listWindows({ includeHidden: false }));
    return { content: [{ type: "text", text: JSON.stringify(discovery, null, 2) }], structuredContent: { discovery } };
  },
);

server.registerTool(
  "browser_focus",
  {
    title: "Browser Focus",
    description:
      "Focus a supported browser by identity or exact window id. Ambiguous targets require an explicit selector.",
    inputSchema: { ...browserTarget, includeHidden: z.boolean().default(false) },
    annotations: MUTATING,
  },
  async ({ browser, windowId, titleContains, includeHidden }) => {
    const windows = await listWindows({ includeHidden });
    const identity = selectBrowser(windows, browser, windowId, null, titleContains);
    const candidates = browserWindows(windows, identity, titleContains, includeHidden);
    await audit("browser_focus", { browser: identity, windowId, titleContains, includeHidden }, dryRun, {
      status: "started",
    });
    try {
      const window = await focusBrowserWindow(
        windows,
        { browser: identity, windowId, titleContains, includeHidden },
        !dryRun,
      );
      await audit("browser_focus", { browser: identity, windowId: window.id }, dryRun, { result: "ok" });
      return {
        content: [
          {
            type: "text",
            text: dryRun ? `DRY_RUN focus ${identity} window ${window.id}` : JSON.stringify({ focused: true, window }),
          },
        ],
        structuredContent: { focused: !dryRun, browser: identity, window, candidates },
      };
    } catch (error) {
      await audit("browser_focus", { browser: identity, windowId }, dryRun, {
        result: "error",
        errorCode: error instanceof HyprlandError ? error.code : "INPUT_FAILED",
      });
      throw error;
    }
  },
);

server.registerTool(
  "browser_open_url",
  {
    title: "Browser Open URL",
    description:
      "Open an allowed URL in a supported local browser. Reuse the selected window with a new tab by default; launches pass alias, deny, and rate-limit policy. Title readiness is a heuristic; verify page content before acting.",
    inputSchema: {
      ...browserTarget,
      url: z.string().min(1).max(2048),
      mode: z.enum(["new-tab", "new-window", "current-tab"]).optional().describe("Default: new-tab"),
      reuseExisting: z.boolean().optional().describe("Compatibility flag used only when mode is omitted."),
      currentTabReason: z.enum(["blank-page-verified", "user-said-here"]).optional(),
      timeoutMs: z.number().int().min(100).max(120000).default(45000),
      pollMs: z.number().int().min(50).max(5000).default(200),
      typeDelayMs: z.number().int().min(0).max(1000).default(0),
      readiness: z.enum(["none", "title-change", "title-contains"]).optional(),
      readyTitleContains: z.string().trim().min(1).max(120).optional(),
      readyTimeoutMs: z.number().int().min(0).max(120000).default(12000),
      readyPollMs: z.number().int().min(50).max(5000).default(250),
    },
    annotations: MUTATING,
  },
  async (args) => {
    const started = Date.now();
    const url = validateBrowserUrl(args.url);
    const mode = args.mode ?? (args.reuseExisting === false ? "new-window" : "new-tab");
    const readinessMode = defaultReadinessMode(url, args.readiness);
    if (readinessMode === "title-contains" && !args.readyTitleContains)
      throw new HyprlandError("INPUT_FAILED", "title-contains readiness requires readyTitleContains");
    if (mode === "current-tab" && !args.currentTabReason)
      throw new HyprlandError(
        "INPUT_FAILED",
        "current-tab navigation requires currentTabReason='blank-page-verified' or 'user-said-here'",
      );
    const windows = await listWindows({ includeHidden: false });
    const fallback =
      args.browser === "auto" && browserWindows(windows).length === 0 && !args.windowId
        ? (await discoverLocalBrowsers(policy.launch, windows)).primary
        : null;
    const browser = selectBrowser(windows, args.browser, args.windowId, fallback, args.titleContains);
    const payload = { browser, windowId: args.windowId, url, mode, readiness: readinessMode };
    await audit("browser_open_url", payload, dryRun, { status: "started" });
    try {
      const result = await openBrowserUrl({
        ...args,
        browser,
        url,
        mode,
        readinessMode,
        launch: policy.launch,
        beforeLaunch: assertLaunchRateLimit,
        dryRun,
        listWindows: () => listWindows({ includeHidden: false }),
      });
      if (!dryRun && !result.readiness?.ready)
        throw new HyprlandError(
          "ACTION_TIMEOUT",
          `Browser title readiness timed out after ${result.readiness?.waitedMs}ms; navigation may have occurred, inspect before retrying`,
        );
      await audit(
        "browser_open_url",
        { ...payload, command: result.command, windowId: result.targetWindow?.id },
        dryRun,
        { result: "ok", durationMs: Date.now() - started, afterState: { readiness: result.readiness } },
      );
      const output = {
        opened: !dryRun,
        dryRun,
        browser,
        url,
        mode,
        effectiveMode: result.effectiveMode,
        window: result.readiness?.window ?? result.targetWindow,
        attempts: result.attempts,
        wasNewWindow: result.wasNewWindow,
        readiness: result.readiness ?? { ready: false, mode: readinessMode, reason: "dry-run" },
      };
      return {
        content: [
          {
            type: "text",
            text: dryRun
              ? `DRY_RUN open ${url} in ${browser} (${result.effectiveMode})`
              : JSON.stringify(output, null, 2),
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      await audit("browser_open_url", payload, dryRun, {
        result: "error",
        errorCode: error instanceof HyprlandError ? error.code : "APP_LAUNCH_FAILED",
        durationMs: Date.now() - started,
      });
      throw error;
    }
  },
);

server.registerTool(
  "browser_action",
  {
    title: "Browser Action",
    description:
      "Use shared browser shortcuts for history, reload, stop, tab selection, and page search. These foreground actions require subsequent page verification.",
    inputSchema: {
      ...browserTarget,
      action: z.enum(["back", "forward", "reload", "stop", "next-tab", "previous-tab", "select-tab", "find"]),
      tabIndex: z.number().int().min(1).max(9).optional(),
      query: z.string().min(1).max(160).optional(),
    },
    annotations: MUTATING,
  },
  async ({ browser, windowId, titleContains, action, tabIndex, query }) => {
    if (action === "select-tab" && !tabIndex)
      throw new HyprlandError("INPUT_FAILED", "select-tab requires --tab-index 1 through 9; 9 selects the last tab");
    if (action === "find" && !query) throw new HyprlandError("INPUT_FAILED", "find requires --query");
    if (action !== "find" && query !== undefined)
      throw new HyprlandError("INPUT_FAILED", "--query is only valid for find");
    if (action !== "select-tab" && tabIndex !== undefined)
      throw new HyprlandError("INPUT_FAILED", "--tab-index is only valid for select-tab");
    if (query && /[\r\n\t]/.test(query))
      throw new HyprlandError("INPUT_FAILED", "Browser search must be a single line");
    if (query) sanitizeTypedText(query);
    const windows = await listWindows({ includeHidden: false });
    const identity = selectBrowser(windows, browser, windowId, null, titleContains);
    const payload = { browser: identity, windowId, action, tabIndex, queryLength: query?.length };
    await audit("browser_action", payload, dryRun, { status: "started" });
    try {
      const window = await focusBrowserWindow(windows, { browser: identity, windowId, titleContains }, !dryRun);
      if (!dryRun) {
        const shortcuts: Record<string, [string, string]> = {
          back: ["ALT", "LEFT"],
          forward: ["ALT", "RIGHT"],
          reload: ["CTRL", "R"],
          stop: ["", "ESCAPE"],
          "next-tab": ["CTRL", "TAB"],
          "previous-tab": ["CTRL SHIFT", "TAB"],
          "select-tab": ["CTRL", String(tabIndex)],
          find: ["CTRL", "F"],
        };
        await assertBrowserFocus(window.id);
        await sendShortcut(...shortcuts[action]);
        if (action === "find") {
          await assertBrowserFocus(window.id);
          await typeWithWtype(query!);
        }
      }
      await audit("browser_action", { ...payload, windowId: window.id }, dryRun, { result: "ok" });
      const output = { sent: !dryRun, dryRun, browser: identity, action, window, verificationRequired: !dryRun };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    } catch (error) {
      await audit("browser_action", payload, dryRun, {
        result: "error",
        errorCode: error instanceof HyprlandError ? error.code : "INPUT_FAILED",
      });
      throw error;
    }
  },
);

server.registerTool(
  "browser_vimium_hint",
  {
    title: "Browser Vimium Hint",
    description:
      "Send an observed Vimium hint label to a configured extension in any supported browser. commit=false opens hints without typing. Verify the resulting page; no Enter is sent because hints can activate automatically.",
    inputSchema: {
      ...browserTarget,
      visibleText: z
        .string()
        .min(1)
        .max(160)
        .describe("Observed hint label or a filter for an explicitly configured filtering mode."),
      commit: z.boolean().default(true),
      actionKind: z
        .enum(["read", "navigate", "type-field", "send", "commit-submit", "destructive", "payment"])
        .default("navigate"),
      confirmed: z.boolean().default(false),
      focusSettleMs: z.number().int().min(0).max(3000).default(120),
      hintSettleMs: z.number().int().min(0).max(3000).default(120),
      typeDelayMs: z.number().int().min(0).max(1000).default(0),
    },
    annotations: MUTATING,
  },
  async ({
    visibleText,
    browser,
    windowId,
    titleContains,
    commit,
    actionKind,
    confirmed,
    focusSettleMs,
    hintSettleMs,
    typeDelayMs,
  }) => {
    const safeText = sanitizeTypedText(visibleText);
    if (/[\r\n\t]/.test(safeText)) throw new HyprlandError("INPUT_FAILED", "Vimium hint must be a single line");
    if (commit && GATED_BROWSER_ACTIONS.has(actionKind as BrowserGatedAction) && !confirmed)
      throw new HyprlandError("INPUT_FAILED", `Vimium ${actionKind} requires confirmed=true before sending hints`);
    const windows = await listWindows({ includeHidden: false });
    const identity = selectBrowser(windows, browser, windowId, null, titleContains);
    const payload = { browser: identity, windowId, visibleTextLength: safeText.length, commit, actionKind, confirmed };
    await audit("browser_vimium_hint", payload, dryRun, { status: "started" });
    try {
      const window = await focusBrowserWindow(windows, { browser: identity, windowId, titleContains }, !dryRun);
      if (!dryRun) {
        if (focusSettleMs) await new Promise((resolve) => setTimeout(resolve, focusSettleMs));
        await assertBrowserFocus(window.id);
        await sendShortcut("", "ESCAPE");
        await assertBrowserFocus(window.id);
        await sendShortcut("", "F");
        if (hintSettleMs) await new Promise((resolve) => setTimeout(resolve, hintSettleMs));
        if (commit) {
          await assertBrowserFocus(window.id);
          await typeWithWtype(safeText, typeDelayMs);
        }
      }
      await audit("browser_vimium_hint", { ...payload, windowId: window.id }, dryRun, { result: "ok" });
      const output = {
        hinted: !dryRun,
        dryRun,
        hintTextSent: !dryRun && commit,
        window,
        actionKind,
        verificationRequired: !dryRun,
      };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    } catch (error) {
      await audit("browser_vimium_hint", payload, dryRun, {
        result: "error",
        errorCode: error instanceof HyprlandError ? error.code : "INPUT_FAILED",
      });
      throw error;
    }
  },
);

server.registerTool(
  "browser_space_step",
  {
    title: "Browser Space Step",
    description:
      "Step Zen workspaces using a configured shortcut. This Zen-only action returns an opposite restore action; verify the resulting workspace.",
    inputSchema: {
      direction: z.enum(["forward", "backward"]),
      count: z.number().int().min(1).max(10).default(1),
      windowId: browserTarget.windowId,
      titleContains: browserTarget.titleContains,
      settleMs: z.number().int().min(0).max(3000).default(120),
    },
    annotations: MUTATING,
  },
  async ({ direction, count, windowId, titleContains, settleMs }) => {
    // Resolve configuration before focusing so an unsupported action has no desktop side effects.
    const shortcut = await requireZenShortcut(direction === "forward" ? "workspaceForward" : "workspaceBackward");
    const hyprShortcut = shortcutToHypr(shortcut);
    const payload = { direction, count, windowId, shortcut: hyprShortcut.label };
    await audit("browser_space_step", payload, dryRun, { status: "started" });
    try {
      const window = await focusZenWindow(
        await listWindows({ includeHidden: false }),
        { windowId, titleContains },
        !dryRun,
      );
      if (!dryRun)
        for (let i = 0; i < count; i += 1) {
          await assertBrowserFocus(window.id);
          await sendShortcut(hyprShortcut.mods, hyprShortcut.key);
          if (settleMs && i < count - 1) await new Promise((resolve) => setTimeout(resolve, settleMs));
        }
      await audit("browser_space_step", { ...payload, windowId: window.id }, dryRun, { result: "ok" });
      const output = {
        stepped: !dryRun,
        dryRun,
        direction,
        count,
        window,
        restore: { direction: direction === "forward" ? "backward" : "forward", count },
        verificationRequired: !dryRun,
      };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    } catch (error) {
      await audit("browser_space_step", payload, dryRun, {
        result: "error",
        errorCode: error instanceof HyprlandError ? error.code : "INPUT_FAILED",
      });
      throw error;
    }
  },
);
