import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Boots the real saarthi MCP server in-process against an in-memory client.
// This exercises the full stack — transport, tool registration, the status-feed
// registerTool wrapper, handlers, and side-effect files — deterministically:
//   * dry-run is on, so mutating tools never touch the desktop;
//   * HOME points at a throwaway dir, so status.json / audit.jsonl are real and
//     inspectable;
//   * lib/hyprland.js is expected to be vi.mock()'d by the calling test file.

export interface BootedClient {
  client: Client;
  home: string;
  statusPath: string;
  auditPath: string;
}

export async function bootClient(): Promise<BootedClient> {
  const home = mkdtempSync(join(tmpdir(), "saarthi-test-"));
  // Must be set before importing modules that read them at load time.
  process.env.HOME = home;
  process.env.USE_MCP_DRY_RUN = "1";
  process.env.SAARTHI_SESSION_ID = "test-session";
  process.env.SAARTHI_STATUS = "1";

  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  // Mirror index.ts's side-effect imports (registers every tool), minus the
  // stdio transport / main() / process signal handlers.
  const { server } = await import("../src/server.js");
  await import("../src/runtime.js");
  await import("../src/handlers/windows.js");
  await import("../src/handlers/workspaces.js");
  await import("../src/handlers/apps.js");
  await import("../src/handlers/screenshots.js");
  await import("../src/handlers/input.js");
  await import("../src/handlers/mouse.js");
  await import("../src/handlers/grid.js");
  await import("../src/handlers/text.js");
  await import("../src/handlers/observability.js");
  await import("../src/handlers/observe.js");
  await import("../src/handlers/perception.js");
  await import("../src/handlers/composite.js");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "saarthi-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    home,
    statusPath: join(home, ".local", "state", "saarthi", "status.json"),
    auditPath: join(home, ".local", "state", "saarthi", "audit.jsonl"),
  };
}
