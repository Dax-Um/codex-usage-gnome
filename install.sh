#!/usr/bin/env bash
set -euo pipefail

UUID="codex-usage@local"

gnome-extensions enable "$UUID"

cat <<'MSG'
Enabled codex-usage@local.

Reload GNOME Shell:
- X11: Alt+F2, type r, press Enter
- Wayland: log out and log back in
MSG
