#!/bin/bash

PLIST_DIR="$HOME/Library/LaunchAgents"

echo "=== Uninstalling Lot Radio Schedule ==="

launchctl unload "$PLIST_DIR/com.lotradio.schedule.plist" 2>/dev/null && echo "  Cron unloaded" || echo "  Cron not loaded"
launchctl unload "$PLIST_DIR/com.lotradio.bot.plist" 2>/dev/null && echo "  Bot unloaded" || echo "  Bot not loaded"

rm -f "$PLIST_DIR/com.lotradio.schedule.plist"
rm -f "$PLIST_DIR/com.lotradio.bot.plist"

echo "Done. Files removed from LaunchAgents."
