#!/bin/zsh
# Starts a separate Chrome for the ywa_ai pipeline (Flow, YouTube Studio) with a fixed debugging port.
# Unlike the chrome://inspect toggle, this needs no "allow" prompt and survives restarts: just run it again.
# Its own profile keeps your everyday Chrome untouched; sign in to your Google accounts in it once.
# Traffic goes through the local xray SOCKS port, so Google (Flow, YouTube) is reachable like on your VPN.
set -euo pipefail

PORT="${YWA_CHROME_PORT:-9223}"
PROFILE="${YWA_CHROME_PROFILE:-$HOME/Library/Application Support/ywa-automation-chrome}"
PROXY="${YWA_CHROME_PROXY:-socks5://127.0.0.1:7891}"

if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  echo "automation Chrome already running on port $PORT"
  exit 0
fi

mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --proxy-server="$PROXY" \
  --no-first-run \
  --no-default-browser-check \
  "${1:-https://flow.google.com/}"

for _ in {1..30}; do
  if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null; then
    echo "automation Chrome is up on port $PORT (profile: $PROFILE)"
    exit 0
  fi
  sleep 1
done
echo "automation Chrome did not open its debugging port $PORT" >&2
exit 1
