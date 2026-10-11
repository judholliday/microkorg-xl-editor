#!/bin/bash
# Double-click to stop the Ostinato, e.g. if its Terminal window was closed but the
# page still answers. (Closing the Start Ostinato window normally stops it.)
PORT=${MKXL_PORT:-8765}
PID=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1)
if [ -z "$PID" ]; then echo "The editor isn't running."; exit 0; fi
if ! ps -o command= -p "$PID" | grep -q "serve.py"; then echo "Port $PORT is used by another program, not the editor."; exit 1; fi
if pgrep -f "claude -p --output-format stream-json" >/dev/null; then
  read -r -p "The AI is designing a sound right now. Stop anyway? [y/N] " a
  [[ "$a" =~ ^[Yy] ]] || exit 0
fi
PARENT=$(ps -o ppid= -p "$PID" | tr -d ' ')
kill -TERM "$PID"
if [ -n "$PARENT" ] && ps -o command= -p "$PARENT" | grep -q "uv run serve.py"; then kill -TERM "$PARENT" 2>/dev/null; fi
echo "Stopped the editor."
