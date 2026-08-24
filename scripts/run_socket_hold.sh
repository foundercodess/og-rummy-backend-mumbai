#!/usr/bin/env bash
# Simple socket CCU hold: login → connect → hold (no tables).
#
# Smoke:
#   TARGET=300 HOLD_SECONDS=60 ./scripts/run_socket_hold.sh
#
# 50k (dedicated load machine):
#   TARGET=50000 HOLD_SECONDS=300 CONCURRENCY=100 ./scripts/run_socket_hold.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${LOAD_TEST_URL:-http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com}"
TARGET="${TARGET:-50000}"
HOLD_SECONDS="${HOLD_SECONDS:-300}"
CONCURRENCY="${CONCURRENCY:-100}"
RAMP_SECONDS="${RAMP_SECONDS:-120}"
PHONE_PREFIX="${PHONE_PREFIX:-97000}"
START="${START:-1}"

ARGS=(
  --url "$URL"
  --target "$TARGET"
  --hold-seconds "$HOLD_SECONDS"
  --concurrency "$CONCURRENCY"
  --ramp-seconds "$RAMP_SECONDS"
  --phone-prefix "$PHONE_PREFIX"
  --start "$START"
)

echo "[SOCKET_HOLD_SH] node scripts/load_test_socket_hold.js ${ARGS[*]}"
exec node scripts/load_test_socket_hold.js "${ARGS[@]}"
