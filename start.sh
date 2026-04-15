#!/bin/bash
# Start the CDISC Knowledge Graph (API + UI)
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Kill any existing processes on the ports
fuser -k 8000/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true

echo "Starting CDISC Knowledge Graph API on http://localhost:8000..."
cd "$ROOT"
source .venv/bin/activate
uvicorn api.server:app --host 0.0.0.0 --port 8000 &
API_PID=$!

echo "Starting UI dev server on http://localhost:5173..."
cd "$ROOT/ui"
npm run dev &
UI_PID=$!

echo ""
echo "==================================================="
echo "  CDISC Knowledge Graph Explorer"
echo "  UI:  http://localhost:5173"
echo "  API: http://localhost:8000"
echo "  API docs: http://localhost:8000/docs"
echo "==================================================="
echo ""
echo "Press Ctrl+C to stop."

trap "kill $API_PID $UI_PID 2>/dev/null; exit 0" INT TERM
wait
