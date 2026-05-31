---
name: saarthi-computer-use
description: Use when controlling the local Hyprland desktop through the saarthi server, especially browser, WhatsApp Web, PDF viewer, window/workspace, screenshot, accessibility-tree (ui_find), OCR, grid, mouse (click/drag), keyboard, and wait/verify tasks that require verified real-screen interaction.
---

# saarthi Computer Use

Use this skill for real desktop work through the `saarthi` MCP server. The goal is reliable interaction, not fastest possible clicking.

## Server and Overlay Control

The Saarthi MCP server is stdio-only and belongs to the current MCP host/client
session. Do not start or restart `saarthi-mcp.service`; if it exists, disable it.
Use MCP tools directly after the client starts the stdio server.

The eyes overlay HUD is the only persistent user service:

```bash
systemctl --user restart saarthi-overlay.service
systemctl --user status saarthi-overlay.service --no-pager
journalctl --user -u saarthi-overlay.service -n 100 --no-pager
```

If the overlay service is not installed yet:

```bash
/home/snehit/projects/saarthi/scripts/install-overlay-service.sh
```

Cleanup for the old invalid MCP service:

```bash
systemctl --user disable --now saarthi-mcp.service || true
rm -f ~/.config/systemd/user/saarthi-mcp.service
systemctl --user daemon-reload
```

## Core Rule

Every meaningful action must be grounded in the current screen:

1. focus the target window
2. take or inspect a screenshot
3. choose a target — prefer the accessibility tree (`ui_find`) for exact, addressable elements; fall back to grid/OCR/window metadata
4. let the UI settle (`wait_for_stable` / `wait_for_text`) when it may still be loading or animating
5. move or click
6. verify the resulting state before the next action (`screenshot_compare`, OCR, or `ui_find`)

Do not type, send, delete, archive, block, clear, or navigate away unless the current state proves the target is correct.

## Consent and Irreversible Actions

Reversible actions are free; irreversible or outbound actions need a human "yes" first. The trigger is the intent, not the app.

**Free** (act without asking): navigate, URL-bar Enter, search, focus, scroll, screenshot, open a menu, type into a field — anything you can undo.

**Gated** (stop and ask me in chat before doing it):

1. **Dispatching a message** — clicking send, or pressing Enter while a message composer is focused.
2. **Committing a form** — post, publish, reply, place order, confirm, save-and-submit.
3. **Destructive data ops** — delete, archive, clear, remove, block.
4. **Money** — pay, buy, confirm a purchase.

So: Enter to load a URL is free; Enter in a chat composer is a *send* and is gated.

**How to ask:** stop, state the exact action and target (for a message, include the recipient and the message text), and wait for an explicit yes before proceeding.

**Approval scope:** one "yes" covers that one action — approving a delete does not authorise the next. If I explicitly widen it ("send all of these", "you don't need to ask each time"), treat that as standing approval for that *action class* until the task changes, then it resets to per-action.

**Dry-run is exempt** — nothing actually happens, so no consent is needed.

## Preferred Tool Order

