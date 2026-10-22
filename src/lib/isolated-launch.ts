import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveAppLaunchCommand } from "./apps.js";
import { BROWSERS } from "./browser-catalog.js";
import { parseLaunchCommand } from "./policy.js";
import { policy, assertLaunchRateLimit } from "../runtime.js";
import {
  isolatedEnvironment,
  isolatedRuntime,
} from "./isolated-environment.js";
import {
  desktopWindows,
  assertDesktop,
  type DesktopRecord,
} from "./isolated-desktop.js";
import {
  spawnOwned,
  ownsProcess,
  processIdentity,
} from "./isolated-process.js";
import { HyprlandError } from "./hyprland.js";
import { allowedPageUrl } from "./background-browser.js";

export async function launchIsolated(
  record: DesktopRecord,
  appName: string,
  files: unknown = [],
  url?: string,
): Promise<Record<string, unknown>> {
  if (record.inputBlocked)
    throw new HyprlandError(
      "INPUT_FAILED",
      "Private keyboard action is unresolved; inspect, then stop and recreate this desktop",
    );
  if (appName === "isolated-desktop")
    throw new HyprlandError(
      "APP_LAUNCH_FAILED",
      "Use desktop start for a compositor",
    );
  const command = await resolveAppLaunchCommand(appName, policy.launch);
  if (!command)
    throw new HyprlandError(
      "APP_LAUNCH_FAILED",
      "App alias is not installed or allowed by launch policy",
    );
  const parsed = parseLaunchCommand(command, policy.launch);
  const paths = await Promise.all(
    z
      .array(z.string().min(1).max(4096))
      .max(20)
      .parse(files)
      .map((path) => realpath(path)),
  );
  if (
    new Set(paths).size !== paths.length ||
    (await Promise.all(paths.map((path) => stat(path)))).some(
      (file) => !file.isFile(),
    )
  )
    throw new HyprlandError(
      "APP_LAUNCH_FAILED",
      "Choose distinct regular files",
    );
  const browser = BROWSERS.find((browser) => browser.id === appName);
  if ((url && !browser) || (paths.length && appName !== "zathura"))
    throw new HyprlandError(
      "APP_LAUNCH_FAILED",
      "URL is supported for browser aliases; explicit file arguments currently require zathura",
    );
  const args = [...parsed.args];
  if (browser) {
    const profile = join(isolatedRuntime(record.id), "profiles", browser.id);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    // A shared Chromium/Firefox profile can forward a launch to the user's
    // existing browser outside this desktop, so isolated profiles are required.
    if (browser.family === "chromium") {
      const settings = join(profile, "Default");
      await mkdir(settings, { recursive: true, mode: 0o700 });
      await writeFile(
        join(settings, "Preferences"),
        JSON.stringify({
          credentials_enable_service: false,
          profile: { password_manager_enabled: false },
        }),
        { mode: 0o600, flag: "wx" },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      args.push(
        `--user-data-dir=${profile}`,
        "--ozone-platform=wayland",
        "--disable-gpu",
        "--password-store=basic",
        "--no-first-run",
        "--no-default-browser-check",
      );
    } else args.push("--no-remote", "--profile", profile);
    args.push(url ? allowedPageUrl(url) : "about:blank");
  } else if (appName === "kitty") {
    // User startup configs may auto-attach a host tmux session or remote-control
    // an existing terminal. A private terminal deliberately uses default Kitty
    // config and a shell without user rc scripts.
    args.push(
      "--config",
      "NONE",
      "--override",
      "allow_remote_control=no",
      "/bin/sh",
    );
  } else args.push(...paths);
  await assertDesktop(record);
  const before = new Set(
    (await desktopWindows(record)).map((window) => window.id),
  );
  assertLaunchRateLimit();
  const process = await spawnOwned(
    parsed.executable,
    args,
    isolatedEnvironment(record.id, record.display),
    join(isolatedRuntime(record.id), "applications.log"),
  );
  const deadline = Date.now() + (browser ? 30000 : 10000);
  do {
    const windows = [];
    for (const window of await desktopWindows(record)) {
      if (before.has(window.id)) continue;
      if (
        browser &&
        !browser.classes.includes((window.appId ?? "").toLowerCase())
      )
        continue;
      try {
        if (
          await ownsProcess(
            await processIdentity(window.pid),
            record.id,
            isolatedRuntime(record.id),
          )
        )
          windows.push(window);
      } catch {
        /* App exited. */
      }
    }
    if (windows.length)
      return {
        desktopId: record.id,
        appName,
        pid: process.pid,
        windows,
        verificationRequired: true,
        hostLaunchRequested: false,
      };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new HyprlandError(
    "ACTION_TIMEOUT",
    "App was launched but no new private window was observed; inspect desktop status before retrying",
  );
}
