import { beforeEach, describe, expect, it, vi } from "vitest";

// execFile mock with the util.promisify.custom hook (lib promisifies at import).
// A small stateful impl lets the capture-pane response echo the sentinel id that
// runCommand embedded in its send-keys payload.
const cp = vi.hoisted(() => {
  const impl = vi.fn();
  const PROM = Symbol.for("nodejs.util.promisify.custom");
  function execFile(...args: any[]) {
    const cb = args[args.length - 1];
    Promise.resolve()
      .then(() => impl(args[0], args[1]))
      .then(
        (r: any) => cb(null, r?.stdout ?? "", r?.stderr ?? ""),
        (e: any) => cb(e),
      );
  }
  (execFile as any)[PROM] = (cmd: any, a: any) => Promise.resolve(impl(cmd, a));
  return { impl, execFile };
});
vi.mock("node:child_process", () => ({ execFile: cp.execFile }));

import {
  classifyCommand,
  parsePanesOutput,
  resolveTarget,
  runCommand,
  sessionsFromPanes,
  TmuxError,
  type TmuxPane,
} from "../src/lib/tmux.js";

const US = "␟"; // must match FIELD_SEP in src/lib/tmux.ts

function paneLine(o: Partial<Record<string, string>>): string {
  const d = {
    session: "praxis", win: "1", winName: "main", winActive: "1", pane: "1",
    paneId: "%1", paneActive: "1", attached: "1", cmd: "zsh", pid: "100",
    title: "praxis", w: "200", h: "50", cwd: "/home/snehit/projects/praxis",
  };
  const f = { ...d, ...o };
  return [f.session, f.win, f.winName, f.winActive, f.pane, f.paneId, f.paneActive, f.attached, f.cmd, f.pid, f.title, f.w, f.h, f.cwd].join(US);
}

function makePane(o: Partial<TmuxPane>): TmuxPane {
  return {
    session: "praxis", windowIndex: 1, windowName: "main", windowActive: true,
    paneIndex: 1, paneId: "%1", target: "praxis:1.1", active: true,
    sessionAttached: true, command: "zsh", pid: 100, title: "praxis",
    width: 200, height: 50, cwd: "/home/snehit/projects/praxis", isShell: true, ...o,
  };
}

beforeEach(() => cp.impl.mockReset());

describe("parsePanesOutput", () => {
  it("parses a delimited pane line and flags shells", () => {
    const panes = parsePanesOutput([
      paneLine({}),
      paneLine({ session: "saarthi", paneId: "%2", cmd: "nvim", target: "saarthi:1.1" }),
    ].join("\n"));
    expect(panes).toHaveLength(2);
    expect(panes[0]).toMatchObject({ session: "praxis", target: "praxis:1.1", isShell: true, command: "zsh" });
    expect(panes[1]).toMatchObject({ session: "saarthi", command: "nvim", isShell: false });
  });

  it("derives sessions with window counts and attach state", () => {
    const panes = parsePanesOutput([
      paneLine({ session: "a", win: "1", attached: "1" }),
      paneLine({ session: "a", win: "2", attached: "1", paneId: "%3" }),
      paneLine({ session: "b", win: "1", attached: "0", paneId: "%4" }),
    ].join("\n"));
    const sessions = sessionsFromPanes(panes);
    expect(sessions).toEqual([
      { name: "a", attached: true, windows: 2 },
      { name: "b", attached: false, windows: 1 },
    ]);
  });
});

describe("resolveTarget", () => {
  const panes = [
    makePane({ session: "praxis", target: "praxis:1.1", active: true, windowActive: true, sessionAttached: true }),
    makePane({ session: "pravah", target: "pravah:1.1", paneId: "%5", active: true, windowActive: true, sessionAttached: false }),
    makePane({ session: "pravah", target: "pravah:2.1", windowIndex: 2, paneId: "%6", active: true, windowActive: false, sessionAttached: false }),
  ];

  it("returns the attached active pane when no target is given", () => {
    expect(resolveTarget(panes, undefined).target).toBe("praxis:1.1");
  });

  it("resolves a bare session name to its active pane", () => {
    expect(resolveTarget(panes, "pravah").target).toBe("pravah:1.1");
  });

  it("resolves an explicit session:window.pane", () => {
    expect(resolveTarget(panes, "pravah:2.1").target).toBe("pravah:2.1");
  });

  it("resolves a pane id", () => {
    expect(resolveTarget(panes, "%6").target).toBe("pravah:2.1");
  });

  it("throws TMUX_TARGET_NOT_FOUND for an unknown session", () => {
    expect(() => resolveTarget(panes, "ghost")).toThrow(TmuxError);
  });

  it("throws when ambiguous with multiple attached active panes", () => {
    const ambiguous = [
      makePane({ session: "a", target: "a:1.1", sessionAttached: true }),
      makePane({ session: "b", target: "b:1.1", paneId: "%9", sessionAttached: true }),
    ];
    try {
      resolveTarget(ambiguous, undefined);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as TmuxError).code).toBe("TMUX_TARGET_AMBIGUOUS");
      expect((err as TmuxError).candidates?.length).toBe(2);
    }
  });
});