For terminal/CLI work, skip GUI targeting entirely and use the tmux tools (see **## tmux**) — they are deterministic. The order below is for GUI apps.

1. `desktop_health`, `window_find`, `window_get`, `window_focus`
2. `workspace_topology` when task depends on monitor columns/left-right workspace placement
3. `workspace_focus_relative` for deterministic left/right column hops (`createIfAbsent=true` when a monitor has no workspace)
4. `window_focus_best` when `window_find` has multiple candidates
5. `wait_for_stable` after launching/navigating, before inspecting
6. `ui_find` first — exact element targets with clickable `cx,cy` (use when the app exposes accessibility)
7. `desktop_screenshot_save`, then `grid_show` / `find_text_on_screen` when accessibility is unavailable (browsers, Electron, canvas)
8. `grid_cell_rect` for deterministic region bounds, then `desktop_screenshot_area` when you need stable cropped verification
9. `grid_cell_to_point`, `grid_move`, `mouse_verify_in_view`
10. `mouse_click` (with `ui_find` center, `target: "full"`), `grid_click`, `click_text`, or `mouse_drag` for sliders/selections
11. `action_step` for atomic verify loops when action certainty is critical
12. `screenshot_compare` / `wait_for_text` / OCR verification
13. `type_text` / `window_focus_and_type` only after target state is verified (`sensitive: true` for secrets)

Prefer `target: "window"` with a concrete `windowId` over `active_window` for multi-step work. This avoids focus drift.

## Accessibility-First Targeting

When the target app exposes the accessibility tree, `ui_find` beats OCR and grid:

1. `ui_find` with `nameContains` / `role` (and `interactive: true`) scoped to the focused app.
2. Read the matched element's `cx,cy` (screen coordinates) and `states` (e.g. `sensitive`/`enabled`).
3. Click with `mouse_click` `target: "full"`, `x=cx`, `y=cy`.
4. Use `ui_tree` to understand an unfamiliar UI before acting.

`ui_find` coordinates are only valid within the same step. If you `wait_for_stable`/`wait_for_text` or otherwise let the UI change after finding, re-query `ui_find` before clicking — a scroll or relayout invalidates the old `cx,cy`.

Coverage is toolkit-dependent: GTK/Qt and most native apps expose a usable tree; Chromium/Electron and Firefox expose content only with accessibility enabled. If `ui_find` returns nothing meaningful, fall back to grid/OCR.

## Verification and Settling

- After launching/navigating, call `wait_for_stable` (target the window) so you act on a settled frame, not a half-loaded one.
- Use `wait_for_text` (`mode: "appear"`) to block until expected content shows, or `"disappear"` to confirm a spinner/dialog cleared.
- To prove an action changed something, capture a baseline, act, then `screenshot_compare` (or `action_step` which does before/after + verify in one call).
- Defaults are sane (`wait_for_stable`: 8s timeout, ~1% RMSE, 2 stable frames; `wait_for_text`: 8s, 400ms poll). Raise `timeoutMs` for slow apps. A timeout returns `{stable:false}`/`{ok:false}` — treat that as `not_settled` and apply the Recovery Rules; do not blindly proceed.

## Input Primitives

- Double/triple click: `mouse_click` with `clickCount`.
- Sliders, selections, drag-and-drop: `mouse_drag` (both endpoints relative to the same target).
- Hover/motion-driven UIs: `mouse_move` with `smooth: true` so the cursor glides and fires motion events.
- Typing secrets (passwords): `type_text` / `window_focus_and_type` with `sensitive: true` so the value is masked in the status overlay.

## Grid Workflow

Use grid targeting when the UI is visually dense or OCR is ambiguous.

1. Run `grid_show` on the target window.
2. Inspect the overlay image path.
3. Pick the cell center closest to the intended UI element.
4. Run `grid_cell_rect` if you want exact region bounds and cropped screenshot verification.
5. Run `desktop_screenshot_area` with that rectangle when region proof matters.
6. Run `grid_cell_to_point` if you need exact cursor coordinates.
7. Run `grid_move`.
8. Run `mouse_verify_in_view`.
9. Run `grid_click`.
10. Verify with screenshot or OCR.
11. Run `grid_hide` when the grid session is no longer useful.

Use coarse grid first. If the cell is too large, call `grid_show` again with higher `cols`/`rows` rather than guessing inside a large cell.

## OCR Policy

OCR is a hint, not proof. Prefer `ui_find` when the app exposes accessibility; reach for OCR when it does not.

- Use OCR to locate candidate text.
- Verify the match is in the expected region.
- Avoid acting on text if the same label can appear in multiple places.
- Prefer partial tokens for discovery (`CODE`, `TEJAS`) but verify final state with stronger anchors (header title, input placeholder, selected row).
- For non-fullscreen targets, use tools that convert target-relative coordinates internally (`click_text`, `mouse_move_to_text`) or grid tools.

## tmux (terminal control)

On this machine every terminal is already a tmux session: kitty's shell is a `sesh` launcher, so each window attaches/creates a session named after its project directory (e.g. `praxis`, `pravah`, `saarthi`). prefix is `C-Space`, base-index 1, `renumber-windows on`, `M-H`/`M-L` switch windows, `prefix+j` is the sesh picker.

**For anything in a terminal, drive tmux directly — never type through the window manager and never screenshot/OCR a terminal.** Reading a pane is deterministic; so is running a command and reading its exit code.

Tools:

- `tmux_list` — discover sessions/windows/panes and each pane's `pane_current_command`. Start here to find a target. (read)
- `tmux_capture` — read a pane's text (and scrollback). This replaces screenshots/OCR for terminal state. (read)
- `tmux_run_command` — run a shell command in a pane and wait for completion; returns the parsed `exitCode` and the command's `output`. (act)
- `tmux_send_keys` — raw keys for REPLs/editors/pickers and control keys (Enter, Escape, C-c, arrows). Use after a pane has been confirmed. (act)

Rules:

- **Headless by name.** Act on `session:window.pane` (or a bare session name, or `%paneId`). No GUI focus required; background sessions work.
- **Targeting.** Explicit target wins; else a named session's active pane; else the attached active pane. If the tool returns `TMUX_TARGET_NOT_FOUND` or `TMUX_TARGET_AMBIGUOUS` (with candidates), ask which pane — never guess.
- **Execution consent.** Reads (`tmux_list`/`tmux_capture`) are always free. `tmux_run_command` reports a `classification`: `safe` (read-only commands — `ls`, `git status`, `rg`, `cat`, tests) run freely; `mutating` (`rm`, `git push`, `sudo`, `dropdb`, anything not on the allowlist) is a gated act — confirm in chat first, then widenable for the rest of the turn. This obeys **Consent and Irreversible Actions**.
- **Busy panes.** If a pane is not at a shell prompt (running vim, a REPL, ssh, a dev server), the tool refuses with `TMUX_PANE_BUSY` and names what's running. Ask the user, then re-call with `confirmBusy: true`. Do not blindly send into a non-shell pane.
- **No lifecycle.** Never create or kill sessions/windows/panes — operate only within existing ones. The user owns structure via sesh.
- **Completion is the exit code, not the vibe.** `tmux_run_command` waits on a sentinel and returns the real exit code (`$status` on fish, `$?` elsewhere). Branch on `exitCode === 0`, not on output text.
- **Interrupts.** On timeout the tool sends `C-c` to the command it started and returns `timedOut: true` — report that, raise `timeoutMs`, or pick a different approach. Never send `C-d`/exit, and never interrupt a process the user launched.

## Zen browser

On this machine Zen is the primary browser and is the Flatpak app `app.zen_browser.zen`. `browser_discover` is the source of truth before browser work: it reports running Zen windows, profile paths, device prefs, containers, extensions, and configured Zen shortcuts. Do not generalize these facts to another machine without rediscovery.

Current device facts verified from the local Zen profile:

- Single profile: `5yvfntxd.Default (release)` under `~/.var/app/app.zen_browser.zen/.zen`.
- Vertical tabs are on the right (`zen.tabs.vertical.right-side=true`), so right-edge grid clicks may hit tabs/pinned tabs.
- The URL bar floats (`zen.urlbar.behavior=float`), so URL/chrome targeting should use keyboard shortcuts, not fixed coordinates.
- Zen spaces are active with continue-where-left-off (`zen.workspaces.continue-where-left-off=true`).
- A public `College` container exists.
- Installed active extensions include Vimium, uBlock Origin, Dark Reader, SponsorBlock, Unhook, Consent-O-Matic, Tampermonkey, Control Panel for Twitter, and Sink It for Reddit.
- Live AT-SPI probe on 2026-05-31 against `Example Domain — Zen Browser` returned no Zen app/page elements, so treat Zen page AT-SPI as unavailable on this machine unless a fresh probe proves otherwise.

Authenticated browser model:

- Use the user's existing local Zen profile/window so cookies, localStorage, saved passwords, extensions, and containers stay intact.
- Do not create a clean/headless/browser-test profile for user-facing browser tasks; that loses auth state and changes fingerprint/extension behavior.
- Do not attach another independent automation engine to the same profile. Browser profiles are single-owner state; competing controllers can lock or corrupt session behavior.
- Prefer local GUI/extension-aware control over remote browser transport. This repo intentionally keeps stdio MCP and does not expose browser HTTP/CDP control.
- If auth has expired, navigate to the login/recovery page and stop for user action or explicit credentials. Never scrape saved passwords, never guess credentials, and never auto-submit login.

Tools:

- `browser_discover` — read Zen install/profile/prefs/container/extension/shortcut facts and running windows. Start here. (read)
- `browser_focus` — focus the best matching Zen window. (act)
- `browser_open_url` — open an allowed URL. Default is a new tab in an existing Zen window; falls back to a new window when no Zen window exists. (act)
- `browser_vimium_hint` — Vimium-first page targeting: focus Zen, press `f`, type visible text, optionally commit with Enter. (act)
- `browser_space_step` — switch Zen spaces forward/backward using configured shortcuts and return the opposite restore action. (act)

Rules:

- **Page targeting order.** For in-page elements, use Vimium first: `browser_vimium_hint` with the element's visible text. If Vimium cannot target it, try AT-SPI with `ui_find`. If AT-SPI does not expose useful page content, fall back to OCR/grid.
- **Chrome targeting.** Do not use Vimium for URL bar, tabs, spaces, settings panels, or browser chrome. Use `browser_open_url`, Zen shortcuts, `browser_space_step`, or grid/OCR against verified chrome regions.
- **Navigation default.** Routine navigation goes to a new tab: `Ctrl+T`, `Ctrl+L`, type URL, `Enter` through `browser_open_url`. Navigate the current tab only when the active tab is already verified blank/new-tab or the user says "here"; then pass `mode:"current-tab"` and `currentTabReason`.
- **Fast navigation loop.** Use `browser_open_url` as the single primitive for open/focus/type/Enter/readiness. Its default is fast: open a new tab, focus the floating URL bar, type the URL, press Enter, then watch the Zen title for readiness. For known apps, pass `readiness:"title-contains"` with a stable title fragment (for example `Inbox`, `Dashboard`, or the product name). For throwaway blank pages or follow-up checks where you will immediately use `wait_for_text`, pass `readiness:"none"` to avoid double-waiting.
- **Readiness is a hint, not proof.** `browser_open_url` can return `readiness.ready:false` when the title does not settle before `readyTimeoutMs`. That means the URL was entered but page readiness is unproven. Do not click/type into page content yet; run `wait_for_text`, screenshot/OCR, or grid verification. If those fail too, label `not_settled` or `verification_failed`.
- **New windows.** Use `browser_open_url` with `mode:"new-window"` only when the task explicitly asks for a new window or no Zen window exists.
- **Spaces and pinned tabs.** It is acceptable to switch Zen spaces and click pinned tabs to reach a target, but record the starting space/route and switch back before finishing. `browser_space_step` returns the restore direction/count. Never close, unpin, or repin pinned tabs.
- **Commit gates.** Reading, scrolling, navigation, and typing into fields are free. Pause for chat confirmation before submit/send/post/buy/payment/destructive actions. `browser_vimium_hint` refuses to commit gated action kinds unless `confirmed:true`; this does not replace the need to verify the target first.
- **Login safety.** Type only credentials explicitly provided in the task. Never use, save, guess, or submit stored credentials. Do not auto-submit login forms.
- **Hands off config.** Do not change Zen settings, `about:config`, profiles, containers, extensions, or extension settings as a side effect. If a task seems to need configuration changes, ask and treat that as a separate gated task.
- **Extension awareness.** Work with installed extensions. Do not re-dismiss a banner Consent-O-Matic handled. Expect Dark Reader color changes. Remember that uBlock Origin and Unhook may remove page elements; missing page content may be intentional.
- **AT-SPI check.** Current local evidence says Zen page AT-SPI is unavailable. Before depending on `ui_find` for a Zen page, focus Zen and run a small `ui_find`/`ui_tree` probe. If it returns only chrome or no useful page nodes, label that route `a11y_unavailable` and proceed to OCR/grid.

Performance and failure readiness:

- Keep one live Zen window warm. Cold Flatpak launch can take tens of seconds; existing-window new tabs usually complete in one tool call.
- Prefer title readiness first because it is cheap and does not require screenshots. Use visual waits only for page-specific proof.
- Do not chain manual `browser_focus` + `key_press` + `type_text` + `key_press` for normal URLs; that is slower and easier to race than `browser_open_url`.
- After navigation, start from the returned `window.id` and `readiness` fields. If `ready:true`, inspect the page immediately. If `ready:false`, wait for one strong page anchor (`wait_for_text`) before acting.
- For pages that keep the old title during SPA loads, use `readiness:"none"` plus `wait_for_text` on a real page anchor; otherwise title-change waiting wastes time.
- For login or auth-expired pages, stop at the recovery screen unless credentials were explicitly provided. Typing credentials is allowed; submitting the login remains gated.
- If a Vimium hint fails or the wrong thing opens, press `escape`, verify the page/URL state, and try one alternate route (`ui_find` probe, then OCR/grid). Do not repeatedly press Enter or reuse stale hint labels.
- If Zen is missing from `browser_discover.runningWindows`, prefer `browser_open_url` with the requested URL instead of launching Zen separately. It records the fallback and readiness outcome.

## Browser and WhatsApp Web

Before messaging:

1. focus the browser window with `window_focus`
2. confirm WhatsApp is loaded with screenshot or OCR
3. select the chat/group
4. verify the right-pane header matches the intended chat/group
5. click the composer
6. type the message
7. send only if the user explicitly allowed sending in this turn
8. verify the message appears and the composer is clear

For WhatsApp chat selection:

- Use left-list grid cells or OCR anchors for the row.
- Avoid row-right icons for mute/pin/menu.
- If a context menu opens, press `escape`, verify it closed, and retry with a safer row/title/left-side cell.
- Do not type into the composer if the right header is wrong.

## Send Policy

Sending a message is a gated action (see **Consent and Irreversible Actions**). Default is prepare-only: select the chat, verify the right-pane header, click the composer, type the message, then stop and report the screenshot path. Click send / press Enter only after I approve sending. After sending, verify with a screenshot that the outgoing message is visible.

## Recovery Rules

- If focus drifts: `window_focus` the known `windowId`, then screenshot.
- If cursor might be off-target: `mouse_verify_in_view`.
- If a modal/context menu appears: `key_press` `escape`, then screenshot.
- If an action does not change state: do not repeat the same point. Try exactly **one** alternate *method* (e.g. `ui_find` → grid/OCR, or re-focus then retry) and re-verify. If that also fails, stop and report the failure label with evidence — do not keep looping.
- If URL bar/sidebar search traps input: click page content or use `escape`, then re-focus the address/page target.

## Failure Taxonomy

Use these labels when reporting a blocked action:

- `focus_drift`: target window lost focus
- `cursor_out_of_view`: pointer outside target bounds
- `ocr_ambiguous`: text match is not unique or not region-safe
- `a11y_unavailable`: app exposes no useful accessibility tree (fell back to grid/OCR)
- `wrong_hotspot`: click opened a menu or wrong control
- `state_not_changed`: click landed but expected UI did not change (confirm with `screenshot_compare`)
- `not_settled`: acted before the UI stabilised (`wait_for_stable`/`wait_for_text` would have helped)
- `verification_failed`: expected text/header/input state not found

`a11y_unavailable` is a **routing signal**, not a blocked action — fall back to grid/OCR and keep going; never report it as a failure. For every other label, report it (with evidence) only after the single alternate attempt from Recovery Rules has also failed.

## Run Evidence

For non-trivial tasks, report:

- target window id
- baseline screenshot path
- key grid cells or OCR anchors used
- final verification screenshot path
- whether the final action was sent/performed or only prepared

Check `logs/actions/run.jsonl` when diagnosing repeated failures.
