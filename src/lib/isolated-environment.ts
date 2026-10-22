import { homedir } from "node:os";
import { join } from "node:path";

export function isolatedRuntime(id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id))
    throw new Error("Invalid isolated desktop id");
  const uid = process.getuid?.();
  if (uid === undefined || process.platform !== "linux")
    throw new Error("Isolated desktops require Linux");
  return `/run/user/${uid}/saarthi-isolated/${id}`;
}
export function isolatedEnvironment(
  id: string,
  display?: string,
): NodeJS.ProcessEnv {
  const runtime = isolatedRuntime(id);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "SWAYSOCK",
    "I3SOCK",
    "DBUS_SESSION_BUS_ADDRESS",
    "DBUS_STARTER_ADDRESS",
    "DBUS_STARTER_BUS_TYPE",
    "AT_SPI_BUS_ADDRESS",
    "XAUTHORITY",
    "NOTIFY_SOCKET",
    "LISTEN_FDS",
    "LISTEN_PID",
    "LISTEN_FDNAMES",
    "KITTY_LISTEN_ON",
    "KITTY_PID",
    "TMUX",
    "TMUX_PANE",
    "TMUX_TMPDIR",
    "ENV",
    "BASH_ENV",
    "ZDOTDIR",
    "DESKTOP_STARTUP_ID",
    "XDG_ACTIVATION_TOKEN",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
  ])
    delete env[key];
  Object.assign(env, {
    SAARTHI_DESKTOP_ID: id,
    XDG_RUNTIME_DIR: runtime,
    SWAYSOCK: join(runtime, "ipc.sock"),
    XDG_CONFIG_HOME: join(runtime, "config-home"),
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_CACHE_HOME: join(runtime, "cache"),
    XDG_STATE_HOME: join(runtime, "state"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "bus")}`,
    XDG_CURRENT_DESKTOP: "sway",
    XDG_SESSION_DESKTOP: "sway",
    XDG_SESSION_TYPE: "wayland",
    WLR_BACKENDS: "headless",
    WLR_RENDERER: "pixman",
    WLR_HEADLESS_OUTPUTS: "1",
    WLR_LIBINPUT_NO_DEVICES: "1",
    GDK_BACKEND: "wayland",
    QT_QPA_PLATFORM: "wayland",
    SDL_VIDEODRIVER: "wayland",
    MOZ_ENABLE_WAYLAND: "1",
    XCURSOR_SIZE: "24",
    XCURSOR_THEME: "Adwaita",
    TMUX_TMPDIR: runtime,
    GTK_USE_PORTAL: "0",
  });
  if (display) {
    if (!/^wayland-\d+$/.test(display))
      throw new Error("Invalid private Wayland display");
    env.WAYLAND_DISPLAY = join(runtime, display);
  }
  return env;
}
export const vendorCompositor = join(
  homedir(),
  ".local/share/saarthi/compositor/usr/bin/sway",
);
