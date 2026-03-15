#!/bin/bash
# Migrate data from the host MongoDB service into the Docker mongo container.
# Run this BEFORE stopping the host mongod service and starting the Docker stack.
# Usage: bash migrate-mongo.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP_DIR="/tmp/mongo-migration-dump"

echo "=== Exporting data from host MongoDB ==="
mongodump --host 127.0.0.1 --port 27017 --out "$DUMP_DIR"

echo "=== Starting the Docker mongo container ==="
cd "$SCRIPT_DIR"
docker compose -f docker-compose.prod.yml up -d mongo

echo "Waiting for mongo container to be ready..."
sleep 5

echo "=== Importing data into Docker mongo container ==="
docker compose -f docker-compose.prod.yml exec -T mongo \
  mongorestore --host 127.0.0.1 --port 27017 /dump 2>/dev/null || \
docker run --rm \
  --network gcoms-devops_default \
  -v "$DUMP_DIR":/dump \
  mongo:7 mongorestore --host mongo --port 27017 /dump

echo "=== Migration complete! ==="
echo "Verify your data, then stop host mongod:"
echo "  sudo systemctl stop mongod && sudo systemctl disable mongod"

rm -rf "$DUMP_DIR"
