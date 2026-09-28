# CryptoTrace — Backend (Phases 1–3)

**SIH 2026 · Ministry of Home Affairs**
Real-Time Identification of Fraud-Linked Cryptocurrency Exchanges from Victim-Reported Suspect Wallet Addresses

**Phase 1** delivers the blockchain ingestion layer: given a victim-reported wallet address, it walks
outgoing value flow across multiple hops and identifies which centralised exchanges the money
reached.

**Phase 2** persists that into Neo4j. Every trace is written as `Wallet` nodes joined by
`TRANSACTION` edges, so traces accumulate into one graph instead of staying isolated — which is what
makes the Phase 3 `shortestPath` query possible, and what lets two different victims' reports reveal
a shared laundering route.

**Phase 3** asks the graph the question the problem statement actually poses. `GET /api/trace/:address`
runs a `shortestPath` from the reported wallet to every reachable `isExchange: true` node, ranks the
routes, and returns them both as an investigator's step-by-step narrative and as a `{nodes, links}`
payload the Phase 4 dashboard renders directly.

---

## Setup

Run every command from the `backend/` directory.

```bash
cd backend

# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env

# 3. Generate the offline demo dataset
npm run seed:fixtures

# 4. Verify everything works — no API key, no database, no network needed
npm run verify

# 5. Load the exchange hot wallets into Neo4j (needs Neo4j running — see below)
npm run seed:exchanges

# 6. Start the server
npm run dev
```

Then edit `.env` and set:

