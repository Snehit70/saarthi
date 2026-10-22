import { afterEach, expect, it, vi } from "vitest";
import {
  isolatedEnvironment,
  isolatedRuntime,
} from "../src/lib/isolated-environment.js";
afterEach(() => vi.unstubAllEnvs());
it("removes host focus, activation, clipboard bus and terminal routing hints", () => {
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "SWAYSOCK",
    "I3SOCK",
    "DBUS_SESSION_BUS_ADDRESS",
    "AT_SPI_BUS_ADDRESS",
    "KITTY_LISTEN_ON",
    "TMUX",
    "XDG_ACTIVATION_TOKEN",
    "ENV",
    "LD_PRELOAD",
  ])
    vi.stubEnv(key, "host-secret");
  const env = isolatedEnvironment("1234567890abcdef", "wayland-1");
  expect(Object.values(env)).not.toContain("host-secret");
  expect(env.WAYLAND_DISPLAY).toBe(
    `${isolatedRuntime("1234567890abcdef")}/wayland-1`,
  );
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(
    `unix:path=${isolatedRuntime("1234567890abcdef")}/bus`,
  );
  expect(env.WLR_BACKENDS).toBe("headless");
  expect(env.GDK_BACKEND).toBe("wayland");
});
it("refuses path injection and an externally selected display", () => {
  expect(() => isolatedRuntime("../host")).toThrow();
  expect(() =>
    isolatedEnvironment("1234567890abcdef", "/run/user/1000/wayland-1"),
  ).toThrow();
  expect(
    isolatedEnvironment("1234567890abcdef").WAYLAND_DISPLAY,
  ).toBeUndefined();
});