describe("classifyCommand", () => {
  it("treats read-only commands as safe", () => {
    for (const c of ["ls -la", "git status", "git log --oneline", "rg TODO src", "cat x.txt", "pytest -q", "FOO=1 echo hi"]) {
      expect(classifyCommand(c)).toBe("safe");
    }
  });

  it("treats mutating commands as mutating", () => {
    for (const c of ["rm -rf build", "git push --force", "sudo dnf update", "git commit -m x", "dropdb prod", "npm publish"]) {
      expect(classifyCommand(c)).toBe("mutating");
    }
  });

  it("a pipeline is safe only if every segment is safe", () => {
    expect(classifyCommand("cat f | rg foo")).toBe("safe");
    expect(classifyCommand("cat f && rm f")).toBe("mutating");
  });
});

describe("runCommand", () => {
  it("refuses a non-shell pane without confirmBusy", async () => {
    await expect(runCommand(makePane({ command: "nvim", isShell: false }), "ls")).rejects.toMatchObject({
      code: "TMUX_PANE_BUSY",
    });
    expect(cp.impl).not.toHaveBeenCalled();
  });

  it("runs via sentinels and parses exit code + output", async () => {
    let id = "";
    cp.impl.mockImplementation((_cmd: string, args: string[]) => {
      if (!args) return { stdout: "" }; // tolerate vitest's no-arg cleanup call
      if (args[0] === "send-keys" && args.includes("-l")) {
        const wrapped = args[args.length - 1]!;
        id = wrapped.match(/__SAARTHI_(\w+)_START__/)![1]!;
        return { stdout: "" };
      }
      if (args[0] === "capture-pane") {
        return { stdout: `$ pytest\n__SAARTHI_${id}_START__\n2 passed\n__SAARTHI_${id}_END_0__\n` };
      }
      return { stdout: "" };
    });
    const r = await runCommand(makePane({}), "pytest -q", { pollMs: 10 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("2 passed");
    expect(r.timedOut).toBe(false);
    expect(r.classification).toBe("safe");
  });

  it("uses $status instead of $? for fish panes", async () => {
    let wrapped = "";
    cp.impl.mockImplementation((_cmd: string, args: string[]) => {
      if (!args) return { stdout: "" }; // tolerate vitest's no-arg cleanup call
      if (args[0] === "send-keys" && args.includes("-l")) {
        wrapped = args[args.length - 1]!;
        const id = wrapped.match(/__SAARTHI_(\w+)_START__/)![1]!;
        // satisfy the poll immediately on the next capture
        return { stdout: "", _id: id };
      }
      if (args[0] === "capture-pane") {
        const id = wrapped.match(/__SAARTHI_(\w+)_START__/)![1]!;
        return { stdout: `__SAARTHI_${id}_START__\nok\n__SAARTHI_${id}_END_0__\n` };
      }
      return { stdout: "" };
    });
    await runCommand(makePane({ command: "fish", isShell: true }), "echo hi", { pollMs: 10 });
    expect(wrapped).toContain("$status");
    expect(wrapped).not.toContain('"$?"');
  });

  it("interrupts with C-c and reports timedOut when no marker appears", async () => {
    const sent: string[][] = [];
    cp.impl.mockImplementation((_cmd: string, args: string[]) => {
      if (!args) return { stdout: "" }; // tolerate vitest's no-arg cleanup call
      sent.push(args);
      return { stdout: "stuck output with no marker\n" };
    });
    const r = await runCommand(makePane({}), "sleep 999", { timeoutMs: 120, pollMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(sent.some((a) => a[0] === "send-keys" && a.includes("C-c"))).toBe(true);
  });
});
