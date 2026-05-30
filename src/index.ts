import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatError } from "./lib/hyprland.js";
import { server } from "./server.js";
import "./runtime.js";
import "./handlers/windows.js";
import "./handlers/workspaces.js";
import "./handlers/apps.js";
import "./handlers/screenshots.js";
import "./handlers/input.js";
import "./handlers/mouse.js";
import "./handlers/grid.js";
import "./handlers/text.js";
import "./handlers/observability.js";
import "./handlers/observe.js";
import "./handlers/composite.js";

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = formatError(error);
  process.stderr.write(`saarthi fatal error: ${message}\n`);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
