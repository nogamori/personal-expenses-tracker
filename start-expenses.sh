#!/bin/sh
# Linux and macOS terminal: starts the server and opens the dashboard. Ctrl+C stops it.
cd "$(dirname "$0")" || exit 1
( sleep 1; (xdg-open http://127.0.0.1:8765 || open http://127.0.0.1:8765) >/dev/null 2>&1 ) &
exec python3 server.py
