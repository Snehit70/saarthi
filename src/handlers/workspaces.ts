import { z } from "zod";
import { audit } from "../lib/audit.js";
import {
  focusedWorkspaceName,
  hyprctlDispatch,
  HyprlandError,
  listWorkspaces,
  listMonitors,
  listWindows,
  pickFirstEmptyWorkspace,
} from "../lib/hyprland.js";
import { isNumericWorkspaceName } from "../lib/util.js";
import { pickWorkspaceForMonitor } from "../lib/workspace.js";
import { server } from "../server.js";
import { dryRun, policy } from "../runtime.js";

server.registerTool(
  "workspace_list",
  {
    title: "Workspace List",
    description: "List workspaces with occupancy details.",
    inputSchema: {
      includeWindowCounts: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ includeWindowCounts }) => {
    const [workspaces, windows] = await Promise.all([listWorkspaces(), includeWindowCounts ? listWindows({ includeHidden: false }) : []]);
    const counts = new Map<string, number>();
    if (includeWindowCounts) {
      for (const w of windows) {
        counts.set(w.workspace, (counts.get(w.workspace) ?? 0) + 1);
      }
    }
    const out = workspaces.map((ws) => ({
      ...ws,
      windowCount: includeWindowCounts ? counts.get(ws.name) ?? 0 : undefined,
      isEmpty: includeWindowCounts ? (counts.get(ws.name) ?? 0) === 0 : undefined,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: { workspaces: out },
    };
  },
);

server.registerTool(
  "workspace_topology",
  {
    title: "Workspace Topology",
    description: "Return monitor layout and workspace-to-monitor topology with left/right neighbors.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const [monitors, workspaces, focusedWorkspace] = await Promise.all([listMonitors(), listWorkspaces(), focusedWorkspaceName()]);
    const orderedMonitors = [...monitors].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const monitorIndexByName = new Map(orderedMonitors.map((m, i) => [m.name, i]));

    const monitorColumns = orderedMonitors.map((m, i) => ({
      name: m.name,
      index: i,
      geometry: { x: m.x, y: m.y, width: m.width, height: m.height },
      focused: m.focused,
      leftNeighbor: i > 0 ? orderedMonitors[i - 1].name : null,
      rightNeighbor: i < orderedMonitors.length - 1 ? orderedMonitors[i + 1].name : null,
    }));

    const workspaceMap = workspaces
      .map((w) => ({
        id: w.id,
        name: w.name,
        monitor: w.monitor,
        monitorIndex: w.monitor ? (monitorIndexByName.get(w.monitor) ?? null) : null,
        hasFullscreen: w.hasFullscreen,
        focused: focusedWorkspace !== null && w.name === focusedWorkspace,
      }))
      .sort((a, b) => a.id - b.id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              focusedWorkspace,
              monitors: monitorColumns,
              workspaces: workspaceMap,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        focusedWorkspace,
        monitors: monitorColumns,
        workspaces: workspaceMap,
      },
    };
  },
);

server.registerTool(
  "workspace_pick_empty",
  {
    title: "Workspace Pick Empty",
    description: "Pick first empty numeric workspace in a range.",
    inputSchema: {
      rangeStart: z.number().int().min(1).max(99).default(1),
      rangeEnd: z.number().int().min(1).max(99).default(10),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ rangeStart, rangeEnd }) => {
    const windows = await listWindows({ includeHidden: false });
    const workspace = pickFirstEmptyWorkspace(windows, rangeStart, rangeEnd);
    return {
      content: [{ type: "text", text: JSON.stringify({ workspace, rangeStart, rangeEnd }, null, 2) }],
      structuredContent: { workspace, rangeStart, rangeEnd },
    };
  },
);

server.registerTool(
  "workspace_focus_relative",
  {
    title: "Workspace Focus Relative",
    description: "Switch to workspace on the monitor left/right of the focused monitor.",
    inputSchema: {
      direction: z.enum(["left", "right"]),
      fallback: z.enum(["stay", "wrap"]).default("stay"),
      createIfAbsent: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ direction, fallback, createIfAbsent }) => {
    const [monitors, workspaces, focusedWorkspace, windows] = await Promise.all([
      listMonitors(),
      listWorkspaces(),
      focusedWorkspaceName(),
      listWindows({ includeHidden: false }),
    ]);
    const occupiedWorkspaceNames = new Set<string>([
      ...workspaces.map((w) => w.name),
      ...windows.filter((w) => isNumericWorkspaceName(w.workspace)).map((w) => w.workspace),
    ]);
    const orderedMonitors = [...monitors].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    if (orderedMonitors.length === 0) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "No monitors found");
    }
    const focusedMonitorIndex = orderedMonitors.findIndex((m) => m.focused);
    if (focusedMonitorIndex < 0) {
      throw new HyprlandError("WINDOW_NOT_FOUND", "Focused monitor not found");
    }

    let targetMonitorIndex = direction === "left" ? focusedMonitorIndex - 1 : focusedMonitorIndex + 1;
    if (targetMonitorIndex < 0 || targetMonitorIndex >= orderedMonitors.length) {
      if (fallback === "wrap") {
        targetMonitorIndex = targetMonitorIndex < 0 ? orderedMonitors.length - 1 : 0;
      } else {
        const currentName = orderedMonitors[focusedMonitorIndex].name;
        const currentWorkspace =
          focusedWorkspace ??
          workspaces.find((w) => w.monitor === currentName)?.name ??
          pickWorkspaceForMonitor(currentName, workspaces, occupiedWorkspaceNames, policy.workspace).name;
        const payload = {
          direction,
          fallback,
          createIfAbsent,
          changed: false,
          workspace: currentWorkspace,
          monitor: currentName,
          reason: "edge_no_neighbor",
          createdWorkspace: false,
        };
        await audit("workspace_focus_relative", payload, dryRun);
        if (dryRun) {
          return {
            content: [{ type: "text", text: `DRY_RUN workspace ${currentWorkspace}` }],
            structuredContent: payload,
          };
        }
        const out = await hyprctlDispatch("workspace", currentWorkspace);
        return {
          content: [{ type: "text", text: out || "ok" }],
          structuredContent: payload,
        };
      }
    }

    const targetMonitor = orderedMonitors[targetMonitorIndex];
    const targetWorkspaceInfo = pickWorkspaceForMonitor(targetMonitor.name, workspaces, occupiedWorkspaceNames, policy.workspace);
    if (targetWorkspaceInfo.exhausted) {
      const currentName = orderedMonitors[focusedMonitorIndex].name;
      const currentWorkspace =
        focusedWorkspace ??
        workspaces.find((w) => w.monitor === currentName)?.name ??
        String(policy.workspace.min);
      const payload = {
        direction,
        fallback,
        createIfAbsent,
        changed: false,
        workspace: currentWorkspace,
        monitor: currentName,
        reason: "no_available_numeric_workspace",
        createdWorkspace: false,
      };
      await audit("workspace_focus_relative", payload, dryRun);
      if (dryRun) {
        return {
          content: [{ type: "text", text: `DRY_RUN workspace ${currentWorkspace}` }],
          structuredContent: payload,
        };
      }
      const out = await hyprctlDispatch("workspace", currentWorkspace);
      return {
        content: [{ type: "text", text: out || "ok" }],
        structuredContent: payload,
      };
    }

    if (!createIfAbsent && targetWorkspaceInfo.created) {
      const currentName = orderedMonitors[focusedMonitorIndex].name;
      const currentWorkspace =
        focusedWorkspace ??
        workspaces.find((w) => w.monitor === currentName)?.name ??
        String(policy.workspace.min);
      const payload = {
        direction,
        fallback,
        createIfAbsent,
        changed: false,
        workspace: currentWorkspace,
        monitor: currentName,
        reason: "neighbor_absent_create_disabled",
        createdWorkspace: false,
      };
      await audit("workspace_focus_relative", payload, dryRun);
      if (dryRun) {
        return {
          content: [{ type: "text", text: `DRY_RUN workspace ${currentWorkspace}` }],
          structuredContent: payload,
        };
      }
      const out = await hyprctlDispatch("workspace", currentWorkspace);
      return {
        content: [{ type: "text", text: out || "ok" }],
        structuredContent: payload,
      };
    }
    const payload = {
      direction,
      fallback,
      createIfAbsent,
      changed: true,
      workspace: targetWorkspaceInfo.name,
      monitor: targetMonitor.name,
      reason: targetWorkspaceInfo.created ? "created_absent" : "neighbor_existing",
      createdWorkspace: targetWorkspaceInfo.created,
    };
    await audit("workspace_focus_relative", payload, dryRun);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `DRY_RUN workspace ${targetWorkspaceInfo.name}` }],
        structuredContent: payload,
      };
    }
    const out = await hyprctlDispatch("workspace", targetWorkspaceInfo.name);
    return {
      content: [{ type: "text", text: out || "ok" }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "workspace_focus",
  {
    title: "Workspace Focus",
    description: "Switch focus to a target workspace.",
    inputSchema: {
      workspace: z.string().min(1),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ workspace }) => {
    await audit("workspace_focus", { workspace }, dryRun);
    const params = workspace;

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY_RUN workspace ${params}` }] };
    }

    const output = await hyprctlDispatch("workspace", params);
    return { content: [{ type: "text", text: output || "ok" }] };
  },
);
