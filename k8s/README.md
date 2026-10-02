# Kubernetes manifests (draft)

First-draft manifests for moving Gamercoms off the single-VPS Docker Compose
setup (`../docker-compose.prod.yml`) onto Kubernetes -- specifically Akamai
Cloud's Linode Kubernetes Engine (LKE), written alongside the
`kubernetes-migration` branches in `Gamercoms-web`, `gcoms-public-backend`,
and `gcoms-public-bot` that fixed the code-level issues a k8s move would
otherwise have exposed (in-memory state that doesn't survive multiple
replicas, missing health endpoints, ungraceful shutdown, etc).

MongoDB is **self-hosted inside this cluster** as a 3-node replica set, not a
managed database. Akamai's own Managed Database service was checked and
ruled out -- it only supports MySQL and PostgreSQL, not MongoDB -- so
self-hosting via the MongoDBCommunity operator is the only "stay on Akamai"
option. See `13-mongo.yaml` for the full reasoning.

## What's here

| File | What it is |
|---|---|
| `00-namespace.yaml` | The `gamercoms` namespace everything else lives in |
| `01-configmap.yaml` | Non-secret config, shared across services |
| `02-secret.example.yaml` | **Template only.** Copy to `02-secret.yaml` (git-ignored) and fill in real values, or use a real secrets manager instead |
| `10-frontend.yaml` | Deployment + Service + HPA (2-6 replicas), non-root, `imagePullSecrets` |
| `11-backend.yaml` | Deployment + Service + HPA (2-6 replicas), non-root, `imagePullSecrets` |
| `12-bot.yaml` | Gateway half. Deployment + Service -- **pinned to 1 replica, no HPA, ever** -- non-root, `imagePullSecrets` |
| `12b-bot-api.yaml` | Scalable half. Deployment + Service + HPA (2-6 replicas). Same image as `12-bot.yaml`; differs only in the `command` selecting the api-only entrypoint |
| `13-mongo.yaml` | `MongoDBCommunity` custom resource -- 3-member self-hosted replica set |
| `14-mongo-backup-cronjob.yaml` | Nightly `mongodump` -> Linode Object Storage (S3-compatible) |
| `15-networkpolicies.yaml` | Ingress-only NetworkPolicies -- only backend/bot/the backup job can reach Mongo, etc. |
| `20-ingress.yaml` | Routes `staging.gamercoms.com` / `api.staging.gamercoms.com` (first environment on this cluster is staging, not prod), with rate limiting |
| `16-fluent-bit-config.example.yaml` | **Template only.** The Grafana Cloud log-shipping config. Not applied by `kubectl apply -f k8s/` — the Fluent Bit chart loads it via `existingConfigMap`; see the header for the exact command and the credentials to fill in |
| `21-ingress-production.yaml` | Routes `www.gamercoms.com` / `gamercoms.com` / `api.gamercoms.com` via `letsencrypt-prod`. **Not applied yet** -- see the cutover runbook below for why the order matters |

Apply in filename order (`kubectl apply -f k8s/`) once the placeholders below
are filled in -- the numeric prefixes exist so that ordering is unambiguous
(namespace and config before anything that depends on them, Mongo before the
app tier that reads its generated Secret).

Two things need to be installed into the cluster *before* `kubectl apply -f
k8s/` will work, neither of which is a manifest in this repo (same reasoning
as ingress-nginx/cert-manager below -- cluster-wide addons, not
app-specific): the **MCK operator** (`13-mongo.yaml`'s header has the exact
Helm commands) and **ingress-nginx + cert-manager** (see below).

## Production cutover runbook

This cluster does not gain a production environment — it *becomes* one. There
is one cluster, one namespace, one database. When DNS moves, staging stops
existing; there is no second place to try things first. Everything below is
ordered because the order is what makes it safe.

