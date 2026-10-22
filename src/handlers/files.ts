import { z } from "zod";
import { server } from "../registry.js";
import { findFiles } from "../lib/file-discovery.js";
server.registerTool(
  "file_find",
  {
    description:
      "Find files by case-insensitive filename inside an explicit directory. Returns canonical paths, metadata and bounded signature-verified image matches without opening apps or following symlinks.",
    inputSchema: {
      directory: z.string().min(1).max(4096),
      nameContains: z.string().min(1).max(200),
      type: z.enum(["any", "image"]).default("any"),
      maxDepth: z.number().int().min(0).max(8).default(0),
      limit: z.number().int().min(1).max(100).default(40),
      maxVisited: z.number().int().min(1).max(50000).default(5000),
    },
    annotations: {
      readOnlyHint: true,
      desktopInput: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const result = await findFiles(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);
