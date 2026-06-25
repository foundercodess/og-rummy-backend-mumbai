#!/bin/sh
set -eu

APP_DIR="${APP_DIR:-$PWD}"
APP_NAME="${APP_NAME:-og-rummy-api}"
IMAGE_NAME="${IMAGE_NAME:-og-rummy-backend:latest}"
APP_PORT="${APP_PORT:-80}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://localhost/health}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-18}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-5}"

required_vars="DATABASE_URL JWT_SECRET AWS_REGION AWS_S3_BUCKET AWS_S3_BASE_URL"
for var_name in $required_vars; do
  eval "var_value=\${$var_name:-}"
  if [ -z "$var_value" ]; then
    echo "Missing required env var: $var_name" >&2
    exit 1
  fi
done

cd "$APP_DIR"

cat > .env <<EOF
PORT=${PORT:-3000}
NODE_ENV=${NODE_ENV:-production}
KAFKA_BROKERS=${KAFKA_BROKERS:-localhost:9092}
DATABASE_URL=${DATABASE_URL}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=${JWT_EXPIRES_IN:-7d}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=${AWS_S3_BUCKET}
AWS_S3_BASE_URL=${AWS_S3_BASE_URL}
${REDIS_URL:+REDIS_URL=${REDIS_URL}}
EOF

docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
docker build -t "$IMAGE_NAME" .
docker run -d \
  --name "$APP_NAME" \
  --restart always \
  -p "$APP_PORT:$CONTAINER_PORT" \
  --env-file .env \
  "$IMAGE_NAME"

attempt=1
while [ "$attempt" -le "$HEALTHCHECK_RETRIES" ]; do
  if curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; then
    echo "Health check passed on attempt $attempt"
    exit 0
  fi

  echo "Health check attempt $attempt failed; waiting ${HEALTHCHECK_INTERVAL}s"
  sleep "$HEALTHCHECK_INTERVAL"
  attempt=$((attempt + 1))
done

echo "Health check failed after ${HEALTHCHECK_RETRIES} attempts" >&2
docker ps -a --filter "name=$APP_NAME" >&2 || true
docker logs --tail 200 "$APP_NAME" >&2 || true
exit 1