# Phase 1: ALB + Multi-EC2 Scaling Runbook

This runbook moves OG Rummy backend from single-EC2 to ALB-backed multi-EC2 with shared Redis/RDS.

## Goal

- Keep current behavior while improving reliability under gameplay load
- Route traffic through ALB (single URL)
- Run 2+ EC2 game nodes safely
- Validate with scripted load tests

## Preconditions

- Shared PostgreSQL (RDS/Aurora) reachable from all game EC2s
- Shared Redis (`REDIS_URL`) reachable from all game EC2s
- Same deploy branch/image on all nodes
- Same secrets on all nodes (`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, S3/payment vars)

## Step 1: Set Environment Baseline

Use these as a starting point for each game node:

```env
NODE_ENV=production
PORT=3000

REDIS_URL=rediss://<shared-elasticache-endpoint>:6379
DATABASE_URL=postgresql://<shared-rds-endpoint>:5432/<db>
JWT_SECRET=<same-on-all-nodes>

CLUSTER_INSTANCES=2
DB_POOL_MAX=12
SOCKET_TRANSPORTS=websocket

DURABLE_TIMER_ARM=true
DURABLE_TIMER_SWEEPER_ENABLED=true
PROCESS_LEADER_ENABLED=true
LIVE_SESSION_STATE_ENABLED=true
LIVE_SESSION_STATE_ASYNC_PG=true
SESSION_STATE_CACHE_ENABLED=true
```

Notes:
- Increase `CLUSTER_INSTANCES` to 4 only if instance CPU has headroom.
- Increase `DB_POOL_MAX` carefully. Total possible PG connections is roughly:
  `instances_per_node * DB_POOL_MAX * node_count`.

## Step 2: ALB Setup

Create an Application Load Balancer:

- Listener:
  - `443` HTTPS (recommended)
  - optional `80` HTTP redirect to HTTPS
- Target group:
  - protocol: HTTP
  - target type: instance
  - target port: `80` (if using current EC2 deploy script/container mapping)
  - health check path: `/health`
  - success code: `200`
  - (optional readiness) path `/ready` → `200` when worker can accept sockets; `503` when at
    `MAX_SOCKETS_PER_WORKER` or `ADMIT_MAX_EVENT_LOOP_LAG_MS`. Use for drain / custom alarms;
    keep primary TG liveness on `/health` so a brief lag spike does not flap all targets.
- ALB idle timeout: `120s` (websocket friendly)
- Security groups:
  - ALB SG allows inbound 80/443 from internet
  - EC2 SG allows inbound 80 only from ALB SG
  - EC2 SG can reach RDS (5432) and Redis (6379/TLS)

## Step 3: Register Two EC2 Nodes

1. Deploy same backend build to EC2-A and EC2-B.
2. Confirm local health on each:
   - `curl -s http://localhost/health`
3. Add both instances to target group.
4. Confirm target health is green in ALB.

### Dual-host CI deploy (recommended)

GitHub Actions [`.github/workflows/deploy-ec2.yml`](.github/workflows/deploy-ec2.yml) rolls out to both nodes on push to `main`.

Set repository secrets (same SSH key/user on both):



| Secret | Example |
|--------|---------|
| `EC2_HOST_1` | `13.233.105.184` |
| `EC2_HOST_2` | `15.206.67.107` |
| `EC2_USER` | `ec2-user` |
| `EC2_SSH_PRIVATE_KEY` | contents of `og-rummy-mumbai.pem` |

Legacy `EC2_HOST` still works as fallback for node 1. Without `EC2_HOST_2`, only one node deploys.

## Step 4: Preflight Verification on Each Node

Inside the API container (recommended; env already injected, no `/app/.env` file):

```bash
sudo docker exec -it og-rummy-api \
  sh -c 'HEALTH_URL=http://127.0.0.1:3000/health ./scripts/phase1_preflight.sh'
```

Or from the EC2 host (if host has curl and you only need health):

```bash
curl -s http://127.0.0.1/health
HEALTH_URL=http://127.0.0.1/health ./scripts/phase1_preflight.sh
```

Do **not** dump container env to the terminal (`printenv` / `export $(grep .env)`), secrets will leak into shell history.

This checks:
- required env vars
- `/health` response
- Redis + durable timers
- websocket-only transport
- cluster/db pool settings

## Step 5: Cutover

1. Point client API base URL to ALB DNS/domain.
2. Keep old single-node endpoint available briefly for rollback.
3. Watch metrics during the first traffic window.

## Step 6: Validation Load Plan

From a separate load machine (not game EC2):

1) Socket capacity:

```bash
node scripts/load_test_concurrency.js \
  --url https://<alb-domain> \
  --tokens load_tokens.jsonl \
  --target 10000 \
  --ramp-seconds 120 \
  --hold-seconds 300
```

2) Gameplay capacity ramp:

```bash
node scripts/load_test_gameplay.js \
  --url https://<alb-domain> \
  --tokens load_tokens.jsonl \
  --game-id <id> \
  --contest-id <id> \
  --tables 200 \
  --concurrency 20 \
  --max-game-seconds 120
```

Then ramp 200 -> 500 -> 1000 tables.

## Success Criteria (Phase 1)

- ALB targets stable/healthy
- zero app restarts/crashes
- gameplay load with:
  - `failed` <= 0.5%
  - `soft_timeout_drop` near 0
  - low `ack_timeout` share in `top_errors`

## Rollback

- Point client base URL back to old single-node endpoint
- Deregister problematic target from ALB
- Keep shared Redis/RDS untouched

## Common Issues

- `ack_timeout` spikes:
  - reduce load test `--concurrency`
  - increase node count
  - tune `DB_POOL_MAX` and DB capacity
- `Session is full` during scripted gameplay:
  - ensure load-test sessions bypass matchmaking (`load_test_gameplay` metadata path is in code)
- cross-node behavior issues:
  - verify all nodes use same `REDIS_URL`
  - verify `SOCKET_TRANSPORTS=websocket`
