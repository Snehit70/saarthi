import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { hyprlandEnvironment, HyprlandError } from "./hyprland.js";

const run = promisify(execFile);
const instancesSchema = z
  .array(
    z.object({
      instance: z.string(),
      pid: z.number().int().positive(),
      wl_socket: z.string().min(1).max(4096),
    }),
  )
  .max(64);
let discovery:
  | Promise<{
      runtime: string;
      display: string;
      bus?: string;
      signature: string;
    }>
  | undefined;

async function discoverSession(): Promise<{
  runtime: string;
  display: string;
  bus?: string;
  signature: string;
}> {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new HyprlandError(
      "PLATFORM_UNSUPPORTED",
      "Desktop discovery requires a Linux user id",
    );
  const runtime = `/run/user/${uid}`;
  const env = await hyprlandEnvironment();
  const { stdout } = await run("hyprctl", ["-j", "instances"], {
    env: { ...env, XDG_RUNTIME_DIR: runtime },
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  const matches = instancesSchema
    .parse(JSON.parse(stdout))
    .filter((row) => row.instance === env.HYPRLAND_INSTANCE_SIGNATURE);
  if (matches.length !== 1)
    throw new Error(
      "No unique compositor instance matches the selected Hyprland socket",
    );
  const instance = matches[0];
  if ((await lstat(`/proc/${instance.pid}`)).uid !== uid)
    throw new Error("Compositor belongs to another user");
  const display = isAbsolute(instance.wl_socket)
    ? instance.wl_socket
    : join(runtime, instance.wl_socket);
  if (
    (await realpath(runtime)) !== runtime ||
    (await realpath(display)) !== display ||
    !display.startsWith(`${runtime}/`)
  )
    throw new Error("Desktop runtime/socket path changed");
  const runtimeInfo = await lstat(runtime),
    socket = await lstat(display);
  if (
    !runtimeInfo.isDirectory() ||
    runtimeInfo.uid !== uid ||
    runtimeInfo.mode & 0o077 ||
    !socket.isSocket() ||
    socket.uid !== uid
  )
    throw new Error("Desktop runtime/socket ownership or permissions changed");
  const busPath = join(runtime, "bus");
  let bus: string | undefined;
  try {
    const socket = await lstat(busPath);
    if (
      socket.isSocket() &&
      socket.uid === uid &&
      (await realpath(busPath)) === busPath
    )
      bus = `unix:path=${busPath}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { runtime, display, bus, signature: instance.instance };
}

/** Fill missing session routing from the selected live compositor. Never guess
 * wayland-0/1, scan arbitrary processes, or route private desktop clients here. */
export async function desktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.env.SAARTHI_DESKTOP_ID)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Use desktop commands for an isolated session; host routing is forbidden",
    );
  if (
    process.env.XDG_RUNTIME_DIR &&
    process.env.WAYLAND_DISPLAY &&
    process.env.DBUS_SESSION_BUS_ADDRESS
  )
    return { ...process.env, ...(await hyprlandEnvironment()) };
  discovery ??= discoverSession().catch((error) => {
    discovery = undefined;
    throw new HyprlandError(
      "NO_SOCKET",
      `Cannot resolve desktop session: ${error instanceof Error ? error.message : "discovery failed"}`,
    );
  });
  const session = await discovery;
  const env = { ...process.env };
  if (env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR !== session.runtime)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Explicit runtime conflicts with the selected Hyprland session",
    );
  if (env.WAYLAND_DISPLAY) {
    const explicit = isAbsolute(env.WAYLAND_DISPLAY)
      ? env.WAYLAND_DISPLAY
      : join(session.runtime, env.WAYLAND_DISPLAY);
    if (explicit !== session.display)
      throw new HyprlandError(
        "INPUT_FAILED",
        "Explicit Wayland display conflicts with the selected Hyprland session",
      );
  }
  env.HYPRLAND_INSTANCE_SIGNATURE ??= session.signature;
  env.XDG_RUNTIME_DIR ??= session.runtime;
  env.WAYLAND_DISPLAY ??= session.display;
  env.DBUS_SESSION_BUS_ADDRESS ??= session.bus;
  return env;
}
