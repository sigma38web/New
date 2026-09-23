#!/usr/bin/env bash
set -euo pipefail

PORT="${NOTION_PORT:-8092}"
TOKEN="${NOTION_BRIDGE_TOKEN:-yeonjae_hoplite_bridge_sec_7792a18f4c}"

echo "=== Notion AI Provider Bridge Manager ==="

PID=$(pgrep -f "notion_provider_bridge.py" || true)
if [ -n "${PID}" ]; then
    echo "Notion AI Bridge is already running (PID: ${PID})."
else
    echo "Starting Notion AI Bridge on port ${PORT}..."
    NOTION_BRIDGE_TOKEN="${TOKEN}" NOTION_PORT="${PORT}" NOTION_HOST="127.0.0.1" nohup python3 /home/ubuntu/New/tools/notion_provider_bridge.py > /home/ubuntu/notion_bridge_service.log 2>&1 &
    sleep 2
fi

curl -s "http://127.0.0.1:${PORT}/health"
echo ""
echo "Notion AI Bridge is live at: https://archivedb.duckdns.org/notion/v1/complete"
