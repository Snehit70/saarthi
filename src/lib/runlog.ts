import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const RUN_LOG_PATH = join(process.cwd(), "logs", "actions", "run.jsonl");

export async function logRunEvent(event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(RUN_LOG_PATH), { recursive: true });
  const ts = new Date().toISOString();
  await appendFile(
    RUN_LOG_PATH,
    `${JSON.stringify({ ts, sessionId: process.env.SAARTHI_SESSION_ID ?? null, ...event })}\n`,
    "utf8",
  );
}
