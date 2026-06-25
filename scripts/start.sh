#!/bin/sh
set -e
# Run migrations if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "Running migrations..."
  node scripts/migrate.js
fi
echo "Starting server..."
exec node server.js
