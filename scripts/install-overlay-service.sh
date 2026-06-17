#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/snehit/projects/saarthi"
UNIT_NAME="saarthi-overlay.service"
SOURCE_UNIT="$REPO_ROOT/systemd/$UNIT_NAME"
TARGET_DIR="$HOME/.config/systemd/user"
TARGET_UNIT="$TARGET_DIR/$UNIT_NAME"
OLD_UNIT_NAME="saarthi-mcp.service"
OLD_TARGET_UNIT="$TARGET_DIR/$OLD_UNIT_NAME"

mkdir -p "$TARGET_DIR"

systemctl --user disable --now "$OLD_UNIT_NAME" || true
rm -f "$OLD_TARGET_UNIT"

# Drop any prior enablement links before reinstalling so target migrations
# (for example default.target -> graphical-session.target) do not leave stale
# symlinks behind.
systemctl --user disable --now "$UNIT_NAME" || true

install -m 0644 "$SOURCE_UNIT" "$TARGET_UNIT"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

echo "Installed and started $UNIT_NAME at $TARGET_UNIT"
echo
echo "Manage the overlay HUD with:"
echo "  systemctl --user restart $UNIT_NAME"
echo "  systemctl --user status $UNIT_NAME --no-pager"
echo "  journalctl --user -u $UNIT_NAME -n 100 --no-pager"
echo
echo "MCP remains stdio per client session; do not start $OLD_UNIT_NAME."
