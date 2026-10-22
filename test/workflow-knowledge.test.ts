import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { lookupKnowledge, rememberKnowledge } from "../src/lib/workflow-knowledge.js";

let root: string;
const previousStateDir = process.env.SAARTHI_STATE_DIR;
const entry = {
  id: "whatsapp-attach-images",
  app: "helium",
  profile: "Profile 1",
  title: "Attach images in WhatsApp Web",
  summary: "Attachment button opens a native GTK picker; paste paths into the location bar.",
  anchors: ["Attach button left of the message box"],
  steps: ["Open the self chat", "Click Attach", "Choose Photos & videos"],
  verification: "Four thumbnails visible in the preview tray",
  outcome: "succeeded",
  elapsedMs: 9000,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "saarthi-knowledge-"));
  process.env.SAARTHI_STATE_DIR = root;
});
afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.SAARTHI_STATE_DIR;
  else process.env.SAARTHI_STATE_DIR = previousStateDir;
  await rm(root, { recursive: true, force: true });
});

it("stores private JSON and a Markdown view, accumulating outcomes across observations", async () => {
  const first = await rememberKnowledge(entry);
  expect(first.entry).toMatchObject({ observations: 1, successes: 1, failures: 0 });
  const second = await rememberKnowledge({ ...entry, outcome: "failed", verification: "Picker never opened" });
  expect(second.entry).toMatchObject({ observations: 2, successes: 1, failures: 1, outcome: "failed" });

  const json = join(root, "knowledge", `${entry.id}.json`);
  expect((await stat(json)).mode & 0o777).toBe(0o600);
  const view = await readFile(second.markdownPath, "utf8");
  expect(view).toContain("# Attach images in WhatsApp Web");
  expect(view).toContain("2. Click Attach");
  expect(view).toContain("never execute stored prose");
});

it("refuses to reuse an id for a different app or profile", async () => {
  await rememberKnowledge(entry);
  await expect(rememberKnowledge({ ...entry, profile: "Default" })).rejects.toThrow(/different app\/profile/);
});

it("rejects unknown fields and invalid ids", async () => {
  await expect(rememberKnowledge({ ...entry, command: "rm -rf ~" })).rejects.toThrow();
  await expect(rememberKnowledge({ ...entry, id: "../escape" })).rejects.toThrow();
});

it("ranks by matched terms, filters by app/profile, sinks expired entries and skips unreadable ones", async () => {
  await rememberKnowledge(entry);
  await rememberKnowledge({
    ...entry,
    id: "whatsapp-profile",
    title: "WhatsApp lives in Profile 1",
    summary: "Logged-in WhatsApp Web session",
    anchors: [],
    steps: [],
    outcome: "observed",
  });
  await rememberKnowledge({
    ...entry,
    id: "zathura-open",
    app: "zathura",
    profile: undefined,
    title: "Open PDF",
    summary: "Launch with the file path argument",
    anchors: [],
    steps: [],
  });

  const corrupt = join(root, "knowledge", "broken.json");
  await writeFile(corrupt, "{not json");
  await chmod(corrupt, 0o600);

  const ranked = await lookupKnowledge("whatsapp attach picker");
  expect(ranked.entries.map((match) => match.id)).toEqual(["whatsapp-attach-images", "whatsapp-profile"]);
  expect(ranked).toMatchObject({ requiresRevalidation: true, truncated: false, skipped: 1 });

  const scoped = await lookupKnowledge("open", "zathura");
  expect(scoped.entries.map((match) => match.id)).toEqual(["zathura-open"]);

  const stalePath = join(root, "knowledge", `${entry.id}.json`);
  const stale = JSON.parse(await readFile(stalePath, "utf8"));
  await writeFile(stalePath, JSON.stringify({ ...stale, expiresAt: "2000-01-01T00:00:00.000Z" }));
  const reordered = await lookupKnowledge("whatsapp attach picker");
  expect(reordered.entries.map((match) => [match.id, match.expired])).toEqual([
    ["whatsapp-profile", false],
    ["whatsapp-attach-images", true],
  ]);
});

it("returns an empty result before anything is recorded", async () => {
  await expect(lookupKnowledge("anything")).resolves.toEqual({
    entries: [],
    requiresRevalidation: true,
    truncated: false,
    skipped: 0,
  });
});
