import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { emitActive, emitDone } from "./lib/status.js";
import { humanizeAction } from "./lib/humanize.js";

export const server = new McpServer({
  name: "saarthi",
  version: "0.1.0",
});

// Instrument every tool registration with a status feed for the overlay HUD.
// One wrapper here covers all handler modules; emission is best-effort and never
// alters the tool result or error. registerTool is heavily overloaded in the
// SDK, so the wrapper uses loose internal typing and re-casts to the real shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
const originalRegisterTool = server.registerTool.bind(server);

server.registerTool = ((name: string, config: any, handler: (...handlerArgs: any[]) => any) => {
  const kind = config?.annotations?.readOnlyHint === true ? "read" : "act";
  const wrapped = async (...handlerArgs: any[]) => {
    const id = emitActive(name, kind, humanizeAction(name, handlerArgs[0]));
    try {
      const result = await handler(...handlerArgs);
      emitDone(id, true);
      return result;
    } catch (error) {
      emitDone(id, false);
      throw error;
    }
  };
  return (originalRegisterTool as any)(name, config, wrapped);
}) as typeof server.registerTool;
