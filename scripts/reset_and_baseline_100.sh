#!/usr/bin/env bash
# Hard-reset both EC2 API nodes, wait for health, then re-baseline 100 tables.
# Run from your Mac (not inside Docker):
#   cd og_rummy_backend && bash scripts/reset_and_baseline_100.sh
set -euo pipefail

PEM="${PEM:-$HOME/.ssh/og-rummy-mumbai.pem}"
HOSTS=("${EC2_HOST_1:-13.233.105.184}" "${EC2_HOST_2:-15.206.67.107}")
ALB_URL="${ALB_URL:-http://og-rummy-alb-791534744.ap-south-1.elb.amazonaws.com}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$PEM" ]]; then
  echo "Missing SSH key: $PEM" >&2
  exit 1
fi

echo "==> Restarting og-rummy-api on both EC2 nodes"
for H in "${HOSTS[@]}"; do
  echo "===== $H ====="
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$PEM" "ec2-user@$H" '
    set -e
    echo "before:"; sudo docker ps --filter name=og-rummy-api --format "{{.Names}} {{.Status}}"
    sudo docker restart og-rummy-api
    for i in $(seq 1 20); do
      if curl -fsS http://127.0.0.1/health >/dev/null 2>&1 \
        || curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
        echo "healthy after ${i} attempts"
        curl -fsS http://127.0.0.1/health 2>/dev/null || curl -fsS http://127.0.0.1:3000/health
        echo
        exit 0
      fi
      sleep 2
    done
    echo "HEALTH_FAIL after restart" >&2
    sudo docker logs --tail 80 og-rummy-api >&2 || true
    exit 1
  '
  echo
done

echo "==> Waiting 20s for ALB targets to settle"
sleep 20

echo "==> ALB health"
curl -fsS -m 15 "$ALB_URL/health" || {
  echo "ALB health check failed (continuing anyway if nodes are up)" >&2
}
echo
echo

echo "==> Starting clean 100-table baseline (proven params from Aug 19 clean run)"
cd "$APP_DIR"
node scripts/run_load_cycle.js \
  --url "$ALB_URL" \
  --tables 100 --max-players 6 --game-id 3 --contest-id 199 \
  --concurrency 50 \
  --target-active-tables 100 --hold-seconds 180 \
  --max-game-seconds 600 \
  --report-dir ./load_reports --report-prefix hold_100_rebaseline

echo "==> Done. Check summary under load_reports/hold_100_rebaseline_*_summary.json"
