# Independent mouse and keyboard for background work

## Decision

A Hyprland workspace shares the user's seat. Input isolation needs a distinct
compositor/input context, so Saarthi now starts an explicitly requested headless
Sway desktop. No host workspace switch, uinput device, host cursor dispatch or
new Saarthi command server is involved. Existing host windows stay in Hyprland;
policy-approved applications start inside the private desktop.

Sources checked on 2026-10-22:

- [Hyprland 0.55.2 seat manager](https://github.com/hyprwm/Hyprland/blob/v0.55.2/src/managers/SeatManager.hpp) keeps focus in the compositor seat manager. Workspace placement does not supply another input context.
- [Wayland transient seat protocol](https://github.com/wayland-mirror/wayland-protocols/blob/main/staging/ext-transient-seat/ext-transient-seat-v1.xml) describes independent seats, but the installed host does not advertise this protocol. It is not a portable fix for the current laptop.
- [Weston backend documentation](https://wayland.pages.freedesktop.org/weston/toc/running-weston.html) distinguishes headless and nested compositors. Sway was chosen here because its available headless backend and IPC support explicit window targeting.
- [Sway 1.11 IPC implementation](https://github.com/swaywm/sway/blob/1.11/sway/ipc-server.c) supports an explicitly supplied private IPC path. Saarthi implements only a bounded client, without a raw caller-facing command endpoint.
- [Virtual pointer protocol](https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml) supplies absolute motion, buttons and axes to a selected compositor seat.
- [Virtual keyboard protocol](https://github.com/swaywm/wlroots/blob/master/protocol/virtual-keyboard-unstable-v1.xml) supplies keymaps and key/modifier events. Protocol license headers are preserved in the vendored XML files.
- [Sway keyboard lifecycle](https://github.com/swaywm/sway/blob/1.11/sway/input/keyboard.c) clears the seat keyboard when its active device is destroyed. This explained the null-keymap transition seen during testing. Saarthi retains the latest keyboard until a replacement is active.
- [wtype implementation](https://github.com/atx/wtype/blob/master/main.c) documents printable physical key codes for literal Chromium text. The native helper uses bounded printable-code maps, never control codes for literal text, and uses a complete US keymap for explicit shortcuts.

## Implementation

Six CLI commands provide start, status, policy-approved launch, typed input,
capture and stop. Private configuration, data/cache/state directories, browser
profiles, Wayland socket and D-Bus activation environment prevent normal host
session forwarding. Initial seat devices persist for the session. Each subsequent
keyboard helper accepts one action and then retains its device without a command
channel. The preceding helper closes only after the replacement acknowledges its
compositor roundtrip. Text goes over stdin, never argv or audit logs.

An interrupted keyboard action persists an input block before dispatch. Status
and capture remain available; further input and launches refuse until explicit
stop/recreation. Per-desktop kernel leases prevent interleaved callers while
leaving the foreground input lease available. PID start times, uid and both private
session markers protect identity. Cleanup uses revalidated Linux pidfds.

## Live evidence

These are controlled functional checks on the actual laptop, not an autonomous
benchmark score. Private screenshots were viewed before using them as evidence.
No user document or logged-in browser profile was used for input testing.

- A 1280 by 800 headless output started with an independent pointer and keyboard.
  Captures included its visible cursor. Kitty, GTK and Helium windows existed only
  in the private Sway tree.
- A GTK fixture received exact Unicode text including Hindi and a checkmark,
  punctuation and a string longer than one 48-code keymap batch. Its private JSON
  evidence matched the full expected string. The fixture recorded clicks, motion,
  drag press/release and wheel events.
- A real GTK chooser opened as a separate container. Ctrl+L, an explicit absolute
  path and navigation Enter selected `verification-file.txt`. The fixture's saved
  evidence and the post-dialog screenshot confirmed that filename.
- Helium navigated with the private keyboard to a controlled data URL. The page
  rendered `PRIVATE_BROWSER_OK`. Clicking its file input opened the private GTK
  desktop portal chooser. The same explicit-path workflow closed the dialog and
  displayed `verification-file.txt` beside the browser's file input. This proves
  local attachment selection, not a server upload.
- A seven-action GTK batch completed in 2424 ms while a separate foreground input
  lease was held. All 19 host samples matched the starting focused window,
  workspace and cursor position. The final host state matched and the clipboard
  hash was unchanged. This short sample is evidence for this run, not a throughput
  or reliability percentage across arbitrary applications. A final-build repeat
  took 4450 ms during other laptop activity, with all 16 host samples and the
  clipboard hash unchanged; native chooser selection and the browser window
  remained intact across that repeat.
- Earlier temporary keyboard destruction produced an actual Helium SIGSEGV in
  `xkb_state_update_mask`. Retaining devices fixed that tested transition. A
  separate first implementation put printable text on control physical codes and
  lost punctuation in Chromium; bounded printable-code maps fixed the controlled
  navigation and exact GTK text check.
- Browser startup exceeded the original 10-second readiness limit during laptop
  package-manager activity, then produced its private window. Browser readiness
  now allows 30 seconds, and timeout instructions require inspection before retry.
- One earlier idle compositor sample used about 31 MiB RSS with 0.0 percent CPU
  reported by ps. This excludes apps, portals and buffers. No general speedup or
  total-memory claim follows from that sample.

Verification assets remain private on the device. The manual fixture in
`test/fixtures/isolated-input.py` checks input plumbing and native dialogs. It is
not part of the scored 64-case scripted integration track or the 56 unrun real-app
challenge designs. No Codex comparison or autonomous benchmark score is claimed.

## Remaining compatibility limits

The backend is software rendered at 30 Hz and disables Xwayland. Host profiles,
logins and extensions do not carry over. Filesystem access remains under the same
user, so this is not a security sandbox. GPU games, X11-only apps, audio, screen
sharing, arbitrary portal workflows and all ten browser aliases are not verified
by this check. The laptop's private AT-SPI bus activation reported permission
errors, so isolated accessibility parity is not claimed. Existing host
accessibility and logged-in background-tab workflows remain separate adapters.

See [the operating guide](../ISOLATED-DESKTOP.md) for requirements, cleanup,
file-picker targeting and failure recovery.

## Automated checks

The local full suite passed 250 tests in 39 files. A frozen Bun install, native
build and built CLI smoke passed, covering 81 help commands and 33 read-only JSON
paths. Focused lifecycle, keyboard handoff and IPC checks also passed after the
final cleanup/deadline changes. CI runs these checks on the PR head.
