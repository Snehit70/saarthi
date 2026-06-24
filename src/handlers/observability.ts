import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { audit } from "../lib/audit.js";
import { healthCheck } from "../lib/hyprland.js";
import { completeTask, pingTask, startTask } from "../lib/status.js";
import { readJsonl } from "../lib/util.js";
import { projectRoot } from "../lib/paths.js";
import { server } from "../registry.js";
import { auditLogPath, runLogPath, SESSION_ID } from "../runtime.js";

type LogEvent = Record<string, unknown>;

/** Keep events at or after the lower bound; events without a usable bound or timestamp pass. */
function afterSince(ts: number, sinceTs: number | null): boolean {
  if (sinceTs === null || !Number.isFinite(sinceTs) || !Number.isFinite(ts)) return true;
  return ts >= sinceTs;
}

/** Match an event to the selected session, optionally letting legacy (sessionId-less) rows through. */
function matchesSession(eventSessionId: unknown, selectedSession: string | null, includeLegacy: boolean): boolean {
  if (!selectedSession) return true;
  if (eventSessionId === selectedSession) return true;
  return includeLegacy && (eventSessionId === undefined || eventSessionId === null || eventSessionId === "");
}

function parseTs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

server.registerTool(
  "overlay_task_start",
  {
    title: "Overlay Task Start",
    description: "Mark the beginning of a user-visible Saarthi task so the overlay stays present between CLI commands.",
    inputSchema: {
      label: z.string().min(1).max(160).default("desktop task"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ label }) => {
    const task = startTask(label);
    await audit("overlay_task_start", { label, taskId: task.id }, false, { taskId: task.id, status: "started" });
    return {
      content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      structuredContent: { task },
    };
  },
);

server.registerTool(
  "overlay_task_ping",
  {
    title: "Overlay Task Ping",
    description: "Refresh the active overlay task and optionally move it into a waiting display state.",
    inputSchema: {
      state: z.enum(["waiting", "dormant_waiting"]).default("waiting"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ state }) => {
    const task = pingTask(state);
    await audit("overlay_task_ping", { state, taskId: task.id }, false, { taskId: task.id, status: "completed" });
    return {
      content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      structuredContent: { task },
    };
  },
);

server.registerTool(
  "overlay_task_complete",
  {
    title: "Overlay Task Complete",
    description: "Mark the active overlay task complete, errored, or timed out so the HUD can settle and hide.",
    inputSchema: {
      status: z.enum(["done", "error", "timeout"]).default("done"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ status }) => {
    const task = completeTask(status);
    await audit("overlay_task_complete", { status, taskId: task.id }, false, {
      taskId: task.id,
      status: status === "error" ? "error" : "completed",
      result: status === "error" ? "error" : "ok",
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      structuredContent: { task },
    };
  },
);

server.registerTool(
  "desktop_health",
  {
    title: "Desktop Health",
    description: "Report local Hyprland session health and active desktop status.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const data = await healthCheck();
    const payload = { ...data, telemetrySessionId: SESSION_ID };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "session_trace_export",
  {
    title: "Session Trace Export",
    description: "Export normalized trace events from audit/run logs for a session/task window.",
    inputSchema: {
      sessionId: z.string().optional(),
      taskId: z.string().optional(),
      sinceIso: z.string().optional(),
      lastN: z.number().int().min(1).max(5000).default(500),
      outputPath: z.string().optional(),
      includeLegacy: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ sessionId, taskId, sinceIso, lastN, outputPath, includeLegacy }) => {
    const [auditEvents, runEvents] = await Promise.all([readJsonl(auditLogPath), readJsonl(runLogPath)]);
    const sinceTs = sinceIso ? Date.parse(sinceIso) : null;
    const selectedSession = sessionId ?? SESSION_ID;
    const inWindow = (e: LogEvent, tsField: "timestamp" | "ts"): boolean =>
      afterSince(parseTs(e[tsField]), sinceTs) &&
      matchesSession(e.sessionId, selectedSession, includeLegacy) &&
      !(taskId && e.taskId && e.taskId !== taskId);
    const filteredAudit = auditEvents.filter((e) => inWindow(e, "timestamp"));
    const filteredRun = runEvents.filter((e) => inWindow(e, "ts"));
    const merged = [
      ...filteredAudit.map((e) => ({ source: "audit", ts: String(e.timestamp ?? ""), event: e })),
      ...filteredRun.map((e) => ({ source: "run", ts: String(e.ts ?? ""), event: e })),
    ]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .slice(-lastN);

    const outPath =
      outputPath ??
      join(projectRoot(), "logs", "exports", `${new Date().toISOString().replace(/[:.]/g, "-")}-trace-${(taskId ?? selectedSession).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ sessionId: selectedSession, taskId: taskId ?? null, count: merged.length, events: merged }, null, 2), "utf8");

    return {
      content: [{ type: "text", text: JSON.stringify({ path: outPath, count: merged.length, sessionId: selectedSession, taskId: taskId ?? null }, null, 2) }],
      structuredContent: { path: outPath, count: merged.length, sessionId: selectedSession, taskId: taskId ?? null },
    };
  },
);

server.registerTool(
  "metrics_report",
  {
    title: "Metrics Report",
    description: "Compute KPI metrics (error rate, durations, loops, task completion) from telemetry logs.",
    inputSchema: {
      sessionId: z.string().optional(),
      sinceIso: z.string().optional(),
      lastN: z.number().int().min(1).max(100000).default(5000),
      includeLegacy: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sessionId, sinceIso, lastN, includeLegacy }) => {
    const auditEvents = await readJsonl(auditLogPath);
    const sinceTs = sinceIso ? Date.parse(sinceIso) : null;
    const selectedSession = sessionId ?? SESSION_ID;
    const rows = auditEvents
      .filter((e) => afterSince(parseTs(e.timestamp), sinceTs) && matchesSession(e.sessionId, selectedSession, includeLegacy))
      .slice(-lastN);

    const total = rows.length;
    const errors = rows.filter((e) => e.result === "error" || e.status === "error" || (typeof e.errorCode === "string" && e.errorCode.length > 0));
    const durations = rows
      .map((e) => (typeof e.durationMs === "number" ? e.durationMs : null))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    const percentile = (p: number): number | null => {
      if (durations.length === 0) return null;
      const idx = Math.min(durations.length - 1, Math.max(0, Math.floor(p * (durations.length - 1))));
      return durations[idx];
    };
    const byAction = new Map<string, { total: number; errors: number }>();
    const loopActions = new Set(["click_wait_retry", "action_step"]);
    let loopEvents = 0;
    let retryAttempts = 0;
    const taskBuckets = new Map<string, { minTs: number; maxTs: number; errors: number; events: number }>();
    for (const e of rows) {
      const action = typeof e.action === "string" ? e.action : "unknown";
      const entry = byAction.get(action) ?? { total: 0, errors: 0 };
      entry.total += 1;
      if (e.result === "error" || e.status === "error" || (typeof e.errorCode === "string" && e.errorCode.length > 0)) entry.errors += 1;
      byAction.set(action, entry);
      if (loopActions.has(action)) loopEvents += 1;
      const attempt = typeof e.attempt === "number" ? e.attempt : typeof (e.payload as Record<string, unknown> | undefined)?.attempt === "number" ? Number((e.payload as Record<string, unknown>).attempt) : 0;
      retryAttempts += attempt;
      const tid = typeof e.taskId === "string" && e.taskId.length > 0 ? e.taskId : null;
      if (tid) {
        const ts = Date.parse(String(e.endedAt ?? e.timestamp ?? new Date().toISOString()));
        const bucket = taskBuckets.get(tid) ?? { minTs: ts, maxTs: ts, errors: 0, events: 0 };
        if (ts < bucket.minTs) bucket.minTs = ts;
        if (ts > bucket.maxTs) bucket.maxTs = ts;
        bucket.events += 1;
        if (e.status === "error" || e.result === "error") bucket.errors += 1;
        taskBuckets.set(tid, bucket);
      }
    }
    const tasks = [...taskBuckets.entries()].map(([taskId, b]) => ({
      taskId,
      durationMs: Math.max(0, b.maxTs - b.minTs),
      events: b.events,
      status: b.errors > 0 ? "error" : "completed",
    }));
    const completedTasks = tasks.filter((t) => t.status === "completed");
    const avgTaskDurationMs = completedTasks.length > 0 ? Math.round(completedTasks.reduce((s, t) => s + t.durationMs, 0) / completedTasks.length) : null;

    const report = {
      sessionId: selectedSession,
      eventCount: total,
      errorCount: errors.length,
      errorRate: total > 0 ? Number((errors.length / total).toFixed(4)) : 0,
      durations: {
        samples: durations.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
      },
      loops: {
        loopEvents,
        retryAttempts,
      },
      tasks: {
        count: tasks.length,
        completed: completedTasks.length,
        error: tasks.length - completedTasks.length,
        avgCompletionMs: avgTaskDurationMs,
      },
      byAction: [...byAction.entries()].map(([action, m]) => ({
        action,
        total: m.total,
        errors: m.errors,
        errorRate: m.total > 0 ? Number((m.errors / m.total).toFixed(4)) : 0,
      })),
      notes: {
        taskMetricsRequireTaskId: true,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      structuredContent: report,
    };
  },
);
