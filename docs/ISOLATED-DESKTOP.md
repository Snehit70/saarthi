# Independent desktop input

`desktop` commands create a private headless Sway desktop with its own cursor,
keyboard focus, output and session bus. The user's Hyprland workspace stays
available. Apps must be launched inside this desktop. Existing host windows
cannot be moved into it by changing workspace numbers.

## Requirements

Linux with `/proc`, Python 3 with pidfd support, `flock`, Sway, `dbus-daemon`,
`dbus-update-activation-environment`, `grim`, and Wayland-native applications.
Build the native helpers with a C compiler, `pkg-config`, `wayland-scanner`,
Wayland client headers and xkbcommon development headers:

```bash
SAARTHI_REQUIRE_NATIVE=1 bun run build
```

The launch policy must allow `isolated-desktop` and the requested application.
The compositor resolver accepts `sway` on PATH or the explicit user-local path
`~/.local/share/saarthi/compositor/usr/bin/sway`. For that user-local installation
only, its sibling `usr/lib64` supplies libraries. Apps never inherit this library
path. Saarthi does not download or install a compositor automatically.

On the verification laptop, Sway 1.11 and wlroots 0.19.3 came from official Fedora
44 RPMs whose signatures were verified with `rpm --checksig`. They were extracted
under that user-local directory without changing system packages or the host
compositor configuration. Other distributions should use their package manager's
Sway and development packages.

## Start, inspect and stop

```bash
saarthi desktop start --name 'Report worker' --width 1280 --height 800 --json
# Use the returned desktop.id in every following command.
saarthi desktop launch --desktop-id ID --app-name kitty --json
saarthi desktop status --desktop-id ID --json
saarthi desktop capture --desktop-id ID --json
saarthi desktop stop --desktop-id ID --json
```

View the returned PNG before acting. It includes the private cursor by default;
`--no-cursor` omits it. Container ids in `desktop status` are integers belonging
to this compositor. They are unrelated to Hyprland hexadecimal window ids.

At most three desktops may run. Each uses a private runtime directory under
`/run/user/UID/saarthi-isolated/ID` and a private state record under
`~/.local/state/saarthi/isolated`. No host display or session-bus fallback exists.
Compositor, bus and device identities must still match their PID start times,
user id and both session markers before an operation proceeds.

Stop closes only processes verified as belonging to that session, including
reparented app and D-Bus children. Linux pidfds prevent signalling an unrelated
process after PID reuse. Stop does not delete profiles, logs, captures or user
files. Runtime files normally disappear when the login runtime is removed.
There is no automatic idle timeout: explicitly stop desktops after use. Closing
apps can discard unsaved work, so save and verify intended artifacts first.

## Mouse, keyboard and file pickers

Write a JSON array to a private file owned by the current user, mode 600. Use the
exact current window id and PID from `desktop status` on every action:

```json
[
  {"action":"focus","windowId":5,"pid":12345},
  {"action":"click","windowId":5,"pid":12345,"x":400,"y":90},
  {"action":"type","windowId":5,"pid":12345,"text":"Quarterly report"},
  {"action":"key","windowId":5,"pid":12345,"key":"tab"}
]
```

```bash
chmod 600 /private/actions.json
saarthi desktop input --desktop-id ID --actions-file /private/actions.json --json
saarthi desktop capture --desktop-id ID --json
```

Supported actions are `focus`, `move`, `click`, `drag`, `scroll`, `type` and `key`.
A batch has 1 to 10 actions. Coordinates are absolute private-output pixels and
must fit both the desktop and declared window. Drag adds `endX`, `endY` and an
optional `durationMs` of 100 to 2000. Click accepts `left`, `middle` or `right`
and one or two `clicks`. Scroll requires `direction` and 1 to 20 `steps`.

Text supports Unicode, up to 4000 UTF-16 code units, passed over stdin. Literal
text never uses Escape, Tab, Enter, Backspace or modifier physical key codes.
Explicit keys use a US keymap and support letters, digits, Enter, Tab, Escape,
Backspace, Delete, arrows, Home, End, Page Up, Page Down and F5. Modifiers are
`ctrl`, `alt`, `shift` and `super`. Text cannot contain line breaks or tabs.
Enter and Delete need `confirmed: true` or `actionKind: "navigate"`. Sending,
submitting, deleting and payment clicks/keys require `confirmed: true`.

For a native chooser, open it with observed controls, then inspect status again.
Dialogs can have a new container id even when the PID stays the same. Target
that dialog, use Ctrl+L to enter the explicitly requested absolute path, and
press Enter with navigation intent. Capture and verify the actual selected
filenames or attachments after the dialog closes. Do not keep using the parent
window id after a dialog gains focus. Browser file-input actions through the
existing background adapter remain a faster option when supported.

Each desktop has its own kernel input lease. Commands on different desktops can
run independently of the foreground desktop input lease. Within one desktop,
concurrent commands return `INPUT_BUSY` instead of interleaving. Window identity
and focus are checked immediately before each action. A failure stops the batch
and reports completed steps and the uncertain in-flight index. Inspect the app,
then prepare only the remaining actions. These batches do not have the durable
plan-id replay protection provided by `plan run`.

The latest keyboard action retains its virtual device until its replacement has
completed a compositor roundtrip. The previous device then closes through a
verified pidfd. This avoids publishing an empty keymap between invocations. These
helpers accept one action at launch and never listen for more commands. A dead
retained keyboard invalidates the session; stop and recreate it. An interrupted
keyboard dispatch leaves `inputBlocked: true` persisted before dispatch. Capture
and status remain available, but input and app launches refuse until the desktop
is stopped and recreated. A successful
receipt proves dispatch, so application readback or visual verification is still
required.

## App behavior and limits

Browsers use fresh private profiles, private XDG directories and a private
session bus. Chromium password saving is disabled in these automation profiles;
the host profile is untouched. Host logins, extensions and saved passwords do
not carry over. Kitty starts with default configuration and a shell without user
startup files, avoiding accidental attachment to a host tmux session. Other apps
can still read HOME and explicitly opened files. This is input isolation, not a
filesystem or security sandbox.

Sway uses one software-rendered headless output at 30 Hz, with Xwayland disabled.
This suits documents, browser forms and ordinary UI work. Hardware-accelerated
apps, games, X11-only programs, screen sharing, audio and desktop portal flows
need separate compatibility verification. A browser can take up to 30 seconds
to produce a window. On timeout, inspect status before retrying because the app
may still be starting. No automatic launch or action replay occurs.

Use the existing browser adapter for tasks that need the user's logged-in tabs.
An ordinary hidden Hyprland workspace still shares the host keyboard and mouse;
use these `desktop` commands when independent native input is required. This
backend does not add a Saarthi daemon, HTTP endpoint, remote transport or MCP
server. Its explicit lifetime consists of the compositor, private bus, fixed
Wayland device clients and requested apps.
