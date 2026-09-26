#!/usr/bin/env bash
# Serves the game folder locally and prints the URL to open.
set -e
PORT=5173
echo "Starting Voxelands local server..."
echo "Open http://localhost:${PORT} in your browser once the server starts."
npx --yes serve . -l ${PORT}
