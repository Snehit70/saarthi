import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { server, type ToolResult } from "../registry.js";
import {
  desktopIdSchema,
  startDesktop,
  withIsolatedDesktop,
  desktopWindows,
  assertDesktop,
  stopDesktop,
} from "../lib/isolated-desktop.js";
import { isolatedEnvironment } from "../lib/isolated-environment.js";
import { launchIsolated } from "../lib/isolated-launch.js";
import { runIsolatedActions } from "../lib/isolated-input.js";
import { readPrivateJson } from "../lib/private-json.js";
import { persistCapture } from "../lib/capture-artifact.js";
import { audit } from "../lib/audit.js";
import { dryRun } from "../runtime.js";
import { inputOwnershipSignal } from "../lib/input-ownership.js";

const run = promisify(execFile);
const annotations = { desktopInput: false, readOnlyHint: false };
const idInput = { desktopId: desktopIdSchema };
const output = (result: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});
async function operation(
  name: string,
  payload: Record<string, unknown>,
  execute: () => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  await audit(name, payload, dryRun, { status: "started" });
  try {
    const result = dryRun ? { dryRun: true, acted: false } : await execute();
    await audit(name, payload, dryRun, { result: "ok" });
    return output(result);
  } catch (error) {
    await audit(name, payload, dryRun, {
      result: "error",
      errorCode: (error as { code?: string }).code ?? "INPUT_FAILED",
    });
    throw error;
  }
}
server.registerTool(
  "desktop_start",
  {
    description:
      "Start an explicitly requested private headless desktop with its own seat, cursor, keyboard focus and session bus. No physical input or host display connection.",
    inputSchema: {
      name: z.string().min(1).max(80).default("Saarthi worker"),
      width: z.number().int().min(320).max(3840).default(1280),
      height: z.number().int().min(240).max(2160).default(800),
    },
    annotations,
  },
  (args) =>
    operation(
      "desktop_start",
      { width: args.width, height: args.height },
      async () => ({
        desktop: await startDesktop(args.name, args.width, args.height),
        hostInputRequested: false,
      }),
    ),
);
server.registerTool(
  "desktop_status",
  {
    description:
      "Inspect a specific isolated desktop and its native window ids. Never discovers the user's compositor as a fallback.",
    inputSchema: idInput,
    annotations: { ...annotations, readOnlyHint: true },
  },
  (args) =>
    operation("desktop_status", { desktopId: args.desktopId }, () =>
      withIsolatedDesktop(args.desktopId, async (record) => {
        let running = false;
        try {
          await assertDesktop(record);
          running = true;
        } catch {}
        return {
          desktop: record,
          running,
          windows: running ? await desktopWindows(record) : [],
        };
      }),
    ),
);
server.registerTool(
  "desktop_launch",
  {
    description:
      "Launch an installed policy-approved app inside one private desktop. Browser aliases use dedicated profiles to prevent forwarding into the host session.",
    inputSchema: {
      ...idInput,
      appName: z.string().min(1).max(64),
      filesFile: z.string().min(1).max(4096).optional(),
      url: z.string().min(1).max(8192).optional(),
    },
    annotations,
  },
  async (args) => {
    const files = args.filesFile ? await readPrivateJson(args.filesFile) : [];
    return operation(
      "desktop_launch",
      { desktopId: args.desktopId, appName: args.appName },
      () =>
        withIsolatedDesktop(args.desktopId, (record) =>
          launchIsolated(record, args.appName, files, args.url),
        ),
    );
  },
);
server.registerTool(
  "desktop_input",
  {
    description:
      "Execute 1–10 typed mouse/keyboard/focus actions from a private JSON file in a validated isolated desktop. Requires exact private window id and PID; stops on failure without replay.",
    inputSchema: { ...idInput, actionsFile: z.string().min(1).max(4096) },
    annotations,
  },
  async (args) => {
    const actions = await readPrivateJson(args.actionsFile);
    return operation("desktop_input", { desktopId: args.desktopId }, () =>
      withIsolatedDesktop(args.desktopId, (record) =>
        runIsolatedActions(record, actions),
      ),
    );
  },
);
server.registerTool(
  "desktop_capture",
  {
    description:
      "Capture the private headless desktop, optionally including its cursor, without viewing or moving the host workspace.",
    inputSchema: { ...idInput, cursor: z.boolean().default(true) },
    annotations: { ...annotations, readOnlyHint: true },
  },
  (args) =>
    operation("desktop_capture", { desktopId: args.desktopId }, () =>
      withIsolatedDesktop(args.desktopId, async (record) => {
        await assertDesktop(record);
        const capture = await run(
          "grim",
          [...(args.cursor ? ["-c"] : []), "-o", "HEADLESS-1", "-"],
          {
            env: isolatedEnvironment(record.id, record.display),
            encoding: "buffer",
            timeout: 10000,
            maxBuffer: 25 * 1024 * 1024,
            signal: inputOwnershipSignal(),
          },
        );
        await assertDesktop(record);
        return persistCapture({
          png: Buffer.from(capture.stdout),
          desktopId: record.id,
          captureMethod: "isolated-output",
          hostInputRequested: false,
        });
      }),
    ),
);
server.registerTool(
  "desktop_stop",
  {
    description:
      "Stop only processes carrying this private desktop's runtime/id markers, including orphaned app children. Never signals the host compositor.",
    inputSchema: idInput,
    annotations,
  },
  (args) =>
    operation("desktop_stop", { desktopId: args.desktopId }, () =>
      withIsolatedDesktop(args.desktopId, stopDesktop),
    ),
);
