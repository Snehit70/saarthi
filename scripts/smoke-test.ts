import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function fail(msg: string): never {
  process.stderr.write(`SMOKE FAIL: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const includeScreenshot = process.argv.includes("--with-screenshot");
  const command = process.platform === "win32" ? "node.exe" : "node";

  const transport = new StdioClientTransport({
    command,
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      USE_MCP_DRY_RUN: process.env.USE_MCP_DRY_RUN ?? "1",
    } as Record<string, string>,
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write(`[server] ${text}\n`);
    });
  }

  const client = new Client({ name: "saarthi-smoke", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = new Set((tools.tools ?? []).map((t) => t.name));
    const required = [
      "app_list",
      "desktop_health",
      "metrics_report",
      "session_trace_export",
      "desktop_screenshot",
      "desktop_screenshot_save",
      "workspace_list",
      "workspace_topology",
      "workspace_pick_empty",
      "app_launch",
      "window_wait_for",
      "app_launch_and_wait",
      "action_verify_window_state",
      "type_text",
      "window_focus_and_type",
      "window_list",
      "window_get",
      "window_find",
      "window_focus_best",
      "window_focus",
      "window_move",
      "window_resize",
      "workspace_focus",
      "workspace_focus_relative",
      "window_send_to_workspace",
      "key_press",
      "grid_show",
      "grid_cell_to_point",
      "grid_cell_rect",
      "grid_move",
      "grid_click",
      "grid_hide",
      "mouse_get_position",
      "mouse_verify_in_view",
      "resolve_text_point",
      "mouse_move_to_text",
      "click_text",
      "mouse_move",
      "mouse_click",
      "mouse_drag",
      "mouse_scroll",
      "find_text_on_screen",
      "click_wait_retry",
      "desktop_screenshot_area",
      "action_step",
      "wait_for_text",
      "wait_for_stable",
      "screenshot_compare",
      "ui_find",
      "ui_tree",
      "browser_discover",
      "browser_focus",
      "browser_open_url",
      "tmux_list",
      "tmux_capture",
      "tmux_run_command",
      "tmux_send_keys",
    ];

    for (const name of required) {
      if (!names.has(name)) fail(`missing tool: ${name}`);
    }

    const health = (await client.callTool({ name: "desktop_health", arguments: {} })) as ToolResult;
    if (health.isError) fail("desktop_health returned error");
    const metrics = (await client.callTool({ name: "metrics_report", arguments: { lastN: 200 } })) as ToolResult;
    if (metrics.isError) fail("metrics_report returned error");
    const trace = (await client.callTool({ name: "session_trace_export", arguments: { lastN: 100 } })) as ToolResult;
    if (trace.isError) fail("session_trace_export returned error");

    const apps = (await client.callTool({ name: "app_list", arguments: { installedOnly: false } })) as ToolResult;
    if (apps.isError) fail("app_list returned error");

    const wsList = (await client.callTool({ name: "workspace_list", arguments: { includeWindowCounts: true } })) as ToolResult;
    if (wsList.isError) fail("workspace_list returned error");
    const wsTopology = (await client.callTool({ name: "workspace_topology", arguments: {} })) as ToolResult;
    if (wsTopology.isError) fail("workspace_topology returned error");
    const wsRelative = (await client.callTool({
      name: "workspace_focus_relative",
      arguments: { direction: "right", fallback: "stay", createIfAbsent: true },
    })) as ToolResult;
    if (wsRelative.isError) fail("workspace_focus_relative returned error");

    const wsPick = (await client.callTool({ name: "workspace_pick_empty", arguments: { rangeStart: 1, rangeEnd: 10 } })) as ToolResult;
    if (wsPick.isError) fail("workspace_pick_empty returned error");

    const launch = (await client.callTool({
      name: "app_launch",
      arguments: { command: "true", preferEmptyWorkspace: true, rangeStart: 1, rangeEnd: 10, keepCurrentWorkspace: true },
    })) as ToolResult;
    if (launch.isError) fail("app_launch returned error");

    const waitTool = (await client.callTool({
      name: "window_wait_for",
      arguments: { focusedOnly: true, timeoutMs: 2000, pollMs: 100, includeHidden: false },
    })) as ToolResult;
    if (waitTool.isError) fail("window_wait_for returned error");

    const windowsResp = (await client.callTool({
      name: "window_list",
      arguments: { includeHidden: false },
    })) as ToolResult;
    if (windowsResp.isError) fail("window_list returned error");

    const windows = (windowsResp.structuredContent?.windows as Array<{ id: string; size?: { width?: number; height?: number } }> | undefined) ?? [];
    if (!Array.isArray(windows)) fail("window_list structured payload missing windows[]");

    const findResp = (await client.callTool({
      name: "window_find",
      arguments: { focusedOnly: true, limit: 1 },
    })) as ToolResult;
    if (findResp.isError) fail("window_find returned error");
    const focusBest = (await client.callTool({
      name: "window_focus_best",
      arguments: { includeHidden: false, limit: 3 },
    })) as ToolResult;
    if (focusBest.isError) fail("window_focus_best returned error");

    if (windows.length > 0) {
      const id = windows[0].id;
      const getResp = (await client.callTool({ name: "window_get", arguments: { windowId: id } })) as ToolResult;
      if (getResp.isError) fail("window_get returned error");

      const focus = (await client.callTool({ name: "window_focus", arguments: { windowId: id } })) as ToolResult;
      if (focus.isError) fail("window_focus returned error");

      const move = (await client.callTool({
        name: "window_move",
        arguments: { windowId: id, mode: "delta", x: 0, y: 0 },
      })) as ToolResult;
      if (move.isError) fail("window_move returned error");

      const resize = (await client.callTool({
        name: "window_resize",
        arguments: { windowId: id, mode: "delta", width: 0.1, height: 0.1 },
      })) as ToolResult;
      if (resize.isError) fail("window_resize returned error");

      const ws = (await client.callTool({
        name: "window_send_to_workspace",
        arguments: { windowId: id, workspace: "3" },
      })) as ToolResult;
      if (ws.isError) fail("window_send_to_workspace returned error");

      const verify = (await client.callTool({
        name: "action_verify_window_state",
        arguments: {
          windowId: id,
          expectedWidth: windows[0].size?.width ?? undefined,
          expectedHeight: windows[0].size?.height ?? undefined,
          tolerancePx: 4,
        },
      })) as ToolResult;
      if (verify.isError) fail("action_verify_window_state returned error");

      const inView = (await client.callTool({
        name: "mouse_verify_in_view",
        arguments: { target: "window", windowId: id },
      })) as ToolResult;
      if (inView.isError) fail("mouse_verify_in_view returned error");

      if (includeScreenshot) {
        const gridShow = (await client.callTool({
          name: "grid_show",
          arguments: { target: "window", windowId: id, filenamePrefix: "smoke-grid" },
        })) as ToolResult;
        if (gridShow.isError) fail("grid_show returned error");

        const cell = (await client.callTool({
          name: "grid_cell_to_point",
          arguments: { cellId: 1 },
        })) as ToolResult;
        if (cell.isError) fail("grid_cell_to_point returned error");
        const cellRect = (await client.callTool({
          name: "grid_cell_rect",
          arguments: { cellId: 1, insetPx: 0 },
        })) as ToolResult;
        if (cellRect.isError) fail("grid_cell_rect returned error");

        const gridMove = (await client.callTool({
          name: "grid_move",
          arguments: { cellId: 1, settleMs: 20 },
        })) as ToolResult;
        if (gridMove.isError) fail("grid_move returned error");

        const gridClick = (await client.callTool({
          name: "grid_click",
          arguments: { cellId: 1, button: "left", settleMs: 20 },
        })) as ToolResult;
        if (gridClick.isError) fail("grid_click returned error");

        const gridHide = (await client.callTool({
          name: "grid_hide",
          arguments: {},
        })) as ToolResult;
        if (gridHide.isError) fail("grid_hide returned error");
      }
    }

    const workspaceFocus = (await client.callTool({
      name: "workspace_focus",
      arguments: { workspace: "3" },
    })) as ToolResult;
    if (workspaceFocus.isError) fail("workspace_focus returned error");

    const launchWait = (await client.callTool({
      name: "app_launch_and_wait",
      arguments: {
        command: "true",
        classContains: "kitty",
        timeoutMs: 2000,
        pollMs: 100,
        keepCurrentWorkspace: true,
      },
    })) as ToolResult;
    if (launchWait.isError) fail("app_launch_and_wait returned error");

    const type = (await client.callTool({
      name: "type_text",
      arguments: { text: "smoke", delayMs: 0 },
    })) as ToolResult;
    if (type.isError) fail("type_text returned error");

    if (windows.length > 0) {
      const focusType = (await client.callTool({
        name: "window_focus_and_type",
        arguments: { windowId: windows[0].id, text: "smoke", focusSettleMs: 50, delayMs: 0 },
      })) as ToolResult;
      if (focusType.isError) fail("window_focus_and_type returned error");
    }

    if (includeScreenshot) {
      const ss = (await client.callTool({
        name: "desktop_screenshot",
        arguments: { target: "full" },
      })) as ToolResult;
      if (ss.isError) fail("desktop_screenshot returned error");
      const hasImage = (ss.content ?? []).some((c) => c.type === "image");
      if (!hasImage) fail("desktop_screenshot returned no image content");

      const save = (await client.callTool({
        name: "desktop_screenshot_save",
        arguments: { target: "full", filenamePrefix: "smoke" },
      })) as ToolResult;
      if (save.isError) fail("desktop_screenshot_save returned error");

      const area = (await client.callTool({
        name: "desktop_screenshot_area",
        arguments: { x: 0, y: 0, width: 160, height: 120 },
      })) as ToolResult;
      if (area.isError) fail("desktop_screenshot_area returned error");

      const step = (await client.callTool({
        name: "action_step",
        arguments: {
          action: "key_press",
          key: "escape",
          verify: "none",
          target: "full",
          filenamePrefix: "smoke-step",
          settleMs: 50,
        },
      })) as ToolResult;
      if (step.isError) fail("action_step returned error");
    }

    process.stdout.write(`SMOKE PASS: ${required.length} tools present, health/window calls succeeded, windows=${windows.length}\n`);
  } finally {
    await client.close();
    await transport.close();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
