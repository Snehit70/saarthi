import { createHash } from "node:crypto";
import { BackgroundBrowser, type BrowserConnection } from "./background-browser.js";
import { withDesktopInput, inputOwnershipSignal } from "./input-ownership.js";
import { HyprlandError } from "./hyprland.js";
import { statePath } from "./state.js";

export function browserLeasePath(options: BrowserConnection): string {
  const key = createHash("sha256").update(JSON.stringify([options.browserTarget, options.profile, options.sessionId])).digest("hex");
  return statePath(`browser-${key}.lock`);
}
export async function withBrowserSession<T>(options: BrowserConnection, operation: (browser: BackgroundBrowser) => Promise<T>): Promise<T> {
  return withDesktopInput(async () => {
    const browser = await BackgroundBrowser.connect(options);
    const signal = inputOwnershipSignal();
    const lost = () => browser.close();
    signal?.addEventListener("abort", lost, { once: true });
    try {
      if (signal?.aborted) throw new HyprlandError("INPUT_FAILED", "Browser session ownership was lost");
      const result = await operation(browser);
      if (signal?.aborted) throw new HyprlandError("INPUT_FAILED", "Browser session ownership was lost; inspect before retrying");
      return result;
    } finally { signal?.removeEventListener("abort", lost); browser.close(); }
  }, browserLeasePath(options), "this browser session");
}
