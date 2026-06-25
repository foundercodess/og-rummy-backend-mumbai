# #!/bin/sh
# set -eu

# APP_DIR="${APP_DIR:-$PWD}"
# APP_NAME="${APP_NAME:-og-rummy-api}"
# IMAGE_NAME="${IMAGE_NAME:-og-rummy-backend:latest}"
# APP_PORT="${APP_PORT:-80}"
# CONTAINER_PORT="${CONTAINER_PORT:-3000}"
# HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://localhost/health}"
# HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-18}"
# HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-5}"

# required_vars="DATABASE_URL JWT_SECRET AWS_REGION AWS_S3_BUCKET AWS_S3_BASE_URL"
# for var_name in $required_vars; do
#   eval "var_value=\${$var_name:-}"
#   if [ -z "$var_value" ]; then
#     echo "Missing required env var: $var_name" >&2
#     exit 1
#   fi
# done

# cd "$APP_DIR"

# cat > .env <<EOF
# PORT=${PORT:-3000}
# NODE_ENV=${NODE_ENV:-production}
# KAFKA_BROKERS=${KAFKA_BROKERS:-localhost:9092}
# DATABASE_URL=${DATABASE_URL}
# JWT_SECRET=${JWT_SECRET}
# JWT_EXPIRES_IN=${JWT_EXPIRES_IN:-7d}
# AWS_REGION=${AWS_REGION}
# AWS_S3_BUCKET=${AWS_S3_BUCKET}
# AWS_S3_BASE_URL=${AWS_S3_BASE_URL}
# ${REDIS_URL:+REDIS_URL=${REDIS_URL}}
# EOF

# if [ -n "${REDIS_URL:-}" ]; then
#   echo "REDIS_URL configured for deploy"
# else
#   echo "WARN: REDIS_URL not set — health check will report redis not configured"
# fi

# docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
# docker build -t "$IMAGE_NAME" .
# docker run -d \
#   --name "$APP_NAME" \
#   --restart always \
#   -p "$APP_PORT:$CONTAINER_PORT" \
#   --env-file .env \
#   "$IMAGE_NAME"

# attempt=1
# while [ "$attempt" -le "$HEALTHCHECK_RETRIES" ]; do
#   if curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; then
#     echo "Health check passed on attempt $attempt"
#     exit 0
#   fi

#   echo "Health check attempt $attempt failed; waiting ${HEALTHCHECK_INTERVAL}s"
#   sleep "$HEALTHCHECK_INTERVAL"
#   attempt=$((attempt + 1))
# done

# echo "Health check failed after ${HEALTHCHECK_RETRIES} attempts" >&2
# docker ps -a --filter "name=$APP_NAME" >&2 || true
# docker logs --tail 200 "$APP_NAME" >&2 || true
# exit 1


#!/bin/sh
set -eu

APP_DIR="${APP_DIR:-$PWD}"
APP_NAME="${APP_NAME:-og-rummy-api}"
IMAGE_NAME="${IMAGE_NAME:-og-rummy-backend:latest}"
APP_PORT="${APP_PORT:-80}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"  # Not used with host networking, but kept for reference
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://localhost:80/health}"  # Use port 80 now
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-18}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-5}"

# Required variables (add any others you need)
required_vars="DATABASE_URL JWT_SECRET AWS_REGION AWS_S3_BUCKET AWS_S3_BASE_URL"
for var_name in $required_vars; do
  eval "var_value=\${$var_name:-}"
  if [ -z "$var_value" ]; then
    echo "Missing required env var: $var_name" >&2
    exit 1
  fi
done

cd "$APP_DIR"

# Generate complete .env with ALL variables
cat > .env <<EOF
PORT=${PORT:-80}   # Changed default to 80 for host networking
NODE_ENV=${NODE_ENV:-production}
KAFKA_BROKERS=${KAFKA_BROKERS:-localhost:9092}
DATABASE_URL=${DATABASE_URL}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=${JWT_EXPIRES_IN:-7d}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=${AWS_S3_BUCKET}
AWS_S3_BASE_URL=${AWS_S3_BASE_URL}
# ${REDIS_URL:+REDIS_URL=${REDIS_URL}}

# Bot configuration – all variables
POOL_SPLIT_ENABLED=${POOL_SPLIT_ENABLED:-true}
BOT_ENGINE_ENABLED=${BOT_ENGINE_ENABLED:-true}
BOT_INJECT_AFTER_SECONDS=${BOT_INJECT_AFTER_SECONDS:-7}
BOT_SCAN_EVERY_MS=${BOT_SCAN_EVERY_MS:-5000}
BOT_POOL_SIZE=${BOT_POOL_SIZE:-50}
BOT_AUTO_READY=${BOT_AUTO_READY:-true}
BOT_NAME_PREFIX=${BOT_NAME_PREFIX:-RummyBot-}
BOT_PHONE_PREFIX=${BOT_PHONE_PREFIX:-98999}
BOT_SESSION_LOCK_TTL_SECONDS=${BOT_SESSION_LOCK_TTL_SECONDS:-20}
BOT_ACTION_DELAY_MIN_MS=${BOT_ACTION_DELAY_MIN_MS:-3500}
BOT_ACTION_DELAY_MAX_MS=${BOT_ACTION_DELAY_MAX_MS:-9000}
BOT_ACTION_DELAY_MS=${BOT_ACTION_DELAY_MS:-0}
BOT_POST_PICK_DELAY_MIN_MS=${BOT_POST_PICK_DELAY_MIN_MS:-1800}
BOT_POST_PICK_DELAY_MAX_MS=${BOT_POST_PICK_DELAY_MAX_MS:-4500}
BOT_POST_PICK_DELAY_MS=${BOT_POST_PICK_DELAY_MS:-0}
BOT_DECLARE_RESPONSE_DELAY_MS=${BOT_DECLARE_RESPONSE_DELAY_MS:-1500}
BOT_AGGRESSION_ENABLED=${BOT_AGGRESSION_ENABLED:-true}
BOT_STRATEGIC_DROP_ENABLED=${BOT_STRATEGIC_DROP_ENABLED:-true}
BOT_DROP_BENEFIT_THRESHOLD=${BOT_DROP_BENEFIT_THRESHOLD:-16}
BOT_SPLIT_AUTO_RESPONSE_MIN_MS=${BOT_SPLIT_AUTO_RESPONSE_MIN_MS:-600}
BOT_SPLIT_AUTO_RESPONSE_MAX_MS=${BOT_SPLIT_AUTO_RESPONSE_MAX_MS:-1500}
BOT_SPLIT_MIN_GAIN_MULTIPLIER=${BOT_SPLIT_MIN_GAIN_MULTIPLIER:-0.6}
EOF

if [ -n "${REDIS_URL:-}" ]; then
  echo "REDIS_URL configured for deploy"
else
  echo "WARN: REDIS_URL not set — health check will report redis not configured"
fi

# Stop and remove old container
docker rm -f "$APP_NAME" >/dev/null 2>&1 || true

# Build the image
docker build -t "$IMAGE_NAME" .

# Run with host networking (--net=host) to access Redis and other VPC services
# No port mapping needed because host network shares the host's ports directly.
docker run -d \
  --name "$APP_NAME" \
  --restart always \
  --net=host \
  --env-file .env \
  "$IMAGE_NAME"

# Health check – now on port 80 (or whatever PORT is set to)
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