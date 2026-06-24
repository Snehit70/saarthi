import { beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createHash } from "node:crypto";

vi.mock("../src/lib/hyprland.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/lib/hyprland.js");
  const { makeHyprlandMock } = await import("./_hypr-fixtures.js");
  return makeHyprlandMock(actual);
});

const EXPECTED_TOOLS = [
  "action_step", "action_verify_window_state", "app_launch", "app_launch_and_wait", "app_list",
  "browser_discover", "browser_focus", "browser_open_url", "browser_space_step", "browser_vimium_hint",
  "click_text", "click_wait_retry", "desktop_health", "desktop_screenshot", "desktop_screenshot_area",
  "desktop_screenshot_save", "find_text_on_screen", "grid_cell_rect", "grid_cell_to_point", "grid_click",
  "grid_hide", "grid_move", "grid_show", "key_press", "metrics_report", "mouse_click", "mouse_drag",
  "mouse_get_position", "mouse_move", "mouse_move_to_text", "mouse_scroll", "mouse_verify_in_view",
  "overlay_task_complete", "overlay_task_ping", "overlay_task_start", "resolve_text_point", "screenshot_compare",
  "session_trace_export", "tmux_capture", "tmux_list", "tmux_run_command", "tmux_send_keys", "type_text",
  "ui_find", "ui_tree", "wait_for_stable", "wait_for_text", "window_find", "window_focus",
  "window_focus_and_type", "window_focus_best", "window_get", "window_list", "window_move", "window_resize",
  "window_send_to_workspace", "window_wait_for", "workspace_focus", "workspace_focus_relative", "workspace_list",
  "workspace_pick_empty", "workspace_topology",
].sort();

describe("CLI registry contract", () => {
  beforeAll(async () => {
    process.env.SAARTHI_DRY_RUN = "1";
    process.env.SAARTHI_STATUS = "0";
    await import("../src/register-tools.js");
  });

  it("preserves the complete tool and schema surface", async () => {
    const { registry } = await import("../src/registry.js");
    const tools = registry.list();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(new Set(tools.map((tool) => `${tool.noun} ${tool.verb}`)).size).toBe(EXPECTED_TOOLS.length);
    for (const tool of tools) {
      expect(tool.config.inputSchema).toBeTruthy();
      expect(tool.config.description).toBeTruthy();
    }
  });

  it("matches the committed command and zod schema snapshot", async () => {
    const { registry } = await import("../src/registry.js");
    const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
      let current = schema;
      while (current._def.innerType || current._def.schema) current = current._def.innerType ?? current._def.schema;
      return current;
    };
    const signature = registry.list().sort((a, b) => a.name.localeCompare(b.name)).map((tool) => {
      const schema = {
        command: `${tool.noun} ${tool.verb}`,
        readOnly: tool.config.annotations?.readOnlyHint === true,
        fields: Object.fromEntries(Object.entries(tool.config.inputSchema).map(([field, schema]) => {
          const base = unwrap(schema);
          const defaultResult = schema.safeParse(undefined);
          return [field, {
            type: base._def.typeName,
            optionalOrDefaulted: defaultResult.success,
            defaultValue: defaultResult.success ? defaultResult.data : undefined,
            enumValues: base._def.values,
            checks: base._def.checks?.map((check: Record<string, unknown>) => ({
              ...check,
              regex: check.regex instanceof RegExp ? check.regex.toString() : check.regex,
            })),
          }];
        })),
      };
      return {
        tool: tool.name,
        command: schema.command,
        schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
      };
    });
    expect(signature).toMatchSnapshot();
  });
});
