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
| `12-bot.yaml` | Deployment + Service -- **pinned to 1 replica, no HPA, ever** -- non-root, `imagePullSecrets` |
| `13-mongo.yaml` | `MongoDBCommunity` custom resource -- 3-member self-hosted replica set |
| `14-mongo-backup-cronjob.yaml` | Nightly `mongodump` -> Linode Object Storage (S3-compatible) |
| `15-networkpolicies.yaml` | Ingress-only NetworkPolicies -- only backend/bot/the backup job can reach Mongo, etc. |
| `20-ingress.yaml` | Routes `gamercoms.com` / `www.gamercoms.com` / `api.gamercoms.com`, with rate limiting |

Apply in filename order (`kubectl apply -f k8s/`) once the placeholders below
are filled in -- the numeric prefixes exist so that ordering is unambiguous
(namespace and config before anything that depends on them, Mongo before the
app tier that reads its generated Secret).

Two things need to be installed into the cluster *before* `kubectl apply -f
k8s/` will work, neither of which is a manifest in this repo (same reasoning
as ingress-nginx/cert-manager below -- cluster-wide addons, not
app-specific): the **MCK operator** (`13-mongo.yaml`'s header has the exact
Helm commands) and **ingress-nginx + cert-manager** (see below).

## Why the bot is different

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
