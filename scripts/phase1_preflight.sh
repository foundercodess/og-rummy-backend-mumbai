#!/bin/sh
set -eu

echo "[phase1] OG Rummy preflight starting..."

required_vars="DATABASE_URL JWT_SECRET REDIS_URL"
missing=0
for name in $required_vars; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "[phase1][ERR] Missing env var: $name"
    missing=1
  else
    echo "[phase1][OK] $name is set"
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "[phase1] Missing required env vars. Abort."
  exit 1
fi

APP_PORT="${APP_PORT:-80}"
HEALTH_URL="${HEALTH_URL:-http://localhost/health}"

if ! command -v curl >/dev/null 2>&1; then
  echo "[phase1][ERR] curl not found"
  exit 1
fi

echo "[phase1] Checking health endpoint: $HEALTH_URL"
health_json="$(curl -fsS "$HEALTH_URL" || true)"
if [ -z "$health_json" ]; then
  echo "[phase1][ERR] Health check failed at $HEALTH_URL"
  exit 1
fi

echo "[phase1][OK] /health responded"

echo "$health_json" | rg -q '"redis"\s*:\s*true' \
  && echo "[phase1][OK] Redis appears connected" \
  || echo "[phase1][WARN] Redis connected flag not found/false in /health"

echo "$health_json" | rg -q '"sweeper_enabled"\s*:\s*true' \
  && echo "[phase1][OK] Durable timer sweeper enabled" \
  || echo "[phase1][WARN] Durable timer sweeper not confirmed as enabled"

echo "[phase1] Runtime env summary:"
echo "  APP_PORT=${APP_PORT}"
echo "  CLUSTER_INSTANCES=${CLUSTER_INSTANCES:-1}"
echo "  DB_POOL_MAX=${DB_POOL_MAX:-<unset>}"
echo "  SOCKET_TRANSPORTS=${SOCKET_TRANSPORTS:-<unset>}"
echo "  DURABLE_TIMER_SWEEPER_ENABLED=${DURABLE_TIMER_SWEEPER_ENABLED:-<unset>}"
echo "  PROCESS_LEADER_ENABLED=${PROCESS_LEADER_ENABLED:-<unset>}"

if [ "${SOCKET_TRANSPORTS:-}" != "websocket" ]; then
  echo "[phase1][WARN] SOCKET_TRANSPORTS is not 'websocket' (recommended for ALB scale)"
fi

if [ "${CLUSTER_INSTANCES:-1}" -lt 2 ]; then
  echo "[phase1][WARN] CLUSTER_INSTANCES < 2. Horizontal node scale works, but per-node concurrency may be limited."
fi

echo "[phase1] Preflight complete."
