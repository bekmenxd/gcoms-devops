#!/bin/bash
# Run this once on a fresh server to set up the environment.
# Usage: bash server-setup.sh
set -e

WORKSPACE="$HOME/gcoms"

echo "=== Installing Docker ==="
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
echo "Docker installed. NOTE: log out and back in for group changes to take effect, then re-run deploy.sh"

echo "=== Creating workspace at $WORKSPACE ==="
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo "=== Cloning repositories ==="
REPOS=(
  "git@github.com:bekmenxd/gcoms-public-backend.git"
  "git@github.com:bekmenxd/gcoms-public-bot.git"
  "git@github.com:bekmenxd/gcoms-devops.git"
)

for REPO_URL in "${REPOS[@]}"; do
  REPO_NAME=$(basename -s .git "$REPO_URL")
  if [ -d "$REPO_NAME" ]; then
    echo "$REPO_NAME already exists, pulling..."
    git -C "$REPO_NAME" pull
  else
    echo "Cloning $REPO_NAME..."
    git clone "$REPO_URL" "$REPO_NAME"
  fi
done

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Copy your .env files:"
echo "     scp gcoms-public-backend/.env user@server:$WORKSPACE/gcoms-public-backend/.env"
echo "     scp gcoms-public-bot/.env     user@server:$WORKSPACE/gcoms-public-bot/.env"
echo "  2. Migrate MongoDB data: bash $WORKSPACE/gcoms-devops/migrate-mongo.sh"
echo "  3. Stop PM2 and host mongod:"
echo "     pm2 delete all && sudo systemctl stop mongod && sudo systemctl disable mongod"
echo "  4. Start containers: bash $WORKSPACE/gcoms-devops/deploy.sh"
