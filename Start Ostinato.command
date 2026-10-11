#!/bin/bash
# Double-click to start the Ostinato (needs Chrome or Edge for Web MIDI).
# Closing this window (or Ctrl-C) stops it. An older editor still running (left behind by a crash,
# or from before an update) is stopped first, so the page always talks to the current code.
cd "$(dirname "$0")"
PORT=${MKXL_PORT:-8765}
URL="http://localhost:$PORT/"

# Stops a process and the one it started (uv runs Python as a child).
stop_tree() {
  pkill -TERM -P "$1" 2>/dev/null
  kill -TERM "$1" 2>/dev/null
}

OLD=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$OLD" ]; then
  if ps -o command= -p "$OLD" | grep -q "serve.py"; then
    while pgrep -f "claude -p --output-format stream-json" >/dev/null; do
      echo "The editor that's already running is designing a sound with the AI; waiting for it to finish…"
      sleep 5
    done
    echo "Stopping the editor that was already running (it may be an older version)…"
    PARENT=$(ps -o ppid= -p "$OLD" | tr -d ' ')
    kill -TERM "$OLD" 2>/dev/null
    # Its uv parent, if it was started with uv (not launchd or a shell).
    if [ -n "$PARENT" ] && ps -o command= -p "$PARENT" | grep -q "uv run serve.py"; then kill -TERM "$PARENT" 2>/dev/null; fi
    for _ in $(seq 1 20); do lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
  else
    echo "Port $PORT is in use by another program ($(ps -o comm= -p "$OLD")), so the editor can't start."
    echo "Quit that program, or start the editor on another port: MKXL_PORT=8770 ./\"Start Ostinato.command\""
    exit 1
  fi
fi

# uv runs serve.py with the Python and packages listed at its top, installing them the first
# time. Without uv, the Mac's own python3 runs it, and Claude Code is the only AI provider.
UV=$(command -v uv || ls /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" 2>/dev/null | head -1)
if [ -n "$UV" ]; then
  echo "Starting (the first start downloads Python and the AI packages, which can take a minute)…"
  "$UV" run serve.py &
else
  echo "uv isn't installed, so only Claude Code can be used for AI. To use the Anthropic API,"
  echo "OpenAI, Gemini or local models, install uv (https://docs.astral.sh/uv/ or: brew install uv)."
  python3 serve.py &
fi
SERVER=$!
# Closing the window sends a hang-up: take the server down with it.
trap 'stop_tree $SERVER; exit' HUP INT TERM
trap 'stop_tree $SERVER' EXIT

for _ in $(seq 1 240); do
  lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
  kill -0 $SERVER 2>/dev/null || { echo "The editor's server stopped. See the messages above."; exit 1; }
  sleep 0.5
done
if [ -n "$MKXL_NO_BROWSER" ]; then :  # (for testing)
elif open -Ra "Google Chrome" 2>/dev/null; then open -a "Google Chrome" "$URL"
elif open -Ra "Microsoft Edge" 2>/dev/null; then open -a "Microsoft Edge" "$URL"
else open "$URL"; echo "Open $URL in Chrome or Edge — Safari doesn't support Web MIDI."; fi
echo "Editor running at $URL — close this window (or press Ctrl-C) to stop it."
wait $SERVER
