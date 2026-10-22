import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  writeFile,
  rename,
  open,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HyprlandError } from "./hyprland.js";
import { resolveAppLaunchCommand } from "./apps.js";
import { parseLaunchCommand } from "./policy.js";
import { policy, assertLaunchRateLimit } from "../runtime.js";
import {
  isolatedEnvironment,
  isolatedRuntime,
  vendorCompositor,
} from "./isolated-environment.js";
import {
  ownsProcess,
  spawnOwned,
  terminateSession,
  sessionProcesses,
} from "./isolated-process.js";
import { readPrivateJson } from "./private-json.js";
import { statePath } from "./state.js";
import { swayRequest } from "./sway-ipc.js";
import { withDesktopInput } from "./input-ownership.js";
import { projectRoot } from "./paths.js";

const run = promisify(execFile);
export const desktopIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const processShape = z.object({
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^\d+$/),
});
export const desktopRecordSchema = z.object({
  id: desktopIdSchema,
  name: z.string().min(1).max(80),
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(240).max(2160),
  display: z.string().regex(/^wayland-\d+$/),
  compositor: processShape,
  bus: processShape,
  devices: processShape.optional(),
  keyboard: processShape.optional(),
  inputBlocked: z.boolean().optional(),
  status: z.enum(["running", "stopped"]),
  createdAt: z.string(),
});
export type DesktopRecord = z.infer<typeof desktopRecordSchema>;
export interface DesktopWindow {
  id: number;
  pid: number;
  appId: string | null;
  title: string | null;
  focused: boolean;
  rect: { x: number; y: number; width: number; height: number };
}
const recordPath = (id: string) =>
  statePath(`isolated/${desktopIdSchema.parse(id)}.json`);
