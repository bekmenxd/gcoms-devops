// Load-test orchestrator: simulates realistic Gamercoms users against the
// parallel bot-loadtest/backend-loadtest deployment (see k8s/90-loadtest.yaml
// and gcoms-dir/CLAUDE.md's load-testing note for the full design).
//
// Each simulated user is an independent async state machine:
//   idle ("playing", 1-5 real minutes) -> decide an action -> real HTTP
//   request through the full real chain (ingress -> backend-loadtest ->
//   bot-loadtest -> Mongo) -> back to idle.
// Users share a pool of open queues so joins are genuine cross-user activity,
// not isolated per-user silos -- matching Linus's explicit ask that users
// "interact with the same queues... and also create queues."
//
// Usage:
//   node orchestrator.mjs <usersFile.json> [--duration=<min>] [--think-min=<sec>]
//     [--think-max=<sec>] [--create-ratio=<0-1>] [--state-file=<path>]
//
// Writes a live JSON snapshot to --state-file every 2s (default:
// ./orchestrator-state.json) for the dashboard bridge to read and push via
// the Artifact db capability -- see gcoms-dir/CLAUDE.md for why the page
// can't just fetch this directly (CSP blocks arbitrary outbound fetch from
// a published artifact).

import { readFileSync, writeFileSync } from "node:fs";

const BASE_URL = "https://staging.gamercoms.com/loadtest-api";
const GUILD_ID = "loadtest-guild-1";

function arg(name, def) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : def;
}

const usersFile = process.argv[2];
if (!usersFile) {
  console.error("Usage: node orchestrator.mjs <usersFile.json> [options]");
  process.exit(1);
}
const DURATION_MS = Number(arg("duration", "2")) * 60 * 1000;
const THINK_MIN_MS = Number(arg("think-min", "60")) * 1000;
const THINK_MAX_MS = Number(arg("think-max", "300")) * 1000;
const CREATE_RATIO = Number(arg("create-ratio", "0.5"));
const STATE_FILE = arg("state-file", "./orchestrator-state.json");

const seededUsers = JSON.parse(readFileSync(usersFile, "utf8"));

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const ROOM_POLL_INTERVAL_MS = 5000; // matches the real frontend's room-page poll cadence

// ---- shared state across all simulated users --------------------------------
// Queues this run itself created -- the pool users pick from to join each
// other's queues. Not the real public directory (which may carry unrelated
// real queues) -- this run should only ever interact with its own.
const openQueues = new Map(); // id -> { ownerDiscordId, size, currentUsers }

const stats = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  statusCounts: {},
};

const userStates = new Map(); // discordId -> live status row for the dashboard

function recordRequest(status) {
  stats.requests++;
  stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
  if (status >= 400) stats.errors++;
}

async function call(method, path, token, body) {
  const start = performance.now();
  let status = 0;
  let json = null;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Cookie: `token=${token}` } : {}),
      },
      // Fastify's JSON body parser 400s on Content-Type: application/json
      // with a truly empty body (FST_ERR_CTP_EMPTY_JSON_BODY, masked by the
      // backend's global error handler as an opaque "Internal Server
      // Error" -- see gcoms-dir/CLAUDE.md's "Empty-body request gotchas").
      // Always send SOME body for a non-GET call, even {}.
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch (e) {
    status = 0;
    json = { error: String(e) };
  }
  const latencyMs = Math.round(performance.now() - start);
  recordRequest(status);
  return { status, json, latencyMs };
}

function setUserState(discordId, patch) {
  const existing = userStates.get(discordId) || { discordId };
  userStates.set(discordId, { ...existing, ...patch, updatedAt: Date.now() });
}

// While a user is reserved/confirmed and "watching" their queue, the real
// frontend room page polls GET /:id/room every 5s (see gcoms-dir/CLAUDE.md)
// -- this is the dominant source of real aggregate request volume, far more
// than the sparse create/join actions themselves. Without modeling it, a
// "max concurrent users" number from this tool would be misleadingly
// optimistic. Polls for durationMs total, at the real cadence.
async function playWhilePolling(queueId, token, durationMs, discordId) {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    const wait = Math.min(ROOM_POLL_INTERVAL_MS, until - Date.now());
    if (wait <= 0) break;
    await sleep(wait);
    const { status, latencyMs } = await call(
      "GET",
      `/api/v1/queues/${queueId}/room`,
      token,
    );
    setUserState(discordId, { lastStatus: status, lastLatencyMs: latencyMs });
  }
}

function writeSnapshot() {
  const elapsedMs = Date.now() - stats.startedAt;
  const snapshot = {
    updatedAt: new Date().toISOString(),
    config: {
      durationMs: DURATION_MS,
      thinkMinMs: THINK_MIN_MS,
      thinkMaxMs: THINK_MAX_MS,
      createRatio: CREATE_RATIO,
      userCount: seededUsers.length,
    },
    elapsedMs,
    remainingMs: Math.max(0, DURATION_MS - elapsedMs),
    aggregate: {
      requests: stats.requests,
      errors: stats.errors,
      errorRatePct: stats.requests
        ? Math.round((stats.errors / stats.requests) * 1000) / 10
        : 0,
      rps:
        Math.round((stats.requests / Math.max(1, elapsedMs / 1000)) * 10) /
        10,
      statusCounts: stats.statusCounts,
      openQueues: openQueues.size,
    },
    users: Array.from(userStates.values()).sort((a, b) =>
      a.discordId.localeCompare(b.discordId),
    ),
  };
  writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
}