- `ALCHEMY_API_KEY` — from your [Alchemy dashboard](https://dashboard.alchemy.com). Create an app on
  Ethereum Mainnet and copy the API key, not the full URL.
- `NEO4J_PASSWORD` — whatever you set when creating the DBMS in Neo4j Desktop.

Step 4 runs all three suites and should print `All 28 checks passed.`, then `All 38 checks passed.`,
then `Phase 3 smoke test: 58 checks passed.` Together those 124 checks verify the traversal,
filtering, retry and rate-limit logic, every Cypher statement, batching path and type conversion,
**and** the trace query, its ranking, its empty cases and the exact force-graph payload the dashboard
will consume — before you spend an API call or start a database.

### Setting up Neo4j Desktop

1. Install [Neo4j Desktop](https://neo4j.com/download/) and open it.
2. Create a new **Local DBMS** (any recent 5.x). Set a password and remember it.
3. Press **Start** and wait for the status to read *Active*.
4. Put that password in `NEO4J_PASSWORD` in `backend/.env`.
5. Run `npm run seed:exchanges`.

The connection URI defaults to `neo4j://localhost:7687`. **That port is 7687, not 7474.** Port 7474
is the Neo4j Browser web interface; pointing `NEO4J_URI` at it is the most common first-run mistake,
so the config validator checks for it by name and tells you what happened.

If Neo4j will not cooperate and you need a working demo now, set `GRAPH_ENABLED=false`. Traces still
run and still identify exchanges — they simply are not saved. Nothing else breaks.

---

## Try it

### Offline, against the fixture scenario

Set `MOCK_MODE=true` in `.env`, restart, then:

```bash
# The suspect address is printed by `npm run seed:fixtures`

# Phase 1 — pull the transfer history and write it to the graph
curl "http://localhost:4000/api/history/<SUSPECT_ADDRESS>?depth=3"

# Phase 3 — ask the graph where the money cashed out
curl "http://localhost:4000/api/trace/<SUSPECT_ADDRESS>"
```

The second call works even if you skip the first: if the wallet is not in the graph yet, the trace
route fetches it from the chain, ingests it, and retries once. An investigator pasting an address
should not have to know which endpoint to prime first.

### Live, against Ethereum mainnet

Set `MOCK_MODE=false` and supply `ALCHEMY_API_KEY`, then trace any address:

```bash
curl "http://localhost:4000/api/history/0x28C6c06298d514Db089934071355E5743bf21d60?depth=2"
```

### Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/health` | Liveness plus RPC **and** Neo4j reachability, reported separately. Returns 503 if either dependency the current config needs is down. |
| `GET` | `/api/config` | Traversal limits, tracked assets, exchange registry, graph settings, risk model. The Phase 4 UI reads this so nothing is duplicated in the frontend. |
| `GET` | `/api/history/:address?depth=3` | Run a trace. Writes the result to Neo4j as a side effect. |
| `GET` | `/api/trace/:address?maxHops=15` | **The Phase 3 answer.** `shortestPath` from this wallet to every reachable exchange, plus a ready-to-render graph payload. |
| `GET` | `/api/graph/stats` | What is currently in the graph: node and edge counts, per-asset totals, top exchanges by received value. |
| `GET` | `/api/graph/schema` | Which constraints and indexes actually exist, plus the uniqueness model in force. |

`/health` reports the two dependencies separately on purpose. During a demo, "my server is down",
"Alchemy is unreachable" and "Neo4j is stopped" look identical from the frontend, and working out
which one it is in front of judges is not how you want to spend those minutes.

---

## What the trace returns

```jsonc
{
  "ok": true,
  "query":   { "address": "0x…", "depth": 3, "network": "eth-mainnet", "mockMode": false },
  "summary": {
    "walletCount": 10,
    "transactionCount": 12,
    "exchangesFound": 2,
    "topExchange": { "exchange": "Binance", "label": "Binance 14", "hop": 3, "receivedValue": 32500 },
    "totalsByAsset": { "USDT": 141100, "ETH": 0.57 }
  },
  "wallets":      [ /* → Neo4j Wallet nodes      */ ],
  "transactions": [ /* → Neo4j TRANSACTION edges */ ],
  "exchangesFound":  [ /* the answer: cash-out points, shallowest first */ ],
  "unresolvedLeads": [ /* trails cut by a limit — still worth pulling   */ ],
  "stats":    { /* rpcCalls, transfersDiscarded, durationMs, … */ },
  "graph":    { "ok": true, "walletsWritten": 10, "transactionsWritten": 12, "batches": 2 },
  "warnings": [ /* non-fatal notes, safe to surface in the UI */ ]
}
```

`graph.ok` is `false` when the trace could not be persisted. The trace itself still succeeded — check
`warnings` for the reason.

`transactions[]` field names line up with the Neo4j schema deliberately: `hash`, `amount`,
`timestamp`, `blockNumber` map onto `TRANSACTION`, and `from`/`to` are lowercase so they can key
`Wallet` MERGE operations directly.

---

## How the traversal works

`fetchWalletHistory(address, depth)` in `src/services/walletHistory.service.js` is a
**breadth-first** walk, not recursion. That is a deliberate choice:

- **Correct hop numbers.** BFS reaches every wallet by its shortest route first, so Phase 1's hop
  labels agree with Phase 3's `shortestPath` by construction. Depth-first can label a wallet hop 4
  when a 2-hop route exists.
- **No stack overflow** on long chains.
- **Concurrency.** A BFS level is a natural batch, fetched in parallel under one rate limiter.
- **Cycle safety.** Launderers create loops deliberately; a visited-set on a queue handles them.

### Four independent guard rails

Unbounded graph expansion is the main practical failure mode, so four brakes apply:

| Guard rail | Setting | Purpose |
| ---------- | ------- | ------- |
| Depth cap | `?depth`, `MAX_TRACE_DEPTH` | How far we walk |
| Fan-out cap | `MAX_FANOUT_PER_ADDRESS` | Follow only the largest N branches per wallet |
| Global cap | `MAX_ADDRESSES_PER_TRACE` | Circuit breaker on total work |
| Exchange cut-off | `src/config/knownExchanges.js` | Stop at the answer |

The **exchange cut-off** is the analytically important one. A Binance hot wallet makes hundreds of
thousands of outgoing transfers; following them would bury the signal, exhaust the API quota, and
produce a graph where everything looks connected to everything. When funds reach a CEX, the trail
has reached its destination — so we mark it terminal and report it.

Branches are aggregated **per recipient before ranking**, because a peeling chain often sends to one
address in many small slices precisely to look unimportant. Summed, it ranks correctly.

### Why `alchemy_getAssetTransfers` and not plain ethers calls

Standard Ethereum JSON-RPC has no "give me this address's history" method — everything is keyed by
hash or block, never by participant. Reconstructing one wallet's history from base RPC means
scanning every block since genesis. Alchemy's enhanced API maintains exactly the index we need, and
we reach it through `ethers.JsonRpcProvider.send()`, so ethers remains the transport.

---

## Two things to fix before you demo

**1. The Indian exchange addresses are placeholders.**
`src/config/knownExchanges.js` ships with verified addresses for Binance, Coinbase, Kraken, OKX,
KuCoin, Huobi, Bitfinex, Crypto.com and Gate.io. The **WazirX and CoinDCX entries are
zero-address placeholders** marked `verified: false`, and are filtered out at load — I did not guess
them, because an invented address a judge checks on Etherscan and finds unlabelled is far worse than
an honest gap. Fill them in from Etherscan public name tags and flip `verified: true`.
`/health` reports how many placeholders remain.

**2. Exchange attribution is crowd-sourced, and you should say so.**
Exchanges do not publish their hot wallets. These labels come from Etherscan, Arkham and similar.
That is a real limitation of this whole approach — owning it in your presentation is much stronger
than being caught out on it.

---

## Phase 2: the graph

### What gets written

Every trace is written to Neo4j automatically as a side effect of `GET /api/history/:address`. There
is no separate ingest step to forget.

| Element | Key properties |
| ------- | -------------- |
| `(:Wallet)` | `address` (unique, lowercase), `addressDisplay` (EIP-55), `isExchange`, `exchange`, `exchangeLabel`, `riskScore`, `minHopObserved`, `traceCount`, `firstSeenAt`, `lastSeenAt` |
| `[:TRANSACTION]` | `uniqueId` (unique), `hash` (indexed), `amount`, `asset`, `assetClass`, `contract`, `timestamp`, `blockNumber`, `category`, `hop` |

Writes use `MERGE`, never `CREATE`, so ingestion is idempotent and additive. Re-running the same
trace changes nothing; running a *different* trace that passes through the same wallet links the two.
That overlap is the most valuable thing this graph can show — two victims funnelling into one
laundering route — and `CREATE` would have made it invisible by producing a duplicate node per
address.

### The uniqueness decision

The original schema made `TRANSACTION.hash` unique. **That is not safe, and Phase 2 does not do it.**

One transaction hash can contain several transfers: a contract paying five recipients, a DEX swap
emitting both an ERC-20 and a native transfer, a batched exchange withdrawal. A unique constraint on
`hash` would have accepted the first edge and silently dropped the rest — and the dropped one can be
the edge that reaches the exchange. The trace would then report "no cash-out found" and be **wrong
quietly**, which for an investigative tool is the worst available failure mode.

So `uniqueId` (Alchemy's per-transfer identifier, already emitted by Phase 1) is the **unique** key,
and `hash` is **indexed** — still fast to look up, still what an investigator cross-checks against
Etherscan, but no longer able to discard evidence. `GET /api/graph/schema` states this at runtime, and
`npm run smoke:graph` asserts it.

### Seeding the exchange hot wallets

```bash
npm run seed:exchanges
```

This applies the schema, writes every verified exchange from `src/config/knownExchanges.js` with
`isExchange: true`, then **reads them back** to confirm. The read-back matters: write counters alone
would report success even if the rows had gone into the wrong database, which is exactly what happens
if `NEO4J_DATABASE` is wrong.

Seeding sets `isExchange = true` on both the create and match paths because it is authoritative
reference data. Trace ingestion, by contrast, can only ever turn the flag *on*
(`isExchange = coalesce(w.isExchange, false) OR row.isExchange`) — a later trace must never be able
to downgrade a known exchange, because Phase 3 finds cash-out points by targeting exactly that flag.
A false negative there does not degrade the answer, it deletes it.

### Seeing it in Neo4j Browser

Open <http://localhost:7474>, connect, and try:

```cypher
// Traced funds arriving at an exchange — the problem statement, as a query
MATCH (w:Wallet)-[t:TRANSACTION]->(e:Wallet { isExchange: true })
RETURN w, t, e LIMIT 50;

// Which exchanges received the most traced value
MATCH (:Wallet)-[t:TRANSACTION]->(e:Wallet { isExchange: true })
RETURN e.exchange, e.exchangeLabel, sum(t.amount) AS received, count(t) AS transfers
ORDER BY received DESC;

// A preview of the Phase 3 query
MATCH (start:Wallet { address: toLower('0xYOUR_ADDRESS') })
MATCH path = shortestPath((start)-[:TRANSACTION*1..15]->(e:Wallet { isExchange: true }))
RETURN path LIMIT 1;

// Wallets seen in more than one trace — shared laundering infrastructure
MATCH (w:Wallet) WHERE w.traceCount > 1 AND NOT w.isExchange
RETURN w.address, w.traceCount, w.riskScore ORDER BY w.traceCount DESC;
```

If the first query returns nothing, check `GET /api/graph/stats`. It reports how many `isExchange`
nodes exist, which distinguishes the two very different explanations — the money never reached an
exchange, versus the graph was never seeded.

### If Neo4j is down

The graph is an optional subsystem, deliberately. `neo4j-driver` is imported lazily, the boot-time
connectivity check is non-fatal, and ingestion failures are reported but never thrown. A trace
against a stopped database still returns **200 with complete on-chain data**, plus a warning saying
in as many words that the result was not saved and is otherwise unaffected. The chain data is the
expensive, rate-limited half of the work; discarding it because a local database was not running
would be the wrong trade.

### `riskScore` is a heuristic, and says so

`riskScore` starts at 100 at the reported address and falls 20 per hop (floor 10), with +10 for
layering (three or more outgoing recipients from a single inbound transfer) and +10 for pass-through
behaviour (forwarding 90% or more of what arrived). Known exchanges are pinned at 5 — an identified,
regulated destination to report, not a wallet to suspect. Scoring them high would light up the
Phase 4 heat map on precisely the nodes that are legitimate.

It exists because the schema has the field and leaving it null would make it decorative. It is not a
model, and the full breakdown is exposed at `/api/config` under `riskModel` so the UI can show an
honest legend rather than an unexplained number.

---

## Configuration reference

See `.env.example` for all options with inline commentary. The ones you are most likely to touch:

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `ALCHEMY_API_KEY` | — | Required unless `MOCK_MODE=true` |
| `ALCHEMY_NETWORK` | `eth-mainnet` | Must support `alchemy_getAssetTransfers` |
| `MOCK_MODE` | `false` | Serve fixtures instead of live data |
| `DEFAULT_TRACE_DEPTH` | `3` | Hops when `?depth` is omitted |
| `MAX_TRACE_DEPTH` | `5` | Hard ceiling on `?depth` |
| `MAX_FANOUT_PER_ADDRESS` | `12` | Branches followed per wallet |
| `RPC_CONCURRENCY` | `4` | Keep low on the Alchemy free tier |
| `MIN_NATIVE_VALUE` | `0.001` | Dust floor for ETH |
| `MIN_STABLE_VALUE` | `1` | Dust floor for stablecoins |
| `INCLUDE_INTERNAL_TRANSFERS` | `false` | Needs Alchemy's trace API (paid tier) |
| `GRAPH_ENABLED` | `true` | Master switch. `false` runs the service with no database at all |
| `NEO4J_URI` | `neo4j://localhost:7687` | **Bolt port 7687**, not the Browser port 7474 |
| `NEO4J_PASSWORD` | — | Required when `GRAPH_ENABLED=true` |
| `NEO4J_DATABASE` | `neo4j` | Community Edition supports only the default database |
| `GRAPH_BATCH_SIZE` | `500` | Rows per write transaction |
| `GRAPH_AUTO_MIGRATE` | `true` | Apply constraints and indexes automatically |

`MOCK_MODE` exists for demo safety. If venue wifi dies or you exhaust your quota mid-presentation,
flip it to `true` and the trace still runs. The fixture stores **raw Alchemy-shaped payloads**, so
mock mode exercises the same parser as production — a bug in amount or timestamp handling shows up
offline instead of hiding until you are on stage.

---

## Project layout

```
backend/
├── fixtures/
│   └── mock-transfers.json          generated — offline demo dataset
├── scripts/
│   ├── generate-fixtures.js         builds the peeling-chain scenario
│   ├── seed-exchanges.js            loads CEX hot wallets into Neo4j
│   ├── smoke.js                     28 checks — traversal, offline
│   └── smoke-graph.js               38 checks — Cypher and ingestion, no DB needed
└── src/
    ├── server.js                    entry point, graceful shutdown
    ├── app.js                       Express wiring
    ├── config/
    │   ├── env.js                   validated config — fails loudly at boot
    │   ├── assets.js                tracked-asset allowlist per network
    │   └── knownExchanges.js        CEX registry (see warnings above)
    ├── lib/
    │   ├── addresses.js             normalise lowercase / display checksummed
    │   ├── concurrency.js           promise concurrency limiter
    │   ├── logger.js                structured logger
    │   └── retry.js                 exponential backoff + jitter for 429s
    ├── middleware/
    │   ├── errorHandler.js          centralised error → HTTP mapping
    │   └── validateAddress.js       :address and ?depth validation
    ├── routes/
    │   ├── history.routes.js        GET /api/history/:address, /api/config
    │   └── graph.routes.js          GET /api/graph/stats, /api/graph/schema
    └── services/
        ├── provider.js              shared ethers provider + retrying rpcSend
        ├── assetTransfers.js        getAssetTransfers client + normalisation
        ├── walletHistory.service.js fetchWalletHistory — the BFS core
        ├── neo4j.service.js         driver, sessions, managed transactions
        ├── graphSchema.js           constraints and indexes
        └── graph.service.js         ingestToGraph — the Phase 2 core
```

`npm run smoke:graph` deserves a note: it runs the full ingestion path against an in-memory fake Bolt
driver, so it verifies every Cypher statement, the batching arithmetic, the parameter shapes and the
Integer/Float coercion **without Neo4j installed or running**. That last one matters more than it
sounds — a plain JavaScript number is stored by Neo4j as a Float, so a timestamp written carelessly
becomes `1.7356896E9` in the Browser and violates the schema. The test catches it; reading rows by eye
generally does not.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `Invalid configuration - refusing to start` | Missing `ALCHEMY_API_KEY`. Set it, or `MOCK_MODE=true`. |
| `503 UPSTREAM_RPC_UNAVAILABLE` | Alchemy unreachable or rate-limited every retry. Check dashboard quota, lower `RPC_CONCURRENCY`, or use `MOCK_MODE=true`. |
| `408` on a trace | Trace exceeded 90s. Lower `?depth` or `MAX_FANOUT_PER_ADDRESS`. |
| Trace returns 0 transactions | Wallet is inbound-only, freshly created, or holds assets outside the allowlist in `src/config/assets.js`. |
| No exchange found | Increase `?depth`, or extend the exchange registry. |
| `MOCK_MODE=true but fixtures could not be loaded` | Run `npm run seed:fixtures`. |
| Blocked cross-origin request | Add the frontend origin to `CORS_ORIGINS`. |
| `The neo4j-driver package is not installed` | Run `npm install` (or `npm install neo4j-driver`). |
| `NEO4J_PASSWORD is required` at boot | Set it in `.env`, or set `GRAPH_ENABLED=false` to run without the graph. |
| `503 GRAPH_UNAVAILABLE` / `Neo4j is NOT available` | The DBMS is not started. Open Neo4j Desktop and press **Start**. |
| `NEO4J_URI points at port 7474` | That is the Browser port. Use `neo4j://localhost:7687`. |
| `Neo.ClientError.Security.Unauthorized` | Wrong `NEO4J_USER`/`NEO4J_PASSWORD`. The default user is `neo4j`. |
| `DatabaseNotFound` | `NEO4J_DATABASE` is wrong. Community Edition only has `neo4j`. |
| Trace succeeds but the graph stays empty | Check `GET /api/graph/stats` and the trace response's `warnings` — ingestion reports failures there rather than failing the request. |
| `shortestPath` returns nothing in the Browser | No wallet is flagged `isExchange`. Run `npm run seed:exchanges`. |
| Timestamps display as `1.7356896E9` | A Float where an Integer belongs. `npm run smoke:graph` asserts against this; if it passes and you still see it, the row predates the fix — clear it and re-trace. |
