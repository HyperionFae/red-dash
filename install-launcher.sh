#!/usr/bin/env bash
# Run this ONCE to add "Red Dash" to your Omarchy app launcher.
# It fills in the correct folder path for you automatically.

DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"

cat > "$APPS/red-dash.desktop" << EOF
[Desktop Entry]
Name=Red Dash
Comment=Visual red team cockpit
Exec=$DIR/launch.sh
Icon=utilities-terminal
Type=Application
Terminal=false
Categories=Security;
EOF

chmod +x "$DIR/launch.sh"
echo "Done. Search 'Red Dash' in your app launcher."
