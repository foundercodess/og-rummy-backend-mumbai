#!/usr/bin/env bash
# 50k CCU soak — stakeholder capacity report.
#
# Default: ~50,004 seats (8334 tables × 6P), 1 pick+discard per table, hold 300s.
# Writes executive JSON + markdown under load_reports/.
#
# Run from a dedicated load machine (not game API EC2):
#   ./scripts/run_ccu_soak_50k.sh
#   TARGET_CCU=50000 HOLD_SECONDS=300 CONCURRENCY=50 ./scripts/run_ccu_soak_50k.sh
#   TABLES=100 TARGET_CCU=600 ./scripts/run_ccu_soak_50k.sh   # small smoke
#
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${LOAD_TEST_URL:-http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com}"
TARGET_CCU="${TARGET_CCU:-50000}"
MAX_PLAYERS="${MAX_PLAYERS:-6}"
# Optional override; otherwise tables = ceil(TARGET_CCU / MAX_PLAYERS)
TABLES="${TABLES:-}"
CONCURRENCY="${CONCURRENCY:-50}"
HOLD_SECONDS="${HOLD_SECONDS:-300}"
ACTIONS_PER_TABLE="${ACTIONS_PER_TABLE:-1}"
GAME_ID="${GAME_ID:-3}"
CONTEST_ID="${CONTEST_ID:-}"
START="${START:-1}"
PHONE_PREFIX="${PHONE_PREFIX:-97000}"
REPORT_PREFIX="${REPORT_PREFIX:-ccu_soak_50k}"
SUCCESS_RATIO="${SUCCESS_RATIO:-0.95}"
HOLD_RETENTION_RATIO="${HOLD_RETENTION_RATIO:-0.90}"
# Server fundLoadTestWallet only allows phones under LOAD_TEST_PHONE_PREFIX (default 97000).
# Use PHONE_PREFIX=97000 unless your API .env overrides that prefix.

if [[ -z "$CONTEST_ID" ]]; then
  if [[ "$MAX_PLAYERS" -ge 6 ]]; then
    CONTEST_ID=199
  else
    CONTEST_ID=198
  fi
fi

ARGS=(
  --url "$URL"
  --target-ccu "$TARGET_CCU"
  --max-players "$MAX_PLAYERS"
  --concurrency "$CONCURRENCY"
  --hold-seconds "$HOLD_SECONDS"
  --actions-per-table "$ACTIONS_PER_TABLE"
  --game-id "$GAME_ID"
  --contest-id "$CONTEST_ID"
  --start "$START"
  --phone-prefix "$PHONE_PREFIX"
  --report-prefix "$REPORT_PREFIX"
  --success-ratio "$SUCCESS_RATIO"
  --hold-retention-ratio "$HOLD_RETENTION_RATIO"
  --fund 10000
)

if [[ -n "$TABLES" ]]; then
  ARGS+=(--tables "$TABLES")
fi

echo "[CCU_SOAK_SH] node scripts/load_test_ccu_soak.js ${ARGS[*]}"
exec node scripts/load_test_ccu_soak.js "${ARGS[@]}"
