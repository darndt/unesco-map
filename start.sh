#!/usr/bin/env bash
# Start the World Heritage Map server. Usage: ./start.sh [port]  (or PORT=8080 ./start.sh)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-${PORT:-9393}}"

bundle check >/dev/null 2>&1 || bundle install

echo "World Heritage Map → http://localhost:${PORT}"
exec bundle exec rackup -p "$PORT"
