import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function stateDir(): string {
  return process.env.SAARTHI_STATE_DIR ?? join(homedir(), ".local", "state", "saarthi");
}

export function statePath(filename: string): string {
  return join(stateDir(), filename);
}

export function readStateSync<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeStateAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value), "utf8");
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function removeStateSync(path: string): void {
  rmSync(path, { force: true });
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function withStateLockSync<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 5_000) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock: ${path}`);
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
