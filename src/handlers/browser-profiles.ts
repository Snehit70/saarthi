import { z } from "zod";
import { server } from "../registry.js";
import { BROWSERS, BROWSER_IDS } from "../lib/browser-catalog.js";
import { discoverBrowserProfiles } from "../lib/browser-profiles.js";
server.registerTool(
  "browser_profiles",
  {
    description:
      "List existing Chromium-family profile directories and display names from bounded local metadata. Does not open browsers, inspect credentials or create profiles. Numeric positions are not profile identities.",
    inputSchema: { browser: z.enum(["auto", ...BROWSER_IDS]).default("auto") },
    annotations: {
      readOnlyHint: true,
      desktopInput: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ browser }) => {
    const selected = BROWSERS.filter(
      (row) =>
        row.family === "chromium" && (browser === "auto" || row.id === browser),
    );
    const profiles = (
      await Promise.all(selected.map((row) => discoverBrowserProfiles(row.id)))
    ).flat();
    const result = {
      profiles,
      count: profiles.length,
      selection:
        "Use exact directory or unique display name; never infer a profile from window title or numeric position",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);