// ---- one simulated user's lifecycle -----------------------------------------

async function runUser(user, endTime) {
  const { discordId, token } = user;
  setUserState(discordId, { state: "idle", action: null, queueId: null });

  while (Date.now() < endTime) {
    await sleep(randomBetween(THINK_MIN_MS, THINK_MAX_MS));
    if (Date.now() >= endTime) break;

    const joinable = Array.from(openQueues.entries()).filter(
      ([, q]) => q.ownerDiscordId !== discordId && q.currentUsers < q.size,
    );
    const shouldCreate = Math.random() < CREATE_RATIO || joinable.length === 0;

    if (shouldCreate) {
      setUserState(discordId, { state: "creating", action: "POST /queues" });
      const size = pick([2, 3, 4, 5]);
      const { status, json, latencyMs } = await call("POST", "/api/v1/queues", token, {
        guildID: GUILD_ID,
        name: `Loadtest queue ${discordId.slice(-6)}-${Date.now() % 10000}`,
        size,
      });
      setUserState(discordId, { lastStatus: status, lastLatencyMs: latencyMs });

      if (status === 201 && json?.data?.id) {
        const queueId = json.data.id;
        openQueues.set(queueId, {
          ownerDiscordId: discordId,
          size,
          currentUsers: 0,
        });
        setUserState(discordId, {
          state: "confirmed",
          action: "hosting",
          queueId,
        });

        // The host also joins their own queue's voice channel.
        const joinRes = await call("POST", `/api/v1/loadtest/voice-join`, null, {
          queueId,
          userID: discordId,
          userName: discordId,
        });
        setUserState(discordId, { lastStatus: joinRes.status });
        const q = openQueues.get(queueId);
        if (q) q.currentUsers++;

        // Play for a while (polling the room page like a real host watching
        // their queue fill), then close it (only the owner can).
        const playMs = Math.min(randomBetween(THINK_MIN_MS, THINK_MAX_MS), endTime - Date.now());
        setUserState(discordId, { action: "watching room" });
        await playWhilePolling(queueId, token, playMs, discordId);
        if (Date.now() < endTime) {
          setUserState(discordId, { state: "closing", action: "POST /close" });
          const closeRes = await call(
            "POST",
            `/api/v1/queues/${queueId}/close`,
            token,
          );
          setUserState(discordId, { lastStatus: closeRes.status });
          openQueues.delete(queueId);
        }
        setUserState(discordId, { state: "idle", action: null, queueId: null });
      } else {
        // Create failed (cooldown, already active, etc.) -- back to idle.
        setUserState(discordId, { state: "idle", action: null });
      }
    } else {
      const [queueId, q] = pick(joinable);
      setUserState(discordId, { state: "joining", action: "POST /join", queueId });
      const { status, latencyMs } = await call(
        "POST",
        `/api/v1/queues/${queueId}/join`,
        token,
      );
      setUserState(discordId, { lastStatus: status, lastLatencyMs: latencyMs });

      if (status === 201 || status === 200) {
        q.currentUsers++;
        setUserState(discordId, { state: "reserved", queueId });

        const joinRes = await call("POST", `/api/v1/loadtest/voice-join`, null, {
          queueId,
          userID: discordId,
          userName: discordId,
        });
        setUserState(discordId, {
          state: joinRes.status === 200 ? "confirmed" : "reserved",
          action: "playing",
          lastStatus: joinRes.status,
        });

        const playMs = Math.min(randomBetween(THINK_MIN_MS, THINK_MAX_MS), endTime - Date.now());
        setUserState(discordId, { action: "watching room" });
        await playWhilePolling(queueId, token, playMs, discordId);
        if (Date.now() < endTime) {
          setUserState(discordId, { state: "leaving", action: "voice-leave" });
          await call("POST", `/api/v1/loadtest/voice-leave`, null, {
            queueId,
            userID: discordId,
            userName: discordId,
          });
          const stillOpen = openQueues.get(queueId);
          if (stillOpen) stillOpen.currentUsers = Math.max(0, stillOpen.currentUsers - 1);
        }
        setUserState(discordId, { state: "idle", action: null, queueId: null });
      } else {
        setUserState(discordId, { state: "idle", action: null, queueId: null });
      }
    }
  }
  setUserState(discordId, { state: "done", action: null });
}

async function main() {
  console.log(
    `Starting load test: ${seededUsers.length} users, ${DURATION_MS / 60000}min, think ${THINK_MIN_MS / 1000}-${THINK_MAX_MS / 1000}s, create ratio ${CREATE_RATIO}`,
  );
  const endTime = Date.now() + DURATION_MS;

  const snapshotTimer = setInterval(writeSnapshot, 2000);
  await Promise.all(seededUsers.map((u) => runUser(u, endTime)));
  clearInterval(snapshotTimer);
  writeSnapshot();

  console.log("\n--- Final stats ---");
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
