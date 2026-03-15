#!/bin/bash
# Pull latest changes for all repos and restart production containers.
# Usage: bash deploy.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"

echo "=== Pulling gcoms-devops ==="
git -C "$SCRIPT_DIR" pull

echo "=== Pulling gcoms-public-backend ==="
git -C "$WORKSPACE/gcoms-public-backend" pull

echo "=== Pulling gcoms-public-bot ==="
git -C "$WORKSPACE/gcoms-public-bot" pull

echo "=== Building and restarting containers ==="
cd "$SCRIPT_DIR"
docker compose -f docker-compose.prod.yml up --build -d

echo ""
echo "=== Done! Running containers: ==="
docker compose -f docker-compose.prod.yml ps
