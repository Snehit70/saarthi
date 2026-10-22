import { spawn, execFile } from "node:child_process";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./paths.js";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
}
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if ((await lstat(`/proc/${pid}`)).uid !== process.getuid?.())
    throw new Error("Process belongs to another user");
  const data = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = data.slice(data.lastIndexOf(")") + 2).split(" ");
  if (!fields[19] || fields[0] === "Z")
    throw new Error("Process is not running");
  return { pid, startTime: fields[19] };
}
export async function ownsProcess(
  identity: ProcessIdentity,
  desktopId: string,
  runtime: string,
): Promise<boolean> {
  try {
    if ((await processIdentity(identity.pid)).startTime !== identity.startTime)
      return false;
    const env = (await readFile(`/proc/${identity.pid}/environ`, "utf8")).split(
      "\0",
    );
    return (
      env.includes(`SAARTHI_DESKTOP_ID=${desktopId}`) &&
      env.includes(`XDG_RUNTIME_DIR=${runtime}`)
    );
  } catch {
    return false;
  }
}
export async function spawnOwned(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
  input?: string,
): Promise<ProcessIdentity> {
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(executable, args, {
      env,
      detached: true,
      stdio: [input === undefined ? "ignore" : "pipe", log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
    child.unref();
    return await processIdentity(child.pid!);
  } finally {
    await log.close();
  }
}
/** Find children even if an application launcher exits or reparents them.
 * Selection requires the current uid and BOTH private session env markers. */
export async function sessionProcesses(
  desktopId: string,
  runtime: string,
): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const identity = await processIdentity(Number(name));
      if (await ownsProcess(identity, desktopId, runtime))
        result.push(identity);
    } catch {
      /* Raced process exit or inaccessible process. */
    }
  }
  return result;
}
export async function terminateSession(
  desktopId: string,
  runtime: string,
): Promise<number> {
  let signalled = 0;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const processes = (await sessionProcesses(desktopId, runtime)).filter(
      (identity) => identity.pid !== process.pid,
    );
    const result = await signalOwned(desktopId, runtime, processes, signal);
    signalled += result.signalled;
    await new Promise((resolve) =>
      setTimeout(resolve, signal === "SIGTERM" ? 250 : 50),
    );
  }
  return signalled;
}

export async function signalOwned(
  desktopId: string,
  runtime: string,
  processes: ProcessIdentity[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<{ signalled: number }> {
  return await new Promise<{ signalled: number }>((resolve, reject) => {
    const child = execFile(
      "python3",
      [join(projectRoot(), "scripts/stop-isolated.py")],
      { timeout: 5000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ desktopId, runtime, signal, processes }));
  });
}
