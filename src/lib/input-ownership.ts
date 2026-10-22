import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "./state.js";

class InputOwnershipError extends Error {
  constructor(
    public readonly code: "INPUT_BUSY" | "INPUT_FAILED",
    message: string,
  ) {
    super(message);
  }
}
const ownership = new AsyncLocalStorage<AbortSignal>();
export const inputOwnershipSignal = (): AbortSignal | undefined => ownership.getStore();

/** Kernel-held lock scoped to one invocation. Parent death closes stdin and
 * releases the lock, including SIGKILL, without stale-PID or age deletion. */
export async function withDesktopInput<T>(
  operation: () => Promise<T>,
  path = statePath("desktop-input.lock"),
): Promise<T> {
  const inherited = ownership.getStore();
  if (inherited) {
    if (inherited.aborted) throw new InputOwnershipError("INPUT_FAILED", "Desktop input ownership was lost");
    return operation();
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  await file.close();
  const controller = new AbortController();
  const child = spawn("flock", ["--nonblock", "--no-fork", "--conflict-exit-code", "73", path, "cat"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const token = randomBytes(16).toString("hex");
  let acquired = false;
  let released = false;
  let output = "";
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      if (acquired && !released) controller.abort();
      resolve();
    });
    child.once("error", () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new InputOwnershipError("INPUT_FAILED", "Desktop input lock acquisition timed out")),
        3000,
      );
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.includes(token)) {
          acquired = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new InputOwnershipError("INPUT_FAILED", "flock is required for desktop input ownership"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!acquired)
          reject(
            new InputOwnershipError(
              code === 73 ? "INPUT_BUSY" : "INPUT_FAILED",
              code === 73
                ? "Another Saarthi invocation owns desktop input; wait for it to finish"
                : "Desktop input ownership failed",
            ),
          );
      });
      child.stdin.write(`${token}\n`);
    });
    return await ownership.run(controller.signal, operation);
  } finally {
    released = true;
    child.stdin.end();
    if (!acquired) child.kill();
    await exited;
  }
}
