#!/bin/sh
set -e
# Run migrations if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "Running migrations..."
  node scripts/migrate.js
fi

INSTANCES="${CLUSTER_INSTANCES:-1}"
# Non-numeric / empty → single process
case "$INSTANCES" in
  ''|*[!0-9]*) INSTANCES=1 ;;
esac

if [ "$INSTANCES" -gt 1 ]; then
  echo "Starting PM2 cluster — CLUSTER_INSTANCES=$INSTANCES (durable sweeper expected ON)"
  export CLUSTER_INSTANCES
  # pm2-runtime keeps the container in the foreground and forwards logs.
  exec npx pm2-runtime start ecosystem.config.cjs
fi

echo "Starting single Node process..."
exec node server.js
