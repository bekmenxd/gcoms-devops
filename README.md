# gcoms-devops

Infrastructure and deployment configuration for the Gamercoms stack.

## Manual deploy

Frontend
Open git bash, run this
/usr/bin/tar --exclude='*/node_modules' --exclude='.env' --exclude='*/.next' -czf /c/Users/linus/AppData/Local/Temp/gcoms-frontend.tar.gz -C /c/Users/linus/dev Gamercoms-web/

Then in PowerShell:

scp $env:TEMP\gcoms-frontend.tar.gz linus@172.232.129.62:/tmp/

ssh linus@172.232.129.62 "tar -xzf /tmp/gcoms-frontend.tar.gz -C /home/linus/gcoms/"

ssh linus@172.232.129.62 "cd ~/gcoms/gcoms-devops && docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml up --build -d frontend"

Backend — Git Bash:
/usr/bin/tar --exclude='*/node_modules' --exclude='.env' -czf /c/Users/linus/AppData/Local/Temp/gcoms-backend.tar.gz -C /c/Users/linus/dev gcoms-public-backend/
Backend — PowerShell:
scp $env:TEMP\gcoms-backend.tar.gz linus@172.232.129.62:/tmp/
ssh linus@172.232.129.62 "tar -xzf /tmp/gcoms-backend.tar.gz -C /home/linus/gcoms/"
ssh linus@172.232.129.62 "cd ~/gcoms/gcoms-devops && docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml up --build -d backend"

---

Bot — Git Bash:
/usr/bin/tar --exclude='*/node_modules' --exclude='.env' -czf /c/Users/linus/AppData/Local/Temp/gcoms-bot.tar.gz -C /c/Users/linus/dev gcoms-public-bot/
Bot — PowerShell:
scp $env:TEMP\gcoms-bot.tar.gz linus@172.232.129.62:/tmp/
ssh linus@172.232.129.62 "tar -xzf /tmp/gcoms-bot.tar.gz -C /home/linus/gcoms/"
ssh linus@172.232.129.62 "cd ~/gcoms/gcoms-devops && docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml up --build -d bot"

Devops — Git Bash:
/usr/bin/tar --exclude='*/node_modules' --exclude='.env' -czf /c/Users/linus/AppData/Local/Temp/gcoms-devops.tar.gz -C /c/Users/linus/dev gcoms-devops/
Devops — PowerShell:
scp $env:TEMP\gcoms-devops.tar.gz linus@172.232.129.62:/tmp/
ssh linus@172.232.129.62 "tar -xzf /tmp/gcoms-devops.tar.gz -C /home/linus/gcoms/"
(No rebuild needed for devops-only changes, same as the script.)

## Architecture

```
Internet
   │
   ├── gamercoms.com (HTTPS)  →  Nginx  →  frontend container :3000
   └── api.gamercoms.com (HTTPS)  →  Nginx  →  backend container :3001

Docker internal network:
  frontend  →  backend:3001   (Next.js rewrites, no SSL needed)
  backend   →  bot:3000       (internal API calls)
  backend   →  mongo:27017
  bot       →  mongo:27017
```

- **frontend** — Next.js app, port 3000
- **backend** — Fastify API, port 3001 (exposed externally via api.gamercoms.com)
- **bot** — Discord bot + internal Fastify API, no external ports
- **mongo** — MongoDB 7, no external ports, data persisted in `mongo-data` Docker volume

Host Nginx handles SSL termination (Let's Encrypt via certbot). Containers communicate over Docker's internal network by service name.

## Server

- **IP:** `172.232.129.62`
- **SSH:** `ssh 172.232.129.62`
- **Working directory:** `~/gcoms/`

## Deploying

Run `push.sh` from `C:/Users/linus/dev/gcoms-devops/`. It tars the local source (excluding `node_modules` and `.env`), scps it to the server, and rebuilds the relevant Docker container.

```bash
# Deploy a single service
bash push.sh frontend
bash push.sh backend
bash push.sh bot

# Deploy multiple services at once
bash push.sh frontend backend

# Push devops config changes only (no container rebuild)
bash push.sh devops
```

`devops` only syncs this repo to the server — no container is rebuilt since docker-compose config changes alone don't require it (use `docker compose up -d` on the server if needed).

## Environment Files

`.env` files are **never committed** and **never transferred by push.sh**. They live only on the server and must be managed manually.

| Service | Path on server                      |
| ------- | ----------------------------------- |
| backend | `~/gcoms/gcoms-public-backend/.env` |
| bot     | `~/gcoms/gcoms-public-bot/.env`     |

### Backend `.env` variables

```env
DISCORD_CLIENT_ID=        # Discord OAuth app client ID (must match frontend)
DISCORD_CLIENT_SECRET=    # Discord OAuth app client secret
MONGODB_URI=mongodb://mongo:27017/gamercoms
JWT_SECRET=
JWT_REFRESH_SECRET=
NODE_ENV=production
BOT_API_URL=http://bot:3000
FRONTEND_URL=https://gamercoms.com
```

### Bot `.env` variables

```env
DISCORD_API_TOKEN=        # Bot token from Discord Developer Portal
MONGODB_URI=mongodb://mongo:27017/gamercoms
NODE_ENV=production
PORT=3000
```

To edit an env file on the server:

```bash
ssh 172.232.129.62
nano ~/gcoms/gcoms-public-backend/.env
```

After editing, recreate the container to pick up the changes (a plain `restart` does **not** reload env files):

```bash
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml up -d backend
```

## Useful Server Commands

```bash
# View running containers
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml ps

# View logs
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml logs backend --tail=50
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml logs bot --tail=50
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml logs frontend --tail=50

# Restart a container
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml restart backend

# Recreate a container (required after .env changes)
docker compose -f ~/gcoms/gcoms-devops/docker-compose.prod.yml up -d backend
```

## SSL Certificates

Managed by certbot on the host. To renew or add a new domain:

```bash
sudo certbot --nginx -d gamercoms.com -d www.gamercoms.com
sudo certbot --nginx -d api.gamercoms.com
```

Nginx configs: `/etc/nginx/sites-available/`

## Discord Developer Portal

App ID: `1257298573436125185`

Required settings:

- **OAuth2 → Redirects:** `https://gamercoms.com/auth/discord/callback`
- **Bot → Privileged Intents:** Enable **Server Members Intent** and **Presence Intent** if used by the bot

### Deploy slash commands

```bash
# SSH into server and exec into the bot container
ssh 172.232.129.62
docker exec -it gcoms-devops-bot-1 sh

# Deploy globally
node src/utils/deploy-commands.js --global

# Deploy to a specific guild
node src/utils/deploy-commands.js --guild 1257300094680567808
```
