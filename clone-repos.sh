#!/bin/bash

# Make sure repos directory exists
mkdir -p repos

# Array of your repo git URLs
REPOS=(
  "git@github.com:bekmenxd/gcoms-public-backend.git"
  "git@github.com:bekmenxd/gcoms-public-bot.git"
  "git@github.com:JakobWisborg/Gamercoms-web.git"
)

# Clone each repo if it doesn't exist yet
for REPO_URL in "${REPOS[@]}"
do
  # Extract repo name from URL
  REPO_NAME=$(basename -s .git "$REPO_URL")

  if [ -d "repos/$REPO_NAME" ]; then
    echo "$REPO_NAME already cloned, pulling latest changes..."
    git -C "repos/$REPO_NAME" pull
  else
    echo "Cloning $REPO_NAME..."
    git clone "$REPO_URL" "repos/$REPO_NAME"
  fi
done