Two things make this different from a normal deploy. Applying the production
Ingress before DNS moves burns Let's Encrypt's failed-validation rate limit
(reasoning in `21-ingress-production.yaml`'s header). And switching Discord
applications is not a config change — it changes which bot *user* is in each
guild.

### Before the window

1. **Confirm which Discord application old production runs.** Everything in
   step 3 depends on this. Expected: `1257298573436125185` ("GamerComs bot",
   verified to exist via Discord's public application API) — the cluster
   currently runs `1326999027321012246` ("GComsTestBot"). On the old server:
   `grep DISCORD_CLIENT_ID ~/gcoms/*/.env`, or decode the bot token's first
   segment, which is the application id in base64.

   **This is the one step with no undo.** The 30 migrated guilds have the old
   production bot installed. If the cluster comes up on the test application,
   every one of those guilds has no bot present — not a broken bot, an absent
   one — and getting it back means re-inviting the bot to 30 servers by hand.

2. **Register the redirect URI** `https://www.gamercoms.com/auth/discord/callback`
   on that application. The backend sends this to Discord's token endpoint as
   `${FRONTEND_URL}/auth/discord/callback`; Discord rejects an exact-match
   miss, so login fails closed rather than degrading.

3. **Put that application's credentials in the cluster.** `DISCORD_API_TOKEN`
   and `DISCORD_CLIENT_SECRET` in the `gamercoms-secrets` Secret. Write them
   through a real base64 encoder — shell quoting silently added a byte to a
   client secret in this project once, which authenticated from a laptop and
   returned `invalid_client` from inside the pod.

4. **Rebuild the frontend.** `NEXT_PUBLIC_DISCORD_CLIENT_ID` and
   `NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID` are GitHub *repository variables*, not
   ConfigMap entries, and Next.js inlines them at **build** time. Changing
   them needs a new build, not a redeploy — a redeploy ships the old values.

5. **Take a fresh `mongodump` of old production.** What is in the cluster now
   is a test snapshot from 2026-09-24 and is already stale.

### The window

6. **Stop the old VPS bot first.** Same token, and Discord permits one gateway
   session — two running bots take the session from each other indefinitely.

7. **Restore the fresh dump.** `dropDatabase` is denied to the `gamercoms`
   user; empty each collection with `deleteMany({})` and confirm empty before
   restoring, or you get unique-index collisions on top of surviving rows.

8. **Point DNS at the NodeBalancer** — `172.232.145.14`, at Cloudflare, for
   `www`, the apex, and `api`.

9. **Apply the production Ingress** and watch the certificates go Ready:
   `kubectl apply -f k8s/21-ingress-production.yaml && kubectl get certificate -n gamercoms -w`

10. **Merge and apply the ConfigMap cutover PR**, then restart the consumers.
    A ConfigMap change does **not** reach running pods:
    `kubectl rollout restart deployment/backend deployment/bot deployment/bot-api -n gamercoms`

    That PR is held open deliberately rather than merged early: `FRONTEND_URL`
    is both the backend's CORS origin and its OAuth `redirect_uri`, so merging
    it while staging is still live means any stray `kubectl apply -f
    k8s/01-configmap.yaml` from `main` breaks staging login. That exact failure
    has happened here before, with `BOT_API_URL`.

11. **Verify against the origin, not through Cloudflare.** A 200 from
    Cloudflare can still be the old server:
    `curl -sI --resolve www.gamercoms.com:443:172.232.145.14 https://www.gamercoms.com/`
    Then log in for real, and confirm the bot is online in a migrated guild.

### After

12. **Unset the `AUTO_DEPLOY_ENVIRONMENT` repository variable** on all three
    app repos. It is currently `staging`; leaving it set means every merge to
    the default branch ships straight to live users. Required-reviewer
    protection is not available on this plan (the branch-protection API 403s
    with "Upgrade to GitHub Pro"), so this variable being unset is the only
    gate that exists. Merges still build and push the image; deploying becomes
    a deliberate run of the Deploy workflow.

13. **Retire staging:** `kubectl delete -f k8s/20-ingress.yaml`, and drop the
    staging DNS records.

14. **Decide where the weekly leaderboard posts.**
    `WEEKLY_LEADERBOARD_GUILD_ID` is still the GamerComs STAGING guild, so
    after cutover the job posts production activity into a test server.

## Why the bot is different

The bot ships as two Deployments from one image. Discord's one-session limit
applies only to the GATEWAY, not to REST calls or database access, so only
`12-bot.yaml` is pinned at a single replica -- `12b-bot-api.yaml` serves the
internal HTTP API and scales like any other service. Both must be deployed
together; the deploy workflow updates both and fails if their versions differ.

Discord allows exactly one live gateway session per bot token. `12-bot.yaml`
is pinned to `replicas: 1` with `strategy: Recreate` instead of the default
rolling update, and deliberately has no HPA object at all. Frontend and
backend don't have this constraint -- both got the in-memory-state fixes
needed to run safely at N replicas as part of the code-level cleanup, and
both here default to a 2-6 replica HPA.

## Security hardening in this pass

- **Non-root containers.** All three `dockerfile.prod`s now create and
  switch to a non-root user (uid/gid 1001); the Deployments additionally set
  `securityContext.runAsNonRoot: true` at the pod level and
  `allowPrivilegeEscalation: false` + drop all Linux capabilities at the
  container level, so a pod refuses to run as root even if a future image
  change accidentally drops the Dockerfile's `USER` line.
- **NetworkPolicies** (`15-networkpolicies.yaml`) -- ingress-only, so
  outbound calls (Discord API, RAWG, Object Storage) are untouched. Locks
  down who can open a connection to each service: frontend/backend only from
  the ingress controller (plus frontend->backend), bot only from backend,
  and Mongo only from backend/bot/the backup CronJob/other Mongo replicas.
  Requires the cluster's CNI to enforce NetworkPolicy -- LKE's default CNI
  (Calico) does.
- **Mongo backups.** `14-mongo-backup-cronjob.yaml` -- there's no automated
  backup at all in the current Compose setup, so this is new coverage, not
  parity. Needed regardless of single-pod vs. replica-set Mongo: a replica
  set protects against losing a node, not against a bad deploy or a bug that
  corrupts data across all three replicas at once.
- **Rate limiting** on the Ingress (`20-ingress.yaml`) -- the free
  alternative to a paid WAF/DDoS product. Akamai's own App & API Protector
  was checked and is enterprise/quote-based pricing, not self-serve, not
  worth it at current traffic; revisit only if real abuse traffic shows up.

None of this is a substitute for actually testing against a live cluster --
everything above was reasoned through and, where possible (the three
Dockerfiles), verified by building the images locally and confirming
`process.getuid() !== 0` and that the bot can still write its games-cache
self-heal file as the non-root user. The Kubernetes-side pieces
(NetworkPolicy enforcement, the Mongo operator's actual generated Secret
name, the CronJob) are reasoned from documentation, not verified against a
running cluster -- flagged individually in each file's comments where that
matters.

## What you still need to decide (not code decisions)

These are genuinely yours to make, not something I picked for you:

- **Registry.** Every image is `REGISTRY_PLACEHOLDER/<name>:TAG_PLACEHOLDER`.
  Recommended: GitHub Container Registry (ghcr.io) -- free, the repos
  already live on GitHub, and it's a plain `docker/build-push-action` +
  `imagePullSecrets` setup (already wired into the three Deployments here;
  create the `ghcr-pull-secret` with `kubectl create secret docker-registry
  ghcr-pull-secret --docker-server=ghcr.io --docker-username=<you>
  --docker-password=<a PAT with read:packages>`, or skip it and make the
  packages public instead). The current deploy scripts (`../deploy-all.sh`,
  `../push.sh`) build images in place on the VPS with no registry involved
  at all -- that whole flow needs replacing with build -> scan -> push to a
  registry -> `kubectl apply` / Helm / GitOps, not an incremental patch to
  the existing scripts. Each app repo now has a
  `.github/workflows/build-and-push.yml` that does the build/scan/push half
  of this (see each repo) -- wiring the actual `kubectl apply` deploy step
  onto a real cluster is still open.
- **Ingress controller + cert-manager.** `20-ingress.yaml` assumes
  ingress-nginx and a cert-manager `ClusterIssuer` named `letsencrypt-prod`.
  Swap both if the cluster runs something else. HTTP01 (not DNS01) is enough
  -- only two named hosts are routed here, no wildcard cert needed.
- **The real host-Nginx config.** The routing rules in `20-ingress.yaml` were
  built from `../nginx.conf` plus what CLAUDE.md documents about the
  `api.gamercoms.com` vhost, but that second vhost isn't checked into this
  repo -- it exists only on the live server's `/etc/nginx/sites-available`.
  Pull the real config off the server and diff it against this Ingress
  before treating this as a complete replacement.
- **Resource requests/limits and HPA/rate-limit thresholds.** The app-tier
  limits match the `deploy:` blocks already in `../docker-compose.prod.yml`;
  Mongo's are a fresh guess since there's no Compose equivalent to match.
  Request values, the 70%-CPU HPA target, and the ingress `limit-rps` are
  reasonable starting points, not measured numbers. Revisit all of them once
  this is running under real traffic.
- **Node-pool autoscaling.** LKE has native node-pool autoscaling (min/max
  node count per pool) -- this is Cloud Manager/API cluster config, not a
  manifest, so it can't be "fixed" here the way the pod-level HPAs above
  can. Set it when creating the node pool. Without it, the HPAs above can
  hit a ceiling where there's no room to schedule more pods on a fixed-size
  pool.
- **Secrets reproducibility.** `02-secret.yaml` is git-ignored by design, so
  there's currently no version-controlled way to redeploy secrets to a fresh
  cluster -- manual re-entry every time. For a small team, Sealed Secrets
  (encrypt client-side, commit the encrypted blob, only the cluster's own
  key can decrypt) is the right-sized fit; a full External Secrets Operator
  + Vault/cloud-secrets-manager setup is more machinery than this project
  needs. Not included here as a manifest (same reasoning as
  ingress-nginx/cert-manager/MCK -- it's a cluster-wide addon you install
  once, not app-specific config): `helm repo add sealed-secrets
  https://bitnami-labs.github.io/sealed-secrets` then `helm install
  sealed-secrets-controller sealed-secrets/sealed-secrets`, then `kubeseal
  < k8s/02-secret.yaml > k8s/02-secret.sealed.yaml` (the sealed output *is*
  safe to commit) once a real cluster exists to seal against.

## What's deliberately not here

- **games.json persistence.** The bot's games-cache self-heal writes to
  local container disk; a pod restart under k8s loses anything written since
  the image was built. No PVC is defined here because the accepted default
  is to treat the baked-in image cache as the floor and eat the occasional
  extra RAWG API spend after a restart. If that tradeoff turns out to be
  wrong in practice, add a small PVC for `/app/src/data` on the bot
  Deployment and mount it there -- deliberately left out of a first draft
  rather than guessed at.
- **PodDisruptionBudgets** -- the current Compose setup has no equivalent to
  translate, and with node-pool autoscaling still an open decision above,
  tuning a PDB before knowing real node-drain behavior would be guessing.
  Add one if/when node drains in practice prove disruptive.