export async function saveDesktop(record: DesktopRecord): Promise<void> {
  const path = recordPath(record.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function readDesktop(id: string): Promise<DesktopRecord> {
  const record = desktopRecordSchema.parse(
    await readPrivateJson(recordPath(id)),
  );
  if (record.id !== id)
    throw new HyprlandError("INPUT_FAILED", "Desktop record id mismatch");
  const runtime = isolatedRuntime(id);
  const metadata = await lstat(runtime);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    metadata.mode & 0o077 ||
    (await realpath(runtime)) !== runtime
  )
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private runtime ownership or permissions changed",
    );
  return record;
}
export async function assertDesktop(
  record: DesktopRecord,
  starting = false,
): Promise<void> {
  const runtime = isolatedRuntime(record.id);
  if (
    record.status !== "running" ||
    !(await ownsProcess(record.compositor, record.id, runtime)) ||
    !(await ownsProcess(record.bus, record.id, runtime))
  )
    throw new HyprlandError(
      "INPUT_FAILED",
      "Isolated desktop is no longer running; no host fallback is allowed",
    );
  if (
    (!record.devices && !starting) ||
    (record.devices && !(await ownsProcess(record.devices, record.id, runtime)))
  )
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private input devices disconnected; inspect the isolated desktop",
    );
  if (
    record.keyboard &&
    !(await ownsProcess(record.keyboard, record.id, runtime))
  )
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private keyboard disconnected; stop and recreate this desktop",
    );
  for (const name of ["ipc.sock", record.display, "bus"]) {
    const path = join(runtime, name);
    const socket = await lstat(path);
    if (
      !socket.isSocket() ||
      socket.uid !== process.getuid?.() ||
      (await realpath(path)) !== path
    )
      throw new HyprlandError(
        "INPUT_FAILED",
        "Private desktop socket is unavailable or changed",
      );
  }
}
export async function desktopRequest(
  record: DesktopRecord,
  type: 0 | 3 | 4 | 7 | 100 | 101,
  payload = "",
  starting = false,
): Promise<unknown> {
  await assertDesktop(record, starting);
  const value = await swayRequest(
    join(isolatedRuntime(record.id), "ipc.sock"),
    type,
    payload,
  );
  if (
    type === 0 &&
    (!Array.isArray(value) ||
      value.length === 0 ||
      value.some((row) => row.success !== true))
  )
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private compositor rejected the operation",
    );
  return value;
}
export function treeWindows(tree: unknown): DesktopWindow[] {
  const result: DesktopWindow[] = [];
  const stack: unknown[] = [tree];
  let visited = 0;
  while (stack.length) {
    if (++visited > 10000)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Private desktop tree exceeded traversal bound",
      );
    const node = z
      .object({
        id: z.number().int(),
        pid: z.number().int().nullable().optional(),
        app_id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        focused: z.boolean().optional(),
        rect: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        nodes: z.array(z.unknown()).optional(),
        floating_nodes: z.array(z.unknown()).optional(),
      })
      .parse(stack.pop());
    if (node.pid && node.pid > 0)
      result.push({
        id: node.id,
        pid: node.pid,
        appId: node.app_id ?? null,
        title: node.name ?? null,
        focused: node.focused === true,
        rect: node.rect,
      });
    stack.push(...(node.nodes ?? []), ...(node.floating_nodes ?? []));
  }
  return result;
}
export async function desktopWindows(
  record: DesktopRecord,
): Promise<DesktopWindow[]> {
  return treeWindows(await desktopRequest(record, 4));
}
export async function withIsolatedDesktop<T>(
  id: string,
  operation: (record: DesktopRecord) => Promise<T>,
): Promise<T> {
  desktopIdSchema.parse(id);
  return withDesktopInput(
    async () => operation(await readDesktop(id)),
    statePath(`isolated/${id}.lock`),
    "this isolated desktop",
  );
}
export async function startDesktop(
  name: string,
  width: number,
  height: number,
): Promise<DesktopRecord> {
  return withDesktopInput(
    async () => {
      const index = statePath("isolated");
      await mkdir(index, { recursive: true, mode: 0o700 });
      let running = 0;
      for (const file of await readdir(index)) {
        if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
        // Login runtimes disappear at reboot; old records must not prevent a
        // new session. Count only identities whose private markers are live.
        const record = desktopRecordSchema.parse(
          await readPrivateJson(join(index, file)),
        );
        if (record.id !== file.slice(0, -5))
          throw new HyprlandError("INPUT_FAILED", "Desktop record id mismatch");
        if (
          record.status === "running" &&
          (await ownsProcess(
            record.compositor,
            record.id,
            isolatedRuntime(record.id),
          ))
        )
          running++;
      }
      if (running >= 3)
        throw new HyprlandError(
          "INPUT_FAILED",
          "Three isolated desktops already exist; stop one before starting another",
        );
      const command = await resolveAppLaunchCommand(
        "isolated-desktop",
        policy.launch,
      );
      if (!command)
        throw new HyprlandError(
          "APP_LAUNCH_FAILED",
          "A policy-approved Sway installation is required for isolated desktops",
        );
      const parsed = parseLaunchCommand(command, policy.launch);
      const id = randomBytes(8).toString("hex");
      const runtime = isolatedRuntime(id);
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const config = join(runtime, "config");
      await writeFile(
        config,
        `xwayland disable\noutput HEADLESS-1 mode ${width}x${height}@30Hz\nseat seat0 fallback true\nseat seat0 hide_cursor 0\nseat seat0 hide_cursor when-typing disable\nseat seat0 xcursor_theme Adwaita 24\ndefault_border none\nfont monospace 12\n`,
        { mode: 0o600 },
      );
      const env = isolatedEnvironment(id);
      try {
        assertLaunchRateLimit();
        const bus = await spawnOwned(
          "dbus-daemon",
          [
            "--session",
            "--nofork",
            "--nopidfile",
            `--address=${env.DBUS_SESSION_BUS_ADDRESS}`,
          ],
          env,
          join(runtime, "bus.log"),
        );
        const compositorEnv = { ...env };
        if (parsed.executable === vendorCompositor)
          compositorEnv.LD_LIBRARY_PATH = join(
            dirname(dirname(parsed.executable)),
            "lib64",
          );
        const compositor = await spawnOwned(
          parsed.executable,
          [...parsed.args, "--config", config],
          compositorEnv,
          join(runtime, "compositor.log"),
        );
        const deadline = Date.now() + 8000;
        let ready: DesktopRecord | undefined;
        do {
          if (!(await ownsProcess(compositor, id, runtime)))
            throw new Error("Private compositor exited during startup");
          const displays = (await readdir(runtime)).filter((file) =>
            /^wayland-\d+$/.test(file),
          );
          if (displays.length === 1) {
            const record: DesktopRecord = {
              id,
              name,
              width,
              height,
              display: displays[0],
              compositor,
              bus,
              status: "running",
              createdAt: new Date().toISOString(),
            };
            try {
              const outputs = z
                .array(
                  z.object({
                    name: z.string(),
                    active: z.boolean(),
                    rect: z.object({ width: z.number(), height: z.number() }),
                  }),
                )
                .parse(await desktopRequest(record, 3, "", true));
              if (
                outputs.length === 1 &&
                outputs[0].name === "HEADLESS-1" &&
                outputs[0].active &&
                outputs[0].rect.width === width &&
                outputs[0].rect.height === height
              )
                ready = record;
            } catch {
              /* Read-only readiness probes may wait for socket creation. */
            }
          }
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        if (!ready) throw new Error("Private desktop readiness timed out");
        // D-Bus activated dialogs must inherit THIS display, rather than guessing
        // a missing display or reaching the host activation environment.
        await run(
          "dbus-update-activation-environment",
          [
            "WAYLAND_DISPLAY",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "XDG_SESSION_TYPE",
            "XDG_RUNTIME_DIR",
            "GDK_BACKEND",
            "QT_QPA_PLATFORM",
            "SAARTHI_DESKTOP_ID",
          ],
          {
            env: isolatedEnvironment(id, ready.display),
            timeout: 3000,
            maxBuffer: 65536,
          },
        );
        // Create stable input devices exactly once, outside the read-only poll.
        ready.devices = await spawnOwned(
          join(projectRoot(), "dist/native/pointer"),
          [
            join(runtime, ready.display),
            String(width),
            String(height),
            "keepalive",
            String(Math.floor(width / 2)),
            String(Math.floor(height / 2)),
          ],
          isolatedEnvironment(id, ready.display),
          join(runtime, "input-devices.log"),
        );
        const deviceDeadline = Date.now() + 2000;
        do {
          const seats = z
            .array(z.object({ name: z.string(), capabilities: z.number() }))
            .parse(await desktopRequest(ready, 101));
          if (
            seats.length === 1 &&
            seats[0].name === "seat0" &&
            (seats[0].capabilities & 3) === 3
          ) {
            await saveDesktop(ready);
            return ready;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deviceDeadline);
        throw new Error("Private keyboard/pointer did not become ready");
      } catch (error) {
        await terminateSession(id, runtime);
        throw new HyprlandError(
          "APP_LAUNCH_FAILED",
          `${error instanceof Error ? error.message : "Desktop startup failed"}; inspect ${runtime}/compositor.log`,
        );
      }
    },
    statePath("isolated/start.lock"),
    "isolated desktop creation",
  );
}
export async function stopDesktop(
  record: DesktopRecord,
): Promise<Record<string, unknown>> {
  const signalled = await terminateSession(
    record.id,
    isolatedRuntime(record.id),
  );
  const deadline = Date.now() + 3000;
  while (
    (await sessionProcesses(record.id, isolatedRuntime(record.id))).length
  ) {
    if (Date.now() >= deadline)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Some private session processes remain; inspect before retrying cleanup",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  record.status = "stopped";
  await saveDesktop(record);
  return { id: record.id, stopped: true, signalled };
}
