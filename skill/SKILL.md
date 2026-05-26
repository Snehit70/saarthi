# use-mcp computer-use skill

Use this skill when a task requires reliable desktop control on Hyprland (especially chat/web-app navigation with OCR + mouse).

## Primary objective

Execute desktop tasks safely and deterministically with strict state verification between actions.

## Mandatory loop (do not skip)

1. `workspace_focus` to expected workspace.
2. `window_find` + `window_focus` to lock target app.
3. Take baseline screenshot (`desktop_screenshot_save`).
4. For every UI action:
   - move (`mouse_move` / `mouse_move_to_text`)
   - verify state (`desktop_screenshot_save` or OCR check)
   - click (`mouse_click` / `click_text`)
   - verify resulting state before next step
5. Only type/send after right-pane state is explicitly verified.

## Hard guardrails

- Never chain multiple clicks without verification between them.
- Never type into a chat/input unless active header/state matches intended target.
- If modal/context menu appears unexpectedly, recover first (`key_press` with `escape`) and re-verify.
- Keep send as a separate final action; do not auto-send unless requested.
- If focus drifts to another window, immediately `window_focus` back before continuing.

## Tooling strategy

- Prefer explicit coordinates with `target` (`full|monitor|active_window|window`) for repeatable actions.
- Use OCR tools (`find_text_on_screen`, `resolve_text_point`, `click_text`) as hints, not ground truth.
- Validate OCR results with geometry:
  - left-list targets should remain in left pane
  - header checks should be in top-right pane
- Use `click_wait_retry` only when expected-state text is clearly detectable.

## Failure taxonomy (report explicitly)

- `focus_drift`: active window changed mid-loop.
- `ocr_ambiguous`: text found but not unique/actionable.
- `wrong_hotspot`: click opened context menu or wrong control.
- `state_not_changed`: click landed but target pane/header unchanged.
- `verification_skipped`: action was taken without proof checkpoint.

## Minimal run report format

- baseline screenshot path
- attempted action points/text anchors
- verification result after each action
- final state (achieved / blocked) and blocker reason
