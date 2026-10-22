# SaarthiBench v1

64 controlled native GUI workflows exercise the installed Saarthi CLI on a real Wayland desktop. This is a tooling regression benchmark. A scripted controller knows each workflow's recipe. Its score does not measure autonomous planning, unseen application generalization, or Codex product performance.

## Coverage

| Domain | Tasks | Checks |
| --- | ---: | --- |
| Clipboard | 8 | Last four images, skip text, explicit order, captions, destination preservation |
| Documents | 8 | Replacement, append, exact punctuation, Unicode, long text, empty text |
| Data | 8 | Sums, filtering, counts, maximum, refunds, median, grouped totals |
| Forms | 8 | Partial and complete draft updates with unrelated fields preserved |
| Files | 8 | Native chooser, spaces, Unicode paths, mixed types, duplicate content |
| Recovery | 8 | Missing selectors, focus changes, delayed controls, disabled send, empty edits |
| Long horizon | 8 | 6 to 40 sequential records, exact history, large bodies, recovery, final attachment |
| Preservation | 8 | Minimal changes, unrelated drafts, no sends, clipboard restoration |

All workflows run in the same GTK workspace. Variations of the same UI are correlated; 64 passes do not establish 64 independent capabilities. Fixtures use synthetic text, images, and files, with per-task seeded values. The public task brief appears in an accessible text view. The oracle checks the saved artifact, every field, body, unrelated composer, image hash order, attached paths and hashes, original source files, send count, and record history.

## Hardest current cases

The 40-record case requires 40 exact title/body saves in order, preservation of unrelated fields and the other composer, and zero sends. The 15-record recovery case re-inspects after an obsolete selector halfway through. The eight-article case uses roughly 2,100 characters per body; the separate long-article edit uses roughly 5,100 characters. The six-record attachment case attaches one image only to the final draft. The draft-package case exercises repeated native file dialogs and exact file hashes, title, and tags. Lengths vary slightly with seeded values.

These cases stress repeated GUI state transitions, exactness, and recovery. They are not multi-hour research workloads or independent real-application planning tasks. Their scripted recipes are known to the reference controller. The 56-task real-application backlog remains a separate, unexecuted design.

## Run locally

Requires the normal built CLI plus Python 3, GTK 3/AT-SPI bindings, `cliphist`, `wl-copy`, `wl-paste`, and a live Hyprland session. Use the user's existing Wayland and session bus environment. No development server is required. The checked-in launch policy enables `benchmark-fixture`; remove that alias to disable it.

```bash
bun run build
python3 benchmarks/run.py prepare --run-dir /tmp/saarthi-bench-seed-77 --seed 77 --controller scripted-reference
saarthi app launch-and-wait --app-name benchmark-fixture --title-contains "Saarthi benchmark workspace" --json
# Use the returned live window id, then keep the desktop available for this run.
python3 benchmarks/reference.py --run-dir /tmp/saarthi-bench-seed-77 --window-id 0xABC
python3 benchmarks/run.py report --run-dir /tmp/saarthi-bench-seed-77
```

Preparation selects the fixture run directory. Restart only the benchmark's owned window when switching runs; the application caches its run directory at startup. Validate its title and PID against live windows before closing it. Do not close unrelated windows. Stop evaluation if user input or unrelated automation changes focus.

The fixture is launched through Saarthi policy and remains a regular desktop application. The controller uses Saarthi commands, including the native file chooser. It reads task data through the accessible UI. It does not write outcomes directly or read `expected.private.json`. Generated plans and logs are private local artifacts. Clipboard history uses a separate per-case database; the actual Wayland selection is temporarily changed during paste tests. Existing clipboard watchers can retain those synthetic images.

## Scoring and reproducibility

The denominator always includes all 64 tasks, including unrun and failed cases. A case passes only when every artifact check passes, there is recorded controller activity, and action and elapsed-time budgets are satisfied. There are 48 development and 16 reserved task labels. The scripted reference has implementations for both; those reserved labels are not evidence of blind generalization.

Reports include completion, exact artifact correctness, preservation, post-action verification, low-level actions, active tool seconds, elapsed wall seconds including gaps between calls, and tool errors. Normal tasks allow 900 seconds and 150 actions. Long tasks allow 3600 seconds and 1200 actions. The optional weighted score is completion-gated: 65% completion, 15% correctness, 10% preservation, 5% final verification, 5% elapsed-time efficiency. Always publish raw completion and time alongside that score. A failed task receives zero weighted points. Failed calls still consume time and actions.

