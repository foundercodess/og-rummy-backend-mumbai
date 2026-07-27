#!/bin/sh
set -eu

# Phase-1 node preflight.
# Prefer running on the EC2 HOST (has curl):
#   HEALTH_URL=http://127.0.0.1/health ./scripts/phase1_preflight.sh
# Or inside the API container (uses node fetch; no curl needed):
#   sudo docker exec -it og-rummy-api sh -c 'HEALTH_URL=http://127.0.0.1:3000/health ./scripts/phase1_preflight.sh'

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
  echo "[phase1] Tip: on EC2 host, source container env without dumping secrets:"
  echo "  sudo docker exec -it og-rummy-api sh -c 'HEALTH_URL=http://127.0.0.1:3000/health ./scripts/phase1_preflight.sh'"
  exit 1
fi

APP_PORT="${APP_PORT:-80}"
# Inside container the app listens on PORT (default 3000). On host, mapped port is often 80.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/health}"

fetch_health() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url" 2>/dev/null || true
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" 2>/dev/null || true
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e "
      const url = process.argv[1];
      fetch(url)
        .then((r) => r.text())
        .then((t) => process.stdout.write(t))
        .catch(() => process.exit(2));
    " "$url" 2>/dev/null || true
    return 0
  fi
  echo "[phase1][ERR] Need curl, wget, or node to call /health"
  exit 1
}

echo "[phase1] Checking health endpoint: $HEALTH_URL"
health_json="$(fetch_health "$HEALTH_URL")"
if [ -z "$health_json" ]; then
  echo "[phase1][ERR] Health check failed at $HEALTH_URL"
  exit 1
fi

echo "[phase1][OK] /health responded"

# Health payload uses redis: "connected" | "error" | "not configured"
case "$health_json" in
  *'"redis":"connected"'*|*'\"redis\":\"connected\"'*|*'redis": "connected"'*)
    echo "[phase1][OK] Redis appears connected"
    ;;
  *)
    echo "[phase1][WARN] Redis not confirmed connected in /health"
    ;;
esac

case "$health_json" in
  *'"sweeper_enabled":true'*|*'\"sweeper_enabled\":true'*|*'sweeper_enabled": true'*)
    echo "[phase1][OK] Durable timer sweeper enabled"
    ;;
  *)
    echo "[phase1][WARN] Durable timer sweeper not confirmed as enabled"
    ;;
esac

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
