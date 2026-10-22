# Saarthi browser and desktop reliability review

Date: 2026-10-22. Baseline: `0eed819`. Scope covers the local CLI, registry and dispatch, browser adapters, launch policy, Hyprland IPC, input, screenshot restoration, OCR, accessibility, state, and observability. Validation combines regression tests with a live Hyprland session. It does not certify every application or desktop configuration.

## Findings addressed

| Area | Existing behavior | Change |
| --- | --- | --- |
| Browser portability | Commands selected Zen and required its Flatpak launcher. | Discovery and control for ten browser identities, including Helium. Shared navigation, history, reload, stop, tab selection, and page search. |
| Target selection | First matching windows could be selected. Missing current-tab targets could launch another window. | Prefer focused targets, require selectors when ambiguous, support exact window ids, and fail missing explicit targets. |
| Launch policy | Browser reuse checked a launcher and consumed launch rate limits. | Separate reuse from launch. Resolve catalog aliases, validate commands, and charge the limiter immediately before actual spawn. Dry-run does not charge it. |
| Readiness | A vanished target could reuse old data or fall back to an unrelated window. Zero-duration waits could miss their observation. | Resolve the exact live target every time. Missing/hidden targets fail. Zero timeout observes once; readiness timeout exits 17. |
| Foreground input | Focus could change during browser typing. Generic key/text commands had no expected-window option. | Validate live windows at the adapter boundary and check focus before input stages. Optional window ids guard generic input and repeated keys. |
| Literal typing | Text in wtype arguments was visible in process listings and could be parsed as options. | Shared stdin typing for browser, input, and composite commands. Bound estimated duration. Omit `-d` at zero delay to support the installed wtype. |
| Vimium | Hint activation followed by an appended Enter could cause a second action. Preview could type text. | Preview opens hints without text. Commit sends a hint without trailing Enter, retains confirmation gates, and requires observation afterward. |
| IPC performance | Every read repeated socket discovery and a compositor version probe. | Share discovery per invocation, including concurrent reads. Never cache clients/focus. Failed reads invalidate discovery; mutations are never replayed. |
| Executable detection | Each availability check spawned `which`. | Search executable files along PATH without a subprocess or persistent install cache. |
| Screenshot recovery | Workspace switching occurred outside restoration's try/finally scope. | Include setup in restoration and bound capture execution. |
| OCR | Phrase queries were compared against individual words. Invalid geometry could reach targeting; successful diagnostics caused failures. | Match nearby words on the same TSV line, combine their boxes and minimum confidence, reject invalid geometry, accept successful diagnostics, and bound execution. |
| Accessibility | Positive extents counted as on-screen. Focused PID failure could scan all apps. Work was bounded only by matched results. | Require visible and showing states, reject stale/defunct nodes, fail focused PID lookup, and independently bound visited nodes. |
| Image comparison | Empty successful metrics became a maximal-difference result. | Reject invalid metrics and bound comparison execution. |

The checked-in and fallback launch policies now allow the ten catalog browser aliases. Remove unwanted aliases to disable their launches. Existing deny rules, rate caps, and the CLI-only architecture remain in effect.

## Source-backed decisions

### Browser parity and isolation

