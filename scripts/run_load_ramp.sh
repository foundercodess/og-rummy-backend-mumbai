#!/usr/bin/env bash
# Stepwise gameplay ramp (creates users as needed, climbs, optional ramp-down).
#
# Default: 6P Points hold ladder toward 20k via full-cycle (OTP 1111 + fund).
#
# Usage:
#   ./scripts/run_load_ramp.sh
#   STEPS=100,200,500,1000 MAX_PLAYERS=6 ./scripts/run_load_ramp.sh
#   FROM=100 TO=20000 MULT=2 RAMP_DOWN=1 ./scripts/run_load_ramp.sh
#   USER_MODE=prepare-db ALLOW_REMOTE_DB=1 STEPS=100,200,500 ./scripts/run_load_ramp.sh
#   DRY_RUN=1 STEPS=100,200 ./scripts/run_load_ramp.sh
#
# See: node scripts/run_load_ramp.js --help

set -euo pipefail
cd "$(dirname "$0")/.."

URL="${LOAD_TEST_URL:-http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com}"
STEPS="${STEPS:-100,200,500,1000,2000,5000,10000,20000}"
FROM="${FROM:-}"
TO="${TO:-}"
MULT="${MULT:-2}"
MAX_PLAYERS="${MAX_PLAYERS:-6}"
GAME_ID="${GAME_ID:-3}"
CONTEST_ID="${CONTEST_ID:-}"
CONCURRENCY="${CONCURRENCY:-50}"
HOLD_SECONDS="${HOLD_SECONDS:-180}"
MAX_GAME_SECONDS="${MAX_GAME_SECONDS:-900}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-45}"
USER_MODE="${USER_MODE:-full-cycle}"
ON_FAIL="${ON_FAIL:-stop}"
REPORT_PREFIX="${REPORT_PREFIX:-ramp}"
FUND="${FUND:-10000}"
PHONE_PREFIX="${PHONE_PREFIX:-97000}"
START="${START:-1}"

if [[ -z "$CONTEST_ID" ]]; then
  if [[ "$MAX_PLAYERS" -ge 6 ]]; then
    CONTEST_ID=199
  else
    CONTEST_ID=198
  fi
fi

ARGS=(
  --url "$URL"
  --max-players "$MAX_PLAYERS"
  --game-id "$GAME_ID"
  --contest-id "$CONTEST_ID"
  --concurrency "$CONCURRENCY"
  --hold-seconds "$HOLD_SECONDS"
  --max-game-seconds "$MAX_GAME_SECONDS"
  --cooldown-seconds "$COOLDOWN_SECONDS"
  --user-mode "$USER_MODE"
  --on-fail "$ON_FAIL"
  --report-prefix "$REPORT_PREFIX"
  --fund "$FUND"
  --phone-prefix "$PHONE_PREFIX"
  --start "$START"
)

if [[ -n "$FROM" && -n "$TO" ]]; then
  ARGS+=(--from "$FROM" --to "$TO" --mult "$MULT")
else
  ARGS+=(--steps "$STEPS")
fi

if [[ "${RAMP_DOWN:-0}" == "1" ]]; then
  ARGS+=(--ramp-down)
fi
if [[ "${ALLOW_REMOTE_DB:-0}" == "1" ]]; then
  ARGS+=(--allow-remote-db)
fi
if [[ "${LOCAL_DOCKER:-0}" == "1" ]]; then
  ARGS+=(--local-docker)
fi
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  ARGS+=(--dry-run)
fi

echo "[RAMP_SH] node scripts/run_load_ramp.js ${ARGS[*]}"
exec node scripts/run_load_ramp.js "${ARGS[@]}"
