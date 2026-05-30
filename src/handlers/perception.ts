import { z } from "zod";
import { queryAtspi } from "../lib/atspi.js";
import { server } from "../server.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ── ui_find ──────────────────────────────────────────────────────────────
// Structured, addressable UI elements via the accessibility tree (AT-SPI).
// Returns screen-coordinate centers (cx,cy) ready for mouse_click with
// target:"full". Far more reliable than OCR for apps that expose a11y
// (GTK/Qt and most native apps; browsers/Electron only with a11y enabled).
server.registerTool(
  "ui_find",
  {
    title: "UI Find",
    description:
      "Find on-screen UI elements from the accessibility tree (roles, names, screen coordinates). Returns clickable centers (cx,cy) for mouse_click target:'full'. More reliable than OCR where apps expose accessibility.",
    inputSchema: {
      nameContains: z.string().max(200).optional().describe("Case-insensitive substring match on the element's accessible name."),
      role: z.string().max(40).optional().describe("Exact AT-SPI role, e.g. 'push button', 'entry', 'link'."),
      interactive: z.boolean().default(true).describe("Restrict to interactive roles (buttons, entries, links, menu items, …)."),
      focused: z.boolean().default(true).describe("Limit to the focused application (resolved via the active window's pid)."),
      appName: z.string().max(100).optional().describe("Limit to applications whose name contains this string."),
      pid: z.number().int().positive().optional().describe("Limit to a specific application process id."),
      includeOffscreen: z.boolean().default(false),
      maxDepth: z.number().int().min(1).max(40).default(16),
      maxNodes: z.number().int().min(1).max(2000).default(300),
    },
    annotations: READ_ONLY,
  },
  async ({ nameContains, role, interactive, focused, appName, pid, includeOffscreen, maxDepth, maxNodes }) => {
    // appName/pid override the implicit focused-app scope
    const useFocused = focused && !appName && pid === undefined;
    const result = await queryAtspi({
      mode: "find",
      focused: useFocused,
      pid,
      appName,
      role,
      nameContains,
      interactive,
      includeOffscreen,
      maxDepth,
      maxNodes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);

// ── ui_tree ────────────────────────────────────────────────────────────────
server.registerTool(
  "ui_tree",
  {
    title: "UI Tree",
    description:
      "Dump the accessibility tree of an application (focused by default) as a flat list of elements with roles, names, depth, states, and screen coordinates. For planning/inspection.",
    inputSchema: {
      focused: z.boolean().default(true),
      appName: z.string().max(100).optional(),
      pid: z.number().int().positive().optional(),
      includeOffscreen: z.boolean().default(true),
      maxDepth: z.number().int().min(1).max(40).default(18),
      maxNodes: z.number().int().min(1).max(2000).default(500),
    },
    annotations: READ_ONLY,
  },
  async ({ focused, appName, pid, includeOffscreen, maxDepth, maxNodes }) => {
    const useFocused = focused && !appName && pid === undefined;
    const result = await queryAtspi({
      mode: "tree",
      focused: useFocused,
      pid,
      appName,
      includeOffscreen,
      maxDepth,
      maxNodes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
);
