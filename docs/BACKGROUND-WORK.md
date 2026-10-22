# Background work

Use the installed Bun toolchain with `bun install --frozen-lockfile`, `bun run test` and `bun run build`. The CLI remains a per-invocation Node 22 executable. Normal use needs no development server.

## Capture an inactive workspace

```bash
saarthi screenshot workspace --workspace 4 --max-windows 12 --json
```

This writes private PNGs and a manifest containing window positions. View the images before making a visual claim. It captures individual surfaces, including on inactive workspaces, rather than reconstructing wallpaper, stacking or compositor effects. A missing mapping, unsupported window, identity change or workspace change stops the command. The default never temporarily focuses a window. To explicitly permit the old foreground route, use `screenshot capture --target window --window-id ID --allow-focus`.

Build prerequisites for the mapping helper are a C compiler, `pkg-config`, `wayland-scanner` and Wayland client development headers. `SAARTHI_REQUIRE_NATIVE=1 bun run build` fails if any are missing. The compositor must expose foreign toplevel mapping and the installed grim must support `-T`. Full 64-bit addresses are required.

## Inspect and attach files in a background tab

First inspect `open-browser-use profiles --connected`. Select the current task's actual browser/profile, then use that explicit selection and a unique session id throughout. `browser background-open` creates an owned, physically inactive tab. `browser background-tabs` lists only session-owned tabs. It never claims the user's unrelated tabs or moves their pinned/group state.

Each `browser background-act` reads one private JSON step file. For example:

```json
{
  "tabId": 123,
  "expectedUrl": "https://app.example.test/report",
  "action": "inspect"
}
```

Replace the example tab and URL with the live owned tab and exact page URL. `inspect` returns at most 200 controls with current selectors. Use an observed unique selector, then replace the step file with an action:

```json
{
  "tabId": 123,
  "expectedUrl": "https://app.example.test/report",
  "action": "files",
  "selector": "#attachments",
  "files": ["/absolute/path/report.pdf", "/absolute/path/figure.png"]
}
```

```bash
chmod 600 /private/step.json
saarthi browser background-act --browser-target chrome --profile Default --session-id report-task --step-file /private/step.json --json
```

Only explicitly listed regular files are transferred, at most 20 and 128 MiB total. Bytes travel through the local connection in chunks; private file paths and content never enter subprocess arguments or audit payloads. All files stage before one assignment. The result checks file names/sizes, not server-side upload completion. Follow with a `wait-text`/`read` checkpoint against the application's attachment list. Apps that require trusted native file events may need a foreground workflow. Browser permissions are never silently changed.

Use `screenshot` to capture the owned background tab directly. A native browser-window screenshot shows its physically selected tab, which can differ from the session's logical active tab. Browser-tab screenshots have also timed out on this machine when the containing window is on an inactive workspace; they fail with exit 17 and do not focus as a fallback. The browser adapter does not expose arbitrary JavaScript. It currently targets the top document, without a cross-origin frame or shadow-root selector API. Page permission prompts and native dialogs remain foreground work.

## Prepare 4–10 steps ahead

The calling agent plans ahead based on observed controls and state. The CLI executes the resulting typed plan. It does not supply an additional reasoning model.

A four-step plan has this shape. Replace the example targets, selectors, expected text and file with values observed in the application:

```json
{
  "id": "report-draft-001",
  "browser": {"browserTarget":"chrome","profile":"Default","sessionId":"report-task"},
  "allowedTabIds": [123],
  "steps": [
    {"kind":"browser","tabId":123,"expectedUrl":"https://app.example.test/report","action":"fill","selector":"#title","text":"Quarterly report"},
    {"kind":"browser","tabId":123,"expectedUrl":"https://app.example.test/report","action":"wait-text","selector":"#draft-status","text":"Draft saved"},
    {"kind":"browser","tabId":123,"expectedUrl":"https://app.example.test/report","action":"files","selector":"#attachments","files":["/absolute/path/report.pdf"]},
    {"kind":"browser","tabId":123,"expectedUrl":"https://app.example.test/report","action":"wait-text","selector":"#attachment-list","text":"report.pdf"}
  ]
}
```

```bash
chmod 600 /private/plan.json
saarthi plan run --plan-file /private/plan.json --json
```

Allowed browser actions are `inspect`, `read`, `fill`, `click`, `files`, `wait-text` and `screenshot`. Every mutation must immediately precede a checkpoint on the same tab: `wait-text`, or `read` with `expectText`. Observe real application progress, such as the next record identity or a saved indicator, rather than checking an unchanged generic page label. A new URL requires a new exact `expectedUrl` on the next step. Sensitive send/submit/delete/payment actions require `confirmed:true` after user authorization; ordinary form submit controls also require it.

Optional native capture steps use `{"kind":"capture","windowId":"0xabc"}`. Declare their scope separately:

```json
"allowedWindows": [{"windowId":"0xabc","workspace":"4","pid":12345}]
```

The executor checks live PID/workspace before and after each native capture. Browser scope consists of owned session tab ids; it does not guarantee the containing Hyprland window is on workspace 4. Global keyboard/mouse and foreground semantic UI actions are deliberately absent from this background executor. A reserved workspace alone cannot isolate them from your seat.

One browser connection and a session-specific kernel lease cover all steps. Different browser sessions and non-focusing screenshots do not acquire the desktop input lease. This coordinates Saarthi invocations; it does not lock out a user editing the same page.

## Recover without duplicate actions

Plan receipts live under `~/.local/state/saarthi/plans/ID.json`. They contain a source hash, status, completed count and an in-flight index, with no entered text, page URL or file content. Explicit command output can contain private page text and artifact paths, so keep it private.

The executor writes and syncs the in-flight index before each action, then advances the completed count only after its result. Any existing id refuses execution, including a completed, failed, truncated or interrupted receipt. On failure, the CLI error reports the receipt, completed steps and in-flight index. Inspect actual state because the in-flight operation may already have taken effect. Prepare a new id with only remaining verified work. Never delete the receipt and replay the old plan.

At task completion, close owned intermediate tabs:

```bash
saarthi browser background-finish --browser-target chrome --profile Default --session-id report-task --json
```

Use `--keep-tab-ids 123,456` only for owned handoff tabs the user still needs. Finalization does not claim or close unrelated tabs. Inspect all desired results before finalizing.
