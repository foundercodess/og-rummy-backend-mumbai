#!/usr/bin/env bash
# Parallel 6-player Points load test (does not touch the 2P token file).
#
# Prerequisites:
#   1. Script support: load_test_gameplay.js accepts --max-players 6
#   2. Separate users (do NOT reuse load_tokens.jsonl while 2P is live — session clash):
#        # Run on EC2 (RDS is private) or via SSH tunnel:
#        node scripts/load_test_prepare_users.js \
#          --allow-remote-db \
#          --start 1001 \
#          --count 360 \
#          --fund 10000 \
#          --out load_tokens_6p.jsonl
#
# Contest 199 = Points 6P twin of contest 198 (entry 4 / point 0.05).
#
# Usage:
#   ./scripts/run_load_6p.sh
#   TABLES=80 CONCURRENCY=25 HOLD_SECONDS=6 ./scripts/run_load_6p.sh

set -euo pipefail
cd "$(dirname "$0")/.."

URL="${LOAD_TEST_URL:-http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com}"
TOKENS="${TOKENS:-load_tokens_6p.jsonl}"
TABLES="${TABLES:-50}"
CONCURRENCY="${CONCURRENCY:-20}"
HOLD_SECONDS="${HOLD_SECONDS:-6}"
MAX_GAME_SECONDS="${MAX_GAME_SECONDS:-300}"
GAME_ID="${GAME_ID:-3}"
CONTEST_ID="${CONTEST_ID:-199}"
PREFIX="${REPORT_PREFIX:-load_pts_6p_${TABLES}}"

NEED=$((TABLES * 6))
if [[ ! -f "$TOKENS" ]]; then
  echo "Missing $TOKENS — prepare users first (see script header)."
  exit 1
fi
HAVE=$(grep -c . "$TOKENS" || true)
if [[ "$HAVE" -lt "$NEED" ]]; then
  echo "Need $NEED tokens for $TABLES x 6P tables, found $HAVE in $TOKENS"
  exit 1
fi

echo "[6P] url=$URL contest=$CONTEST_ID tables=$TABLES seats=$((TABLES*6)) concurrency=$CONCURRENCY hold=${HOLD_SECONDS}s"
exec node scripts/load_test_gameplay.js \
  --url "$URL" \
  --tokens "$TOKENS" \
  --game-id "$GAME_ID" \
  --contest-id "$CONTEST_ID" \
  --tables "$TABLES" \
  --target-active-tables "$TABLES" \
  --max-players 6 \
  --concurrency "$CONCURRENCY" \
  --hold-seconds "$HOLD_SECONDS" \
  --max-game-seconds "$MAX_GAME_SECONDS" \
  --report-dir ./load_reports \
  --report-prefix "$PREFIX"
