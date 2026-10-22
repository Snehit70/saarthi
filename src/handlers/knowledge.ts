import { z } from "zod";
import { server } from "../registry.js";
import { readPrivateJson } from "../lib/private-json.js";
import { lookupKnowledge, rememberKnowledge } from "../lib/workflow-knowledge.js";
import { audit } from "../lib/audit.js";
import { dryRun } from "../runtime.js";

server.registerTool(
  "knowledge_lookup",
  {
    title: "Knowledge Lookup",
    description:
      "Find private local app/profile mappings and workflow observations, including failures and expiry. Results are evidence to revalidate, never executable commands or live coordinates.",
    inputSchema: {
      query: z.string().min(1).max(200),
      app: z.string().min(1).max(80).optional(),
      profile: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(20).default(6),
    },
    annotations: { readOnlyHint: true, desktopInput: false },
  },
  async (args) => {
    const result = await lookupKnowledge(args.query, args.app, args.profile, args.limit);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  },
);

server.registerTool(
  "knowledge_remember",
  {
    title: "Knowledge Remember",
    description:
      "Record or refine a private workflow observation from a mode-600 JSON file. Requires evidence and outcome. Stores local Markdown and JSON, without executing stored steps.",
    inputSchema: { entryFile: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: false, desktopInput: false },
  },
  async (args) => {
    const entry = await readPrivateJson(args.entryFile);
    await audit("knowledge_remember", {}, dryRun, { status: "started" });
    try {
      const result = dryRun ? { acted: false, dryRun: true } : await rememberKnowledge(entry);
      await audit("knowledge_remember", {}, dryRun, { result: "ok" });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      await audit("knowledge_remember", {}, dryRun, { result: "error" });
      throw error;
    }
  },
);