The [Firefox shortcut reference](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly) and [Chrome shortcut reference](https://support.google.com/chrome/answer/157179?hl=en) document shared Linux navigation, tab, address-bar, and find shortcuts. These provide useful parity while retaining authenticated profiles. Workspace stepping remains Zen-only. Firefox's `about:home` is rejected for Chromium-family targets; `about:blank` is portable.

[Helium's source repository](https://github.com/imputnet/helium) identifies its Chromium lineage and Linux packaging. A [first-party Linux issue](https://github.com/imputnet/helium-linux/issues/148) demonstrates packaging-dependent desktop identity. Discovery therefore distinguishes exact classes, desktop handler ids, launchers, and running windows. It excludes Electron and PWA classes rather than guessing from titles. Additional packaging variants need fixtures.

Chrome's [remote-debugging policy](https://developer.chrome.com/blog/remote-debugging-port) requires a non-default data directory for the relevant switches starting with Chrome 136. Attaching a debug port to the normal profile is not a portable live-browser strategy. An extension/native bridge would also need a separate architectural decision under this repository's transport rules. This PR provides foreground control and does not claim isolated background execution.

### Performance and process boundaries

The [Hyprland hyprctl documentation](https://wiki.hypr.land/configuring/core/advanced-configuration/using-hyprctl/) explains that calls are synchronous and excessive calls can slow the compositor. Shared discovery removes redundant version reads while retaining fresh clients/focus. This avoids caching window state or batching unchecked mutations. The installed compositor remains the compatibility reference for Lua dispatchers; current web docs may describe newer APIs.

The [Node.js 22 child-process reference](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html) documents `execFile` argument arrays, timeouts, and output limits. The implementation keeps structured arguments, uses stdin for text, and bounds subprocess operations. An outer polling deadline does not interrupt an in-progress operation, so the per-operation timeout can extend total elapsed time.

### Perception and verification

The [AT-SPI state specification](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/enum.StateType.html) distinguishes visible, showing, stale, and defunct states. The [Component interface](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Component.html) also conditions coordinate meaning on visibility. Positive width/height alone is insufficient. Both states still do not prove an element is unobscured; a fresh screenshot remains useful.

[Tesseract's TSV documentation](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) supplies page/block/paragraph/line and word geometry. Phrase matching uses line boundaries and a distance check to avoid joining separate controls. Its [quality guide](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) explains segmentation and image-quality limitations. Phrase support does not guarantee OCR accuracy.

The [wtype implementation](https://github.com/atx/wtype/blob/master/main.c) supports stdin and distinguishes text from key/modifier commands. A live check additionally caught zero-delay incompatibility in the installed binary, now covered by a regression test.

## Validation evidence

- Baseline suite: 112 passing tests. Expanded suite, built smoke, and final CI results are recorded in the PR.
- Live discovery found a Wayland Helium window, an executable AppImage launcher, and an installed Chrome launcher. Credentials and private page contents were not published.
- A policy-approved Helium launch opened a disposable new window and matched its title. Its screenshot was captured and visually inspected. The page content differed from assumptions based on its title, demonstrating the limits of title readiness.
- The installed wtype rejected `-d 0`. The corrected adapter omits it; a no-text stdin probe passed in the real Wayland session. Actual browser typing and focus-loss paths have deterministic adapter coverage.
- AT-SPI exposed the Helium application but no usable page elements. This is a verified fallback case, not DOM accessibility parity.
- After the disposable window disappeared, exact-target control rejected its old address instead of switching to another window. The original terminal focus and existing Helium window were present afterward.
- Offline OCR of the saved browser capture matched `This domain` at 95.46 confidence with a combined bounding box. Screenshot artifacts and private desktop state remain local.

### Polling measurement

Five alternating baseline/updated runs each performed ten live `listWindows` polls in a fresh Node/tsx process. Timings exclude process startup. Baseline median: 342.3 ms. Updated median: 195.1 ms. The desktop was active and there was substantial contention: baseline range 271.6 to 513.8 ms; updated range 161.0 to 1665.6 ms. This is a local observation, not a portable latency promise.

The deterministic improvement is ten polls using 20 state reads plus one discovery probe rather than 20 state reads plus 20 version probes: 40 to 21 hyprctl subprocesses. Regression tests verify shared discovery and uncached state. Safety checks intentionally add fresh reads around mutations.

## Remaining work, in priority order

| Priority | Gap and evidence | Next bounded improvement |
| --- | --- | --- |
| High | Input remains global and can race the user or unrelated software. | Cross-process Saarthi ownership is now implemented with kernel owner-death recovery. True background control remains a separate architectural decision. |
| High | Monitor state and screenshot/pointer coordinates lack a complete logical/physical scale model. Monitor dimensions are copied directly from hyprctl. | Add scaled, rotated, negative-origin fixtures and explicit screenshot-pixel to logical-coordinate conversion before claiming multi-monitor accuracy. |
| High | Window capture can focus a window. Restoration covers workspace switching but does not guarantee the prior active window on the same workspace. | Add explicit focus restoration with window-disappearance and concurrent user-focus tests. |
| Medium | Browser page accessibility can be unavailable. | Semantic action invocation, exact text readback, bounded batches, and scoped frame coordinates are now implemented. Keep OCR/grid fallback and broaden real-app coverage. |
| Medium | OCR has a fixed segmentation mode and English default; phrase matches do not span lines. | Add installed-language discovery and explicit segmentation/crop options with a multilingual fixture corpus. Measure accuracy and latency together. |
| Medium | Trace/metrics read whole JSONL files before filtering and lastN. | Stream filtered reads with bounded retained matches, preserving session/since semantics. Add retention separately. |
| Medium | Outer polling deadlines may be exceeded by an in-progress capture/OCR operation. | Propagate remaining-time budgets without automatically replaying actions. |
| Medium | Only Helium has live verification here. Other browser identities have fixtures and documented shared shortcuts. Custom classes and modified shortcuts need evidence. | Add collision-checked identity configuration and a live compatibility matrix. Do not infer browsers from arbitrary title text. |
| Medium | Uploads, downloads, and native dialogs lack a dedicated verified workflow. | Add foreground dialog targeting and explicit local-file selection within the current transport and clipboard boundaries. |
| Low | App launch and browser discovery have separate inventory paths; profile details remain Zen/Firefox-specific. | Consolidate inventory after adding real packaging fixtures. |

The PR improves common foreground work and failure handling. It does not claim DOM control, reliable background concurrency, universal browser support, or complete multi-monitor correctness.

## Benchmark-driven follow-up

The user explicitly authorized clipboard tools, superseding the old repository prohibition. The PR adds image metadata, private export, and scoped paste commands using [cliphist](https://github.com/sentriz/cliphist) and [wl-clipboard](https://github.com/bugaevc/wl-clipboard). No text history previews or image bytes enter audit events. A paste requires a validated focused editable accessible field, verifies bytes, never presses Enter, and restores the preferred original MIME or an empty selection. It leaves a detected new user selection alone. Full multi-MIME restoration and history rollback remain gaps.

Live GTK checks exposed window-relative accessibility extents in the Wayland session. The selected accessible frame is now aligned with the compositor's live title and dimensions, and descendant positions inherit that offset. Semantic text uses the explicit AT-SPI Text interface for exact readback. Focus requests wait for asynchronous state confirmation instead of repeating the action.

A kernel-held `flock` lease serializes input across Saarthi invocations and releases when its owner dies, including SIGKILL. Tests cover concurrent refusal, nested transactions, error release, and actual owner death. This does not isolate the desktop from the user or unrelated software.

[SaarthiBench v1](../../benchmarks/README.md) adds 64 controlled GTK workflows with signed saved outcomes, preservation checks, action/time budgets, and complete-denominator reporting. [OSWorld](https://github.com/xlang-ai/OSWorld) provides the stronger model of real-application execution-based evaluation. The current scripted reference is a tooling regression track; an independent autonomous Codex comparison has not been run. The [OpenAI integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration) describe computer tooling integrations, not a comparable Codex product score.

Pilot runs found an empty-selection failure and asynchronous focus readback. Both now have targeted handling. Repeated clipboard workflows also exposed native crashes in the benchmark GTK process. Core dumps confirmed the fixture crash; the exact underlying native cause was not established. Failed pilot traces remain local and are not combined with later runs.
