# Kubernetes manifests (draft)

First-draft manifests for moving Gamercoms off the single-VPS Docker Compose
setup (`../docker-compose.prod.yml`) onto Kubernetes, written alongside the
`kubernetes-migration` branches in `Gamercoms-web`, `gcoms-public-backend`,
and `gcoms-public-bot` that fixed the code-level issues a k8s move would
otherwise have exposed (in-memory state that doesn't survive multiple
replicas, missing health endpoints, ungraceful shutdown, etc).

MongoDB is assumed to already be a managed cluster (e.g. Atlas) reachable via
`MONGODB_URI` -- there is no Mongo Deployment/StatefulSet here, and none is
needed.

## What's here

| File | What it is |
|---|---|
| `00-namespace.yaml` | The `gamercoms` namespace everything else lives in |
| `01-configmap.yaml` | Non-secret config, shared across services |
| `02-secret.example.yaml` | **Template only.** Copy to `02-secret.yaml` (git-ignored) and fill in real values, or use a real secrets manager instead |
| `10-frontend.yaml` | Deployment + Service + HPA (2-6 replicas) |
| `11-backend.yaml` | Deployment + Service + HPA (2-6 replicas) |
| `12-bot.yaml` | Deployment + Service -- **pinned to 1 replica, no HPA, ever** |
| `20-ingress.yaml` | Routes `gamercoms.com` / `www.gamercoms.com` / `api.gamercoms.com` |

Apply in filename order (`kubectl apply -f k8s/`) once the placeholders below
are filled in -- the numeric prefixes exist so that ordering is unambiguous
(namespace and config before anything that depends on them).

## Why the bot is different

Discord allows exactly one live gateway session per bot token. `12-bot.yaml`
is pinned to `replicas: 1` with `strategy: Recreate` instead of the default
rolling update, and deliberately has no HPA object at all. Frontend and
backend don't have this constraint -- both got the in-memory-state fixes
needed to run safely at N replicas as part of the code-level cleanup, and
both here default to a 2-6 replica HPA.

## What you still need to decide (not code decisions)

These are genuinely yours to make, not something I picked for you:

- **Registry.** Every image is `REGISTRY_PLACEHOLDER/<name>:TAG_PLACEHOLDER`.
  The current deploy scripts (`../deploy-all.sh`, `../push.sh`) build images
  in place on the VPS with no registry involved at all -- that whole flow
  needs replacing with build -> push to a registry -> `kubectl apply` /
  Helm / GitOps, not an incremental patch to the existing scripts.
- **Ingress controller + cert-manager.** `20-ingress.yaml` assumes
  ingress-nginx and a cert-manager `ClusterIssuer` named `letsencrypt-prod`.
  Swap both if the cluster runs something else.
- **The real host-Nginx config.** The routing rules in `20-ingress.yaml` were
  built from `../nginx.conf` plus what CLAUDE.md documents about the
  `api.gamercoms.com` vhost, but that second vhost isn't checked into this
  repo -- it exists only on the live server's `/etc/nginx/sites-available`.
  Pull the real config off the server and diff it against this Ingress
  before treating this as a complete replacement.
- **Resource requests/limits and HPA thresholds.** The limits match the
  `deploy:` blocks already in `../docker-compose.prod.yml`; the request
  values and the 70%-CPU HPA target are reasonable starting points, not
  measured numbers. Revisit both once this is running under real traffic.

## What's deliberately not here

- **games.json persistence.** The bot's games-cache self-heal writes to
  local container disk; a pod restart under k8s loses anything written since
  the image was built. No PVC is defined here because the accepted default
  is to treat the baked-in image cache as the floor and eat the occasional
  extra RAWG API spend after a restart. If that tradeoff turns out to be
  wrong in practice, add a small PVC for `/app/src/data` on the bot
  Deployment and mount it there -- deliberately left out of a first draft
  rather than guessed at.
- **PodDisruptionBudgets, NetworkPolicies, imagePullSecrets** -- none of the
  current compose setup has an equivalent to translate, so none were
  invented here. Add them if/when the cluster setup calls for them.
