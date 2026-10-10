#!/bin/bash
# Double-click to start the microKORG XL Editor (needs Chrome or Edge for Web MIDI).
cd "$(dirname "$0")"
PORT=8765
URL="http://localhost:$PORT/"
# uv runs serve.py with the Python and packages listed at its top, installing them the first
# time. Without uv, the Mac's own python3 runs it, and Claude Code is the only AI provider.
UV=$(command -v uv || ls /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" 2>/dev/null | head -1)
if ! lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  if [ -n "$UV" ]; then
    echo "Starting (the first start downloads Python and the AI packages, which can take a minute)…"
    "$UV" run serve.py &
  else
    echo "uv isn't installed, so only Claude Code can be used for AI. To use the Anthropic API,"
    echo "OpenAI, Gemini or local models, install uv (https://docs.astral.sh/uv/ or: brew install uv)."
    python3 serve.py &
  fi
  SERVER=$!
  for _ in $(seq 1 240); do
    lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    kill -0 $SERVER 2>/dev/null || { echo "The editor's server stopped. See the messages above."; exit 1; }
    sleep 0.5
  done
fi
if open -Ra "Google Chrome" 2>/dev/null; then open -a "Google Chrome" "$URL"
elif open -Ra "Microsoft Edge" 2>/dev/null; then open -a "Microsoft Edge" "$URL"
else open "$URL"; echo "Open $URL in Chrome or Edge — Safari doesn't support Web MIDI."; fi
echo "Editor running at $URL — close this window to stop it."
[ -n "$SERVER" ] && wait $SERVER
