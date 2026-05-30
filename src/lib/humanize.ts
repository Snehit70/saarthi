// Turns a tool name + its arguments into a short, human-readable label for the
// overlay HUD (e.g. `click_text` + {query:"Submit"} -> `Clicking "Submit"`).

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function quote(s: string, max = 40): string {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return `"${t}"`;
}

export function humanizeAction(tool: string, rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

  switch (tool) {
    case "type_text":
    case "window_focus_and_type": {
      const text = str(args, "text");
      return text ? `Typing ${quote(text)}` : "Typing";
    }
    case "key_press": {
      const mods = Array.isArray(args.modifiers) ? (args.modifiers as unknown[]).join("+") : "";
      const key = str(args, "key") ?? "";
      const combo = [mods, key].filter(Boolean).join("+");
      return combo ? `Pressing ${combo}` : "Pressing key";
    }
    case "click_text":
    case "mouse_move_to_text":
    case "resolve_text_point": {
      const q = str(args, "query") ?? str(args, "text");
      return q ? `Clicking ${quote(q)}` : "Clicking text";
    }
    case "find_text_on_screen": {
      const q = str(args, "query") ?? str(args, "text");
      return q ? `Looking for ${quote(q)}` : "Reading screen";
    }
    case "click_wait_retry":
      return "Clicking and waiting";
    case "action_step":
      return str(args, "label") ?? "Running step";
    case "app_launch":
    case "app_launch_and_wait": {
      const app = str(args, "appName") ?? str(args, "command");
      return app ? `Launching ${app}` : "Launching app";
    }
    case "window_focus":
    case "window_focus_best":
      return "Focusing window";
    case "window_move":
      return "Moving window";
    case "window_resize":
      return "Resizing window";
    case "window_send_to_workspace":
      return "Moving window to workspace";
    case "window_wait_for":
      return "Waiting for window";
    case "action_verify_window_state":
      return "Verifying window state";
    case "workspace_focus":
    case "workspace_focus_relative":
      return "Switching workspace";
    case "mouse_click":
    case "grid_click":
      return "Clicking";
    case "mouse_move":
    case "grid_move":
      return "Moving cursor";
    case "mouse_scroll":
      return "Scrolling";
    case "grid_show":
      return "Showing grid";
    case "grid_hide":
      return "Hiding grid";
    case "desktop_screenshot":
    case "desktop_screenshot_save":
    case "desktop_screenshot_area":
      return "Taking screenshot";
    case "window_list":
    case "window_find":
    case "window_get":
      return "Inspecting windows";
    case "workspace_list":
    case "workspace_topology":
    case "workspace_pick_empty":
      return "Inspecting workspaces";
    case "app_list":
      return "Listing apps";
    case "desktop_health":
      return "Checking desktop";
    case "metrics_report":
      return "Computing metrics";
    case "session_trace_export":
      return "Exporting trace";
    default:
      return tool.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}
