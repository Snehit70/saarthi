import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const RUN_LOG_PATH = join(process.cwd(), "logs", "actions", "run.jsonl");

export async function logRunEvent(event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(RUN_LOG_PATH), { recursive: true });
  await appendFile(
    RUN_LOG_PATH,
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

