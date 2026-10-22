import { z } from "zod";
import { server } from "../registry.js";
import { audit } from "../lib/audit.js";
import { exportClipboardImages, listClipboardImages, pasteClipboardImages } from "../lib/clipboard.js";
import { dryRun } from "../runtime.js";
import type { WindowId } from "../lib/types.js";

const selection = {
  count: z.number().int().min(1).max(20).default(4),
  ids: z.array(z.string().regex(/^\d+$/)).min(1).max(20).optional(),
};
server.registerTool(
  "clipboard_images",
  {
    title: "Clipboard Images",
    description: "List recent image history metadata without returning text clipboard previews.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => {
    const images = await listClipboardImages(limit);
    return { content: [{ type: "text", text: JSON.stringify({ images }) }], structuredContent: { images } };
  },
);
server.registerTool(
  "clipboard_export_images",
  {
    title: "Clipboard Export Images",
    description:
      "Export the last N images or explicit history ids to private local files. Does not change the selection.",
    inputSchema: selection,
    annotations: { readOnlyHint: true },
  },
  async ({ count, ids }) => {
    const images = await exportClipboardImages(ids?.length ?? count, ids);
    return { content: [{ type: "text", text: JSON.stringify({ images }) }], structuredContent: { images } };
  },
);
server.registerTool(
  "clipboard_paste_images",
  {
    title: "Clipboard Paste Images",
    description:
      "Paste selected history images only into an exactly named, focused, editable accessibility field in a validated window. Never presses Enter; verify attachment count afterward. Restores the prior preferred clipboard MIME when it still owns the selection.",
    inputSchema: {
      ...selection,
      windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
      targetName: z.string().min(1).max(200),
      settleMs: z.number().int().min(0).max(3000).default(250),
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => {
    const payload = { windowId: args.windowId, targetName: args.targetName, count: args.ids?.length ?? args.count };
    await audit("clipboard_paste_images", payload, dryRun, { status: "started" });
    try {
      const result = await pasteClipboardImages({
        ...args,
        count: payload.count,
        windowId: args.windowId as WindowId,
        dryRun,
      });
      await audit("clipboard_paste_images", payload, dryRun, {
        result: "ok",
        afterState: { sentImages: result.sentImages },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      await audit("clipboard_paste_images", payload, dryRun, { result: "error", errorCode: "INPUT_FAILED" });
      throw error;
    }
  },
);