The manifest records seed, catalog hash, source commit, dirty state, Python/platform, and a source hash frozen at the first step. Source, built CLI, policy, fixture, grader, or reference-controller changes invalidate the run. Use a fresh directory after fixes; do not combine pilot results into a final score. Keep all original traces when reporting retries. Preparation and application startup are outside measured task time; model deliberation during task steps is included, but token cost and CPU/RAM are not measured.

Saved outcomes carry an HMAC from the fixture application. This catches accidental oracle echoes and modified payloads; it is not secure against an unrestricted controller running as the same OS user. Such a controller can read the key and private oracle. Independent evaluation must isolate those files and make the fixture/grader supervisor-owned.

## Comparing with Codex

Two comparisons answer different questions. Hold the model, prompt, time budget, seed, screenshots, allowed data access, and retry policy fixed to compare tool stacks. Separately compare complete agent products with their own models and supported tools, recording those differences explicitly. Neither comparison has been run here.

`run.py record --run-dir DIR --task-id ID --event-file EVENT.json` accepts backend-neutral events for an external controller. Required fields are `tool` as two strings, `at` as a finite Unix timestamp, `wallSeconds`, integer `exitCode`, and boolean `mutation` and `verificationRead`. Optional `lowLevelActions` is a positive integer. Imported telemetry is controller-reported and requires a trusted external harness. Grading does not require a Saarthi-specific command or deliberately failed selector.

For a competitive claim, freeze unseen tasks before tuning, use at least three seeds, report first-attempt success and recovery separately, and execute real applications as well as this fixture. Include screenshots and artifact outcomes for failures. A graphical baseline may use screenshots, keyboard/mouse input and native dialogs; a hybrid baseline may use accessibility and clipboard helpers. Label the access level. Do not compare a hybrid scripted recipe with a screenshot-only autonomous agent as if they were equivalent.

The next external track should use [OSWorld's real-application tasks and execution-based evaluation](https://github.com/xlang-ai/OSWorld). Its environment and task distribution differ from this personal Hyprland laptop. A desktop-specific suite should also include real browser uploads/downloads, spreadsheet formulas, document export, cross-app transfers, modal recovery, zoom/scaling, multi-monitor positioning, and interrupted multi-hour work. These remain evaluation gaps, not counted successes in this suite. The [56 real-application challenge designs](real-app-challenges.md) define concrete candidate workloads and outcome checks; their evaluators and baseline runs are still pending.

## Design sources

- [cliphist](https://github.com/sentriz/cliphist) stores multimedia history and decodes selected entries. The installed binary was tested separately because stdin parsing differs across versions.
- [wl-clipboard](https://github.com/bugaevc/wl-clipboard) supplies MIME-specific Wayland selection operations.
- [OpenAI computer-use integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration) distinguish screenshot-based interaction and custom computer tooling. This is API integration guidance, not a published Codex benchmark result.
- [OSWorld](https://github.com/xlang-ai/OSWorld) informs the use of task outcomes rather than successful input dispatch as the completion criterion.

## Recorded runs

The [2026-10-22 pilot](results/2026-10-22-pilot.json) passed 50/64 cases, failed four, and left ten unrun after the fixture window disappeared. All clipboard, document, data, form, file, and short recovery cases passed, as did the 10- and 20-record workflows. The 30-record case read stale task state and produced no artifact; later cases also failed before the window disappeared. This is an incomplete pilot, not a final candidate score. The subsequent controller adds task-identity, record-advancement, and observed-save checks, with a fresh full run still required. A prior native fixture crash was confirmed by a core dump; this run's disappearance had no matching core dump, so its cause remains unverified.

In this pilot, four-image paste took about 3 seconds after fixing inherited `wl-copy` output pipes, compared with about 23 seconds in an earlier local pilot. The complete recent-four task took about 6.4 seconds including setup and verification. These are local fixture observations, not portable latency promises.

The optional [browser attachment probe](browser-probe.html) is a local HTML page for native browser file-chooser checks. Open it through the browser's Open File dialog, attach synthetic exported images, and compare its browser-computed SHA-256 report with the exported hashes. It makes no external requests. This probe is not part of the 64-case score and has not been run in the recorded pilot.
