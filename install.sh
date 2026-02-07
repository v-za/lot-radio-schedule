#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.lotradio.schedule"
BOT_LABEL="com.lotradio.bot"
PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_PATH="$(which node)"

echo "=== Lot Radio Schedule Installer ==="
echo ""

# 1. Check .env
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "ERROR: .env file not found."
  echo "Copy .env.sample to .env and fill in your values:"
  echo "  cp .env.sample .env"
  exit 1
fi

# 2. Install dependencies
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production
echo ""

# 3. Create daily cron (launchd) — runs at 9 AM every day
echo "Setting up daily schedule (9 AM)..."
mkdir -p "$PLIST_DIR"

cat > "$PLIST_DIR/$PLIST_LABEL.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$SCRIPT_DIR/generate.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$SCRIPT_DIR/output/cron.log</string>
  <key>StandardErrorPath</key>
  <string>$SCRIPT_DIR/output/cron.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

# Unload if already loaded, then load
launchctl unload "$PLIST_DIR/$PLIST_LABEL.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/$PLIST_LABEL.plist"
echo "  Daily cron loaded: $PLIST_LABEL (9 AM)"

# 4. Set up Slack bot daemon
echo "Setting up Slack bot daemon..."

cat > "$PLIST_DIR/$BOT_LABEL.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$BOT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$SCRIPT_DIR/bot.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$SCRIPT_DIR/output/bot.log</string>
  <key>StandardErrorPath</key>
  <string>$SCRIPT_DIR/output/bot.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST_DIR/$BOT_LABEL.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/$BOT_LABEL.plist"
echo "  Bot daemon loaded: $BOT_LABEL (always running)"

echo ""
echo "=== Done! ==="
echo "  Daily schedule: generates and posts to Slack at 9 AM"
echo "  Bot: listens in Slack for day names (e.g. 'Monday', 'tomorrow', '2026-02-10')"
echo ""
echo "  Logs: $SCRIPT_DIR/output/cron.log"
echo "         $SCRIPT_DIR/output/bot.log"
echo ""
echo "  To uninstall: bash $SCRIPT_DIR/uninstall.sh"
