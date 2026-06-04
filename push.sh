#!/bin/bash
# Deploy one or more services to the production server.
#
# Usage:
#   bash push.sh frontend
#   bash push.sh backend
#   bash push.sh bot
#   bash push.sh frontend backend   # multiple at once
#
set -e

SERVER=172.232.129.62
REMOTE_DIR=/home/linus/gcoms
COMPOSE="docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml"
# Derive ROOT from script location (parent of gcoms-devops/) so it works on any machine
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Use Git Bash's tar explicitly — Windows has its own tar.exe that doesn't understand /c/ paths
TAR=/usr/bin/tar

if [ $# -eq 0 ]; then
  echo "Usage: bash push.sh <service> [service2 ...]"
  echo "Services: frontend, backend, bot, devops"
  exit 1
fi

# Wipe a remote directory and re-extract a tar, preserving the .env file.
# Usage: fresh_extract <tar_path> <remote_dir_name>
fresh_extract() {
  local tar_path="$1"
  local dir_name="$2"
  ssh $SERVER "
    set -e
    TARGET=$REMOTE_DIR/$dir_name
    ENV_TMP=\$(mktemp)
    [ -f \"\$TARGET/.env\" ] && cp \"\$TARGET/.env\" \"\$ENV_TMP\"
    rm -rf \"\$TARGET\"
    tar -xzf $tar_path -C $REMOTE_DIR/
    [ -s \"\$ENV_TMP\" ] && mv \"\$ENV_TMP\" \"\$TARGET/.env\" || rm -f \"\$ENV_TMP\"
  "
}

SERVICES_TO_BUILD=()

for SERVICE in "$@"; do
  case "$SERVICE" in
    frontend)
      echo "==> Packing frontend..."
      $TAR --exclude='*/node_modules' --exclude='*/.env' --exclude='*/.next' \
          -czf /tmp/gcoms-frontend.tar.gz -C "$ROOT" Gamercoms-web/
      scp /tmp/gcoms-frontend.tar.gz $SERVER:/tmp/
      fresh_extract /tmp/gcoms-frontend.tar.gz Gamercoms-web
      SERVICES_TO_BUILD+=("frontend")
      ;;
    backend)
      echo "==> Packing backend..."
      $TAR --exclude='*/node_modules' --exclude='*/.env' \
          -czf /tmp/gcoms-backend.tar.gz -C "$ROOT" gcoms-public-backend/
      scp /tmp/gcoms-backend.tar.gz $SERVER:/tmp/
      fresh_extract /tmp/gcoms-backend.tar.gz gcoms-public-backend
      SERVICES_TO_BUILD+=("backend")
      ;;
    bot)
      echo "==> Packing bot..."
      $TAR --exclude='*/node_modules' --exclude='*/.env' \
          -czf /tmp/gcoms-bot.tar.gz -C "$ROOT" gcoms-public-bot/
      scp /tmp/gcoms-bot.tar.gz $SERVER:/tmp/
      fresh_extract /tmp/gcoms-bot.tar.gz gcoms-public-bot
      SERVICES_TO_BUILD+=("bot")
      ;;
    devops)
      echo "==> Packing devops..."
      $TAR --exclude='*/node_modules' --exclude='*/.env' \
          -czf /tmp/gcoms-devops.tar.gz -C "$ROOT" gcoms-devops/
      scp /tmp/gcoms-devops.tar.gz $SERVER:/tmp/
      fresh_extract /tmp/gcoms-devops.tar.gz gcoms-devops
      # No rebuild needed for devops-only changes
      ;;
    *)
      echo "Unknown service: $SERVICE"
      exit 1
      ;;
  esac
done

if [ ${#SERVICES_TO_BUILD[@]} -gt 0 ]; then
  echo "==> Rebuilding and restarting: ${SERVICES_TO_BUILD[*]}"
  ssh $SERVER "cd ~/gcoms/gcoms-devops && $COMPOSE up --build -d ${SERVICES_TO_BUILD[*]}"
fi

echo "==> Done!"
ssh $SERVER "$COMPOSE ps"
