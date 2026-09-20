#!/usr/bin/env bash
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-8091}"
TOKEN="${GENSPARK_BRIDGE_TOKEN:-yeonjae_hoplite_bridge_sec_7792a18f4c}"
LOG_FILE="/home/ubuntu/genspark_tunnel.log"

echo "=== Genspark Cloudflare Tunnel Manager ==="

# Check if bridge is running
if ! curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
    echo "Starting Genspark bridge with authentication on port ${BRIDGE_PORT}..."
    GENSPARK_BRIDGE_TOKEN="${TOKEN}" GENSPARK_TIMEOUT=1800 nohup python3 tools/genspark_provider_bridge.py --port "${BRIDGE_PORT}" --host 127.0.0.1 > /home/ubuntu/genspark_bridge_service.log 2>&1 &
    sleep 2
fi

# Check if cloudflared tunnel is already running for this port
PID=$(pgrep -f "cloudflared tunnel --url http://127.0.0.1:${BRIDGE_PORT}" || true)
if [ -n "${PID}" ]; then
    echo "Cloudflare Tunnel is already running (PID: ${PID})."
else
    echo "Starting new Cloudflare Quick Tunnel..."
    nohup cloudflared tunnel --url "http://127.0.0.1:${BRIDGE_PORT}" > "${LOG_FILE}" 2>&1 &
    sleep 5
fi

# Extract URL
URL=""
for i in {1..15}; do
    if [ -f "${LOG_FILE}" ]; then
        URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "${LOG_FILE}" | tail -n 1 || true)
        if [ -n "${URL}" ]; then
            break
        fi
    fi
    sleep 1
done

if [ -z "${URL}" ]; then
    echo "Failed to extract tunnel URL. Check ${LOG_FILE}"
    exit 1
fi

echo ""
echo "============================================================"
echo "GENSPARK BRIDGE TUNNEL IS LIVE AND PROTECTED:"
echo "Public URL: ${URL}/v1/complete"
echo "Bearer Token: ${TOKEN}"
echo "============================================================"
echo ""
echo "Copy and paste these environment variables into Hoplite / Sandbox .env:"
echo ""
echo "YEONJAE_PROVIDER_MODE=genspark"
echo "YEONJAE_GENSPARK_URL=\"${URL}/v1/complete\""
echo "YEONJAE_GENSPARK_TOKEN=\"${TOKEN}\""
echo "YEONJAE_GENSPARK_TIMEOUT_MS=1800000"
echo "YEONJAE_MODEL_R=\"claude-opus-4-6\""
echo "YEONJAE_MODEL_DEFAULT=\"gemini-3.8-flash\""
echo ""
