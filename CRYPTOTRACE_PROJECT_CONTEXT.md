# CryptoTrace — Full Project Context Document
> **For AI assistants working on this codebase.**
> Last updated: 2026-09-26 (Phase 0 UTXO design). Keep this file current when significant changes land.

---

## 1. What This Project Is

**CryptoTrace** is a full-stack blockchain forensics platform built for **SIH 2026**, sponsored by **MHA (Ministry of Home Affairs) / I4C (Indian Cybercrime Coordination Centre)**. The problem statement is:

> *Real-time identification of fraud-linked cryptocurrency exchanges used to launder money from cybercrime victims.*

A cyber-cell investigator enters a victim-reported wallet address. The system traces the flow of funds through the blockchain, identifies intermediary wallets using money-laundering heuristics, finds which exchanges the money reached, generates risk scores, and produces a **legally-formatted affidavit PDF** compliant with Section 65B of the Indian Evidence Act, 1872.

**This is a real investigative tool intended for actual use by cyber police.** Design decisions have legal and evidentiary consequences. Correctness and honest failure modes matter more than features.

---

## 2. Repository Layout

```
sih/version-2/
├── backend/              # Node.js / Express API (primary codebase)
│   ├── src/
│   │   ├── app.js        # Express app factory (no port binding)
│   │   ├── server.js     # Process entry point (port, lifecycle, startup jobs)
│   │   ├── config/
│   │   │   ├── env.js             # All config, validated on startup
│   │   │   ├── knownExchanges.js  # Static CEX address registry
│   │   │   └── assets.js          # Token allowlist per network
│   │   ├── middleware/
│   │   │   ├── apiKey.js          # X-API-Key enforcement
│   │   │   ├── errorHandler.js    # asyncRoute wrapper + global handler
│   │   │   └── validateAddress.js # EVM address format validation
│   │   ├── routes/
│   │   │   ├── trace.routes.js        # GET /api/trace/:address
│   │   │   ├── complaints.routes.js   # POST /api/complaints (case ingestion)
│   │   │   ├── history.routes.js      # GET /api/history/:address
│   │   │   ├── export.routes.js       # POST /api/export/evidence (PDF)
│   │   │   ├── ai.routes.js           # POST /api/ai/* (narrative generation)
│   │   │   ├── crossChain.routes.js   # Cross-chain bridge tracking
│   │   │   └── graph.routes.js        # GET /api/graph/stats|schema
│   │   ├── services/
│   │   │   ├── trace.service.js           # Core Neo4j Cypher trace logic
│   │   │   ├── riskEngine.service.js      # Multi-dimensional risk scoring
│   │   │   ├── sanctions.service.js       # OFAC SDN list screening
│   │   │   ├── oracle.service.js          # CoinGecko price oracle (TTL cache)
│   │   │   ├── neo4j.service.js           # Neo4j driver + schema
│   │   │   ├── aiNarrative.service.js     # Gemini AI narrative generation
│   │   │   ├── assetTransfers.js          # Alchemy asset transfer fetcher
│   │   │   ├── walletHistory.service.js   # Wallet history aggregation
│   │   │   ├── crossChainTracker.service.js # Bridge protocol detection
│   │   │   ├── dexSwapResolver.service.js   # DEX swap identification
│   │   │   ├── multiChainTrace.service.js   # Multi-chain trace orchestration
│   │   │   ├── privacyRiskEngine.service.js # Privacy coin/swap detection
│   │   │   ├── alertEngine.service.js       # WebSocket real-time alerts
│   │   │   ├── audit.service.js             # Action audit logging
│   │   │   ├── realtime.service.js          # WebSocket server setup
│   │   │   ├── progress.service.js          # SSE trace progress streaming
│   │   │   ├── graph.service.js             # Graph persistence (Neo4j writes)
│   │   │   └── provider.js                 # Alchemy RPC provider
│   │   ├── lib/
│   │   │   ├── forceGraph.js    # Trace result → D3 force-graph payload
│   │   │   ├── valuation.js     # approximateUsd() + prefetchPrices()
│   │   │   ├── addresses.js     # normalizeAddress(), toChecksum()
│   │   │   ├── logger.js        # Winston logger
│   │   │   ├── retry.js         # Exponential backoff helper
│   │   │   ├── concurrency.js   # Async concurrency limiter
│   │   │   └── chainProviders.js # Multi-chain RPC resolution
│   │   └── workers/             # Background worker threads
│   ├── scripts/
│   │   └── smoke-trace.js       # Developer smoke-test script
│   ├── fixtures/                # Mock data for MOCK_MODE
│   ├── tests/                   # Unit test suite
│   └── package.json             # ES modules ("type": "module")
│
├── frontend/             # React + Vite frontend
│   └── src/
│       ├── App.jsx               # Main app shell, routing, state
│       ├── components/
│       │   ├── SearchBar.jsx          # Address input + submit
│       │   ├── GraphCanvas.jsx        # D3 force-directed graph
│       │   ├── NodeTooltip.jsx        # Risk details on node hover
│       │   ├── TraceSummary.jsx       # Top-level trace stats
│       │   ├── PathTimeline.jsx       # Hop-by-hop path display
│       │   ├── TraceLoadingPanel.jsx  # SSE progress panel
│       │   ├── AiCopilotDrawer.jsx    # AI narrative side panel
│       │   ├── ExportReportBtn.jsx    # PDF export trigger
│       │   ├── AlertsTray.jsx         # Real-time WebSocket alerts
│       │   ├── CorrelationLookup.jsx  # Cross-case wallet lookup
│       │   ├── StoryTimelineView.jsx  # Narrative timeline view
│       │   ├── WarningBanner.jsx      # Degraded-mode warnings
│       │   └── Layout.jsx / Sidebar.jsx / EmptyState.jsx
│       └── api/                  # Typed API client functions
│
└── ml-service/           # Python FastAPI GNN microservice
    └── app.py            # GATv2 model server + Neo4j ego-graph extractor
```

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js (ES Modules, `"type":"module"`) |
| Backend framework | Express 4 |
| Graph database | Neo4j (Bolt driver) |
| Blockchain RPC | Alchemy SDK (Ethereum mainnet / testnets) |
| ML microservice | Python, FastAPI, PyTorch, PyTorch Geometric (GATv2) |
| Frontend | React 18, Vite, D3.js (force graph) |
| PDF generation | PDFKit (Node.js) |
| Price oracle | CoinGecko public API (no key required) |
| Sanctions feed | OFAC SDN XML list (U.S. Treasury, free/public) |
| Real-time | WebSocket (ws library), Server-Sent Events (SSE) |
| Logging | Winston |
| Auth (current) | Static API key via `X-API-Key` header |

---

## 4. Phase-by-Phase Build History

### Phase 1 — Live Data Ingestion
- Alchemy SDK integration to fetch ERC-20 and native ETH transfer history
- `assetTransfers.js` service wraps Alchemy's `alchemy_getAssetTransfers` with pagination and retry logic
- `walletHistory.service.js` aggregates inbound/outbound transfers per wallet
- Token allowlist in `config/assets.js` prevents unlisted tokens from entering the graph
- `audit.service.js` logs every API action (currently logs raw API key, not investigator name — see Phase 2A caveat)

### Phase 2 — Graph Persistence (Neo4j)
- `graph.service.js` writes `Wallet` nodes and `TRANSACTION` edges into Neo4j
- `graphSchema.js` applies uniqueness constraints and indexes on startup
- `trace.service.js` queries the graph with Cypher `shortestPath` to find money routes from victim wallet to known exchanges
- **Critical design decisions in trace.service.js** (read its header):
  - One shortest path *per reachable exchange* (not one path overall — funds split across venues)
  - Amounts are NOT summed along hops (to avoid double-counting)
  - Temporal consistency check: paths where timestamps go backwards are flagged, not silently accepted
  - Three distinct "no result" states returned: wallet absent, no exchange seeded, no route found

### Phase 2A — Advanced Threat Detection (Partially Complete)
- `crossChainTracker.service.js`: detects bridge protocol interactions (Hop, Across, Stargate, etc.)
- `dexSwapResolver.service.js`: identifies DEX swaps that could convert/hide assets
- `multiChainTrace.service.js`: orchestrates traces across multiple chains
- `privacyRiskEngine.service.js`: detects terminal privacy coin swaps and atomic swaps
- `complaints.routes.js`: case ingestion endpoint; wallets are associated with case IDs in an in-memory cross-case store and Neo4j

**⚠ Phase 2A INCOMPLETE — Read Before Touching Auth or Case Ownership:**
- **Real investigator authentication (JWT/session-backed per-user identity) has NEVER been built.** The system currently uses a static API key (`X-API-Key`). There is no login, no session, no per-investigator identity.
- `req.investigator` on export routes is populated from a hardcoded API-key-to-name map (or falls back to the raw key string). The affidavit PDF's deponent name field is populated from this — it shows the API key, not a real investigator name.
- **Safeguard in place:** Export route has a hard watermark check — if `req.investigator` is absent or looks like a demo key, the PDF is stamped with a large red "DEMO — NOT FOR ACTUAL USE" diagonal watermark.
- **Phase 2A Backlog Item 1:** Real auth (JWT, login endpoint, per-user identity) — prerequisite before any pilot.
- **Phase 2A Backlog Item 2 (Correlation Access Control):** `/api/trace/correlate` returns cross-case references (which other cases a wallet touches) with **zero access control** — any valid API key can see all case overlaps. Real auth needs to gate which cases an investigator can see in correlation results.

### Phase 3 — Risk Scoring, Oracle, Sanctions (Complete)

#### Risk Engine (`riskEngine.service.js`)
The `enrichTraceGraph()` function scores each non-exchange node across 9 independent dimensions:

| # | Dimension | Max pts | Notes |
|---|---|---|---|
| 1 | **Velocity** | 30 | Min delta between inbound and outbound timestamps. <3min=30, <15min=20, <60min=10 |
| 2 | **Fan-out / Peeling Chain** | 30 | 1→N fan with ≥80% value concentration in one arm = PEELING_CHAIN |
| 3 | **Exchange Proximity** | 20 | BFS backwards from known exchanges. Hop1=20 (DIRECT_OFFRAMP), Hop2=12, Hop3=6 |
| 4 | **Taint Diffusion** | 20 | Geometric decay: `20 × 0.70^hop` |
| 5 | **Mixer Pattern** | 20 | Fixed-denomination clustering (0.1/1/10/100 ETH in 24h window) = Tornado Cash signature |
| 6 | **Cross-Chain** | 20 | CROSS_CHAIN_FLIGHT tag from Neo4j |
| 7 | **Privacy Coin** | 40 | Terminal privacy coin/atomic swap |
| 8 | **OTC Broker** | 35 | ML-flagged suspected OTC broker |
| 8B | **Cross-Case / Repeat Offender** | 20+40 | Wallet appears across multiple victim cases |
| 9 | **GNN AI Probability** | 40 | GATv2 model illicit probability |
| **9 (override)** | **OFAC Sanctions** | **HARD** | Not additive — confirmed match forces `riskScore = 100` unconditionally |

Scores sum and are clamped to [0, 100], **except sanctions hits which override the total**.

Each node gets: `riskScore`, `riskFactors[]`, `tags[]`, `riskBreakdown{}`, `sanctionsHit`, `sanctionsScreeningAt`, `sanctionsListAvailable`.

Known canonical tags: `HIGH_VELOCITY_LAYERING`, `PEELING_CHAIN`, `TAINT_DIFFUSION`, `DIRECT_OFFRAMP`, `CASH_OUT`, `MIXER_INTERACTION`, `CROSS_CHAIN_FLIGHT`, `PRIVACY_COIN_FLIGHT`, `SUSPECTED_OTC_BROKER`, `CROSS_CASE_INTERMEDIARY`, `REPEAT_OFFENDER`, `GNN_ILLICIT_HIGH`, `GNN_ILLICIT_MED`, `SANCTIONED_ADDRESS`, `SANCTIONS_CHECK_FAILED`, `UNVERIFIED_EXCHANGE`.

#### Price Oracle (`oracle.service.js` + `lib/valuation.js`)
- `getAssetPriceUsd(symbol)` → async, fetches from CoinGecko public API, 5-minute TTL in-memory cache
- `getCachedPriceUsd(symbol)` → synchronous, reads cache only (used inside tight loops)
- `prefetchPrices(traceResult)` → async, pre-warms cache for all assets in a trace before graph construction; this keeps `forceGraph.js` loops 100% synchronous
- `approximateUsd(transfer)` → synchronous valuation: checks oracle cache → explicit assetClass → symbol inference → config hint fallback
- **NEVER report `approximateUsd` values in the UI as exact figures.** They are for ordering and node sizing only. All fields that use this carry `UsdApprox` in their name.
- Fallback prices if CoinGecko is unreachable: ETH=`config.nativeUsdHint`, BTC=60000, stablecoins=1.0

#### Sanctions Screening (`sanctions.service.js`)
- Fetches OFAC SDN XML from `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml`
- Parses EVM (`0x...`) and BTC addresses via regex (avoids parsing 100MB XML DOM)
- **Sanity check:** if parsed count < 50 addresses → treat as parse failure (format changed), keep previous known-good list
- 24-hour background refresh via `setInterval`
- **Three-state return from `isSanctioned(address)`:**
  - `true` — confirmed OFAC match
  - `false` — list loaded, address clean
  - `null` — list never successfully loaded (cold start / all syncs failed) — callers MUST treat as "unknown", NOT as "clean"
- Case normalization: OFAC parsing lowercases all addresses; `isSanctioned()` lowercases the input — Ethereum checksum casing cannot cause a false negative
- **Startup failure behavior:** fallback seed of 3 known Lazarus Group / Tornado Cash addresses loaded; `isUnavailable` stays `true`; health endpoint reports degraded warning
- `getSanctionsStatus()` → `{ isUnavailable, lastSyncedAt, addressCount }` — used by `/health` and PDF export

---

## 5. API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Dependency status: RPC, Neo4j, sanctions, exchange registry |
| GET | `/api/trace/:address` | API key | Full trace + risk scoring + forceGraph payload |
| GET | `/api/history/:address` | API key | Raw wallet transfer history |
| POST | `/api/complaints` | API key | Ingest a new fraud complaint / case |
| GET | `/api/trace/correlate` | API key | Cross-case wallet correlation lookup (**no access control** — see Phase 2A backlog) |
| POST | `/api/export/evidence` | API key | Generate Section 65B affidavit PDF |
| POST | `/api/ai/narrative` | API key | Generate AI executive summary |
| GET | `/api/graph/stats` | None | Neo4j graph stats |
| GET | `/api/cross-chain/*` | API key | Cross-chain trace endpoints |

### `/api/export/evidence` — PDF Affidavit
**Input:** JSON body containing trace data (nodes array, targetAddress, etc.)
**Output:** `application/pdf` stream — Section 65B compliant affidavit

PDF structure:
1. Court header (blanks for case details)
2. Deponent identification line (investigator name — currently shows API key or map-lookup name)
3. Statements 1–6 (verbatim Section 65B statutory language)
4. **OFAC Sanctions Screening Record** (list sync date, address count, match results or qualified "not found" language)
5. Device particulars (OS type, release, hostname, RAM — from `os` module)
6. First deponent signature block
7. VERIFICATION paragraph
8. Second deponent signature block
9. Red italic DISCLAIMER (legal review advisory)
10. **Red diagonal "DEMO — NOT FOR ACTUAL USE" watermark** if `req.investigator` is absent or demo-looking

---

## 6. ML Microservice (`ml-service/app.py`)

- **Framework:** FastAPI on port 8000
- **Model:** `AdvancedGNN` — a 3-layer GATv2 (Graph Attention Network v2) with 165 input features, 64 hidden channels, 4 attention heads
- **Model file:** `../ml/model_advanced.pth` (relative to `ml-service/`) — loaded on startup
- **Endpoints:**
  - `POST /predict` — accepts `{ x: [[float]*165]*N, edge_index: [[int]*E, [int]*E] }`, returns `{ illicit_probabilities: [float]*N }`
  - `POST /predict/otc-risk` — accepts `{ address: "0x..." }`, extracts 2-hop ego graph from Neo4j, runs `predict_otc_risk()`
- **Auth:** `X-API-Key` header (same key as backend's `INTERNAL_API_KEY`)
- **If model file missing:** `/predict` returns HTTP 503 (graceful degradation — backend catches this and continues without ML scores)
- **Feature vector construction:** done in `riskEngine.service.js` before calling the ML service — 165 floats per node: [time_step, out_degree, in_degree, hop_depth, ...rest zeros]

---

## 7. Key Design Decisions & Non-Obvious Rules

### "Wrong quietly" is the worst failure mode
This principle appears repeatedly. Examples:
- Trace returns distinct error codes for: wallet not in graph / no exchange seeded / no route found
- `isSanctioned()` returns `null` not `false` before the list loads
- OFAC sanity check: < 50 addresses = parse failure, not a valid "small list"
- PDF watermark on demo auth: a document that looks real but isn't is worse than one that's obviously marked

### Amounts are never summed across hops
Summing would count the same money once per hop. `trace.service.js` reports: (a) what landed at the exchange (final transfer), and (b) the bottleneck (smallest transfer on route, which upper-bounds how much of the victim's money traveled the whole way).

### Cross-asset comparisons use `approximateUsd`, never raw amounts
32,500 USDT vs 12 ETH: raw comparison says USDT is 2,700× larger when at any realistic ETH price it's smaller. `approximateUsd()` is for ordering only — never for a reported figure.

### `forceGraph.js` loops are synchronous by design
All async work (`prefetchPrices`, ML calls, Neo4j queries) is completed before `toForceGraph()` is called. This prevents dangling async handles inside tight construction loops. Do not add `await` calls inside `forceGraph.js` node/link loops.

### CORS is not auth
The `X-API-Key` middleware (`apiKey.js`) is the actual access control. CORS only blocks browsers. curl, Postman, server-to-server calls always pass regardless of CORS config.

### Commits are made fresh, never amended
Per standing instruction: every correction is a new commit. Do not use `git commit --amend` or `git push --force` to rewrite history.

### External services: ask before adding paid ones
Standing rule established in this project: before integrating any paid external API (Chainalysis, TRM Labs, Elliptic, etc.), confirm with the user first. The current stack uses only: Alchemy (key required but in `.env`), CoinGecko (free, no key), OFAC (free, no key).

---

## 8. Environment Configuration

Key `.env` variables in `version-2/backend/.env`:

| Variable | Purpose |
|---|---|
| `ALCHEMY_API_KEY` | Alchemy RPC key (required) |
| `API_KEY` | Static API key for `X-API-Key` auth |
| `INTERNAL_API_KEY` | Key used for backend → ML service calls |
| `NEO4J_URI` | Bolt URI (e.g., `bolt://localhost:7687`) |
| `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j credentials |
| `GRAPH_ENABLED` | Set `false` to run without Neo4j (fixture mode) |
| `MOCK_MODE` | Set `true` to serve fixture data instead of live Alchemy calls |
| `ML_SERVICE_URL` | URL of FastAPI ML service (default `http://localhost:8000`) |
| `PORT` | Backend port (default 4000) |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins |
| `NATIVE_USD_HINT` | Fallback ETH price for rough ordering |
| `NETWORK` | `eth-mainnet` / `eth-sepolia` etc. |

---

## 9. What Is NOT Built Yet (Honest Incomplete List)

### Phase 2A (Auth & Ownership) — Active Implementation
1. **Real investigator authentication** — Moving from static API keys to full JWT session auth with bcrypt (cost 12) passwords. A Redis-backed rate limiter protects the login endpoint with per-IP and per-email lockout thresholds.
2. **Session Revocation** — JWTs are short-lived (1 hour), and every authenticated request checks the `isActive` flag in Neo4j for instant revocation of compromised accounts.
3. **Role-Based Access Control (RBAC)** — Three roles exist:
   - **`INVESTIGATOR`**: Can ingest data, run traces, and export affidavits for assigned cases. Can run ad-hoc exploratory traces (`GET /api/trace/:address`), but case assignment is enforced at export time. When an investigator submits `POST /api/complaints/ingest`, the system automatically creates an `[:ASSIGNED_TO]` edge linking the case to them.
   - **`SUPERVISOR`**: Global access. Can run cross-case correlation (`/api/trace/correlate`), assign cases, and manage users.
   - **`AUDITOR`**: Read-only access to assigned cases. Can view and export, but cannot ingest data or modify the graph.
4. **Audit Logging Gap (RESOLVED in Phase 2A)** — Audit logs previously recorded raw API keys. The system now extracts identity directly from the verified JWT session context, securely recording the `req.investigator.id` and `name` for every logged action.

---

## 10. Running the Project

```bash
# Backend
cd version-2/backend
npm install
npm run dev          # node --watch src/server.js, port 4000

# Frontend
cd version-2/frontend
npm install
npm run dev          # Vite dev server, port 5173

# ML Microservice
cd version-2/ml-service
pip install -r requirements.txt
uvicorn app:app --reload --port 8000

# Neo4j: run separately (Desktop or Docker)
# Default: bolt://localhost:7687
```

---

## 11. Recent Change Log (for context continuity)

| Date | Commit | What |
|---|---|---|
| 2026-09-26 | `feat(btc-phase1)` | UTXO tracing Phase 1: Neo4j BTC schema + Mempool.space ingestion service |
| 2026-09-26 | `docs(btc-phase0)` | UTXO tracing Phase 0: indexer decision, Neo4j schema proposal, coexistence design documented |
| 2026-09-26 | `test(riskEngine)` | riskEngine.test.js now mocks sanctions service with explicit clean state; removes incidental cold-start dependency |
| 2026-09-26 | `test(sanctions)` | Fix case-insensitivity test to cover real Set.has() path; extend `__resetForTests()` with seedAddresses/simulateLoaded |
| 2026-09-26 | `test(sanctions)` | Eliminate conditional skips; add `__resetForTests()` test-only hook (guarded NODE_ENV) |
| 2026-09-26 | `test(sanctions)` | Add cold-start regression tests (sanctions.coldstart.test.js + sanctions.service.unit.test.js) |
| 2026-09-26 | `feat(sanctions)` | Wired OFAC SDN sanctions screening end-to-end: startup job, /health reporting, risk engine Dimension 9 (hard override), PDF export OFAC section |
| 2026-09-26 | `fix(sanctions)` | `isSanctioned()` cold-start silent false-negative: now returns `null` on unavailable list |
| 2026-09-26 | Price oracle integration | CoinGecko oracle + TTL cache; `prefetchPrices()` pre-warms before graph construction |
| 2026-09-26 | Risk engine mixer detection | Dimension 5: fixed-denomination clustering (Tornado Cash signature) |
| 2026-09-26 | PDF affidavit | Section 65B affidavit PDF; DEMO watermark safeguard; device particulars |
| Earlier | Cross-case correlation | In-memory + Neo4j cross-case wallet store; REPEAT_OFFENDER scoring |
| Earlier | GNN ML service | FastAPI + GATv2 model; OTC broker detection; graceful 503 degradation |
| Earlier | Phase 2A services | crossChainTracker, dexSwapResolver, multiChainTrace, privacyRiskEngine |
| Earlier | Core trace + graph | Neo4j ingestion, shortestPath Cypher, forceGraph payload, D3 frontend |

---

## 12. Bitcoin / UTXO Tracing — Phase 0 Design

> **Status: Design complete (Phase 0). Implementation not started (Phases 1–6 pending greenlight).**

---

### 12.1 Why UTXO Is Architecturally Different

All existing EVM tracing code assumes the **account model**: wallets have balances, transactions move value between two addresses, and a Neo4j `(:Wallet)-[:TRANSACTION]->(:Wallet)` edge is a natural fit.

Bitcoin uses the **UTXO (Unspent Transaction Output) model**:
- A transaction **consumes** one or more existing outputs (inputs) and **creates** one or more new outputs.
- An "address" never holds a balance — it holds a set of unspent outputs, each with a discrete satoshi value.
- The same entity routinely controls dozens of addresses (one per receive, one per change). Without clustering, tracing stops at the first hop because the change address looks like a new, unknown party.
- Summing inputs/outputs within a transaction is straightforward; tracing *across* transactions requires following output→spending-tx→new-output chains, not address→address edges.

This means:
- The EVM `shortestPath((start)-[:TRANSACTION*1..15]->(exchange))` Cypher cannot be reused directly — the graph shape is different.
- The EVM risk engine's velocity/fan-out calculations read `inboundTransfers` / `outboundTransfers` arrays; UTXO nodes need an analogous structure.
- The EVM `knownExchanges.js` contains `0x...` Ethereum addresses; BTC exchange addresses are `1...` / `3...` / `bc1...` format and must live in a separate registry.

---

### 12.2 Indexer Decision: Mempool.space API

**Chosen: [Mempool.space public API](https://mempool.space/docs/api/rest)**

**Rationale:**

| Option | Cost | Key required | Full UTXO history | Rate limit | Verdict |
|---|---|---|---|---|---|
| Mempool.space API | Free | No | Yes | ~10 req/s (generous) | ✅ **Chosen** |
| Blockstream Esplora API | Free | No | Yes | ~5 req/s | ✅ Viable fallback |
| BlockCypher | Free tier | No | Yes | 3 req/s, 200/hr | ⚠ Tight for multi-hop |
| Blockchain.info | Free | No | Partial | Rate-limited | ⚠ Less reliable |
| Chainalysis / TRM | Paid | Yes | Yes | High | ❌ Not without asking |
| Self-hosted bitcoind | Free | No | Full node | Local only | ❌ Overkill for SIH |

Mempool.space matches the **existing "free/public first" pattern** (CoinGecko for prices, OFAC for sanctions). It provides:
- `GET /api/address/{address}/txs` — full confirmed tx history, paginated
- `GET /api/tx/{txid}` — full transaction including all inputs and outputs with values
- `GET /api/address/{address}/utxo` — current unspent outputs

Blockstream Esplora has an identical API surface (Mempool.space is a fork of it) — if Mempool.space is down, swapping the base URL in `.env` is the entire migration.

**Configuration:** `BTC_INDEXER_URL` in `.env`, defaulting to `https://mempool.space/api`. The service must gracefully degrade (explicit error state, never silent false) if the indexer is unreachable — same discipline as the OFAC sync and Alchemy RPC.

---

### 12.3 Neo4j Schema Addition

All BTC labels use a `Btc` prefix to ensure **zero collision** with existing `Wallet` / `TRANSACTION` EVM labels. Both graphs coexist in the same Neo4j instance.

#### Node labels

| Label | Key property | Description |
|---|---|---|
| `BtcAddress` | `address` (unique) | A Bitcoin address (P2PKH / P2SH / Bech32). May own multiple outputs. |
| `BtcOutput` | `outputId` = `"{txid}:{vout}"` (unique) | One discrete UTXO. Carries `valueSats`, `address`, `spent` flag. |
| `BtcTransaction` | `txid` (unique) | A confirmed Bitcoin transaction. Carries `blockHeight`, `blockTime`. |
| `BtcCluster` | `clusterId` (unique) | A set of addresses inferred to be controlled by the same entity via common-input-ownership heuristic (Phase 2). |

#### Relationship types

| Relationship | Direction | Description |
|---|---|---|
| `(:BtcAddress)-[:OWNS]->(:BtcOutput)` | Address → Output | This address controls this UTXO |
| `(:BtcTransaction)-[:HAS_OUTPUT]->(:BtcOutput)` | Tx → Output | This tx created this output |
| `(:BtcOutput)-[:SPENT_BY]->(:BtcTransaction)` | Output → Tx | This output was consumed by this tx |
| `(:BtcAddress)-[:BELONGS_TO]->(:BtcCluster)` | Address → Cluster | Address is a member of this cluster (written by Phase 2) |
| `(:BtcCluster)-[:SENT_TO]->(:BtcCluster)` | Cluster → Cluster | Funds flowed between clusters (materialized by Phase 2 for fast trace queries) |

#### Cypher constraint/index script (additive, `IF NOT EXISTS` everywhere)

```cypher
// --- BtcAddress ---
CREATE CONSTRAINT btc_address_unique IF NOT EXISTS
  FOR (a:BtcAddress) REQUIRE a.address IS UNIQUE;

// --- BtcOutput ---
CREATE CONSTRAINT btc_output_unique IF NOT EXISTS
  FOR (o:BtcOutput) REQUIRE o.outputId IS UNIQUE;

CREATE INDEX btc_output_spent IF NOT EXISTS
  FOR (o:BtcOutput) ON (o.spent);           -- fast "find unspent outputs"

CREATE INDEX btc_output_address IF NOT EXISTS
  FOR (o:BtcOutput) ON (o.address);         -- fast "find all outputs for address"

// --- BtcTransaction ---
CREATE CONSTRAINT btc_tx_unique IF NOT EXISTS
  FOR (t:BtcTransaction) REQUIRE t.txid IS UNIQUE;

CREATE INDEX btc_tx_blockheight IF NOT EXISTS
  FOR (t:BtcTransaction) ON (t.blockHeight);

CREATE INDEX btc_tx_blocktime IF NOT EXISTS
  FOR (t:BtcTransaction) ON (t.blockTime);  -- temporal consistency checks

// --- BtcCluster ---
CREATE CONSTRAINT btc_cluster_unique IF NOT EXISTS
  FOR (c:BtcCluster) REQUIRE c.clusterId IS UNIQUE;

CREATE INDEX btc_cluster_is_exchange IF NOT EXISTS
  FOR (c:BtcCluster) ON (c.isExchange);     -- shortestPath target, same role as wallet_is_exchange
```

**Why `outputId = "{txid}:{vout}"` and not just `txid` on BtcOutput?**
The same transaction creates multiple outputs (vout 0, vout 1, …). Without the vout discriminator, the first output would MERGE correctly and subsequent ones would silently overwrite it — a data-loss bug directly analogous to the EVM `hash` uniqueness issue documented in `graphSchema.js`'s header comment. The composite `outputId` is the UTXO equivalent of `uniqueId` on EVM TRANSACTION edges.

**Testing Caveat:** Full Cypher-semantics coverage (e.g. proving `spent=true` is never incorrectly reset to `false` when a creating transaction is ingested after a spending one) requires a live Neo4j database. Because local tests and CI currently lack a standing Neo4j instance, these integration tests are deferred. The unit test suite currently enforces this asymmetry by regex-asserting against the Cypher string itself (Option B).

---

### 12.4 Coexistence with the EVM Graph

Both graphs share one Neo4j instance. Isolation is by label prefix:
- EVM queries address `Wallet` and `TRANSACTION` only.
- BTC queries address `BtcAddress`, `BtcOutput`, `BtcTransaction`, `BtcCluster` only.
- No cross-label relationships exist (a `BtcAddress` is never merged with a `Wallet` node).
- The `/health` endpoint will report both EVM graph status (existing) and BTC indexer status (new — added in Phase 5).
- `applyGraphSchema()` in `graphSchema.js` will be extended with the BTC constraints/indexes using the same `SCHEMA_STATEMENTS` array and `IF NOT EXISTS` idempotency pattern.

---

### 12.5 Key Design Decisions for UTXO Tracing

These match the style of §7 (Key Design Decisions) — decisions worth knowing because they're non-obvious and getting them wrong causes silent failures.

**Amounts are never summed across hops (same rule as EVM, different reason).**
In EVM, summing double-counts because the same value passes through each hop. In UTXO, each output has a discrete satoshi value, so double-counting is less of a risk — but summing is still wrong because a transaction typically pays change back to the sender. Reporting the total output value of a transaction overstates what the receiver got. Report: the value of the specific output that continued toward the exchange (the "forward" UTXO), and the smallest-value UTXO on the route (the bottleneck), same as EVM.

**Common-input-ownership heuristic is a probabilistic inference, not a fact.**
If inputs A and B are spent in the same transaction, they are *presumed* to be controlled by the same entity (because you need the private key for each to sign the tx). This is the most effective address-clustering heuristic available without data from exchanges, but it has a known primary defeat case: CoinJoin. In a CoinJoin transaction, multiple independent parties co-sign a single transaction intentionally — the heuristic produces a false cluster. The system must detect and exclude CoinJoin transactions (see Phase 2 design) rather than silently producing wrong clusters. This limitation must appear in exported reports.

**CoinJoin detection is a heuristic, not a guarantee.**
The standard detection approach implemented in Phase 2: a transaction with ≥ 3 inputs and *at least* 3 equal-value outputs is flagged as a probable CoinJoin. Note the trade-off here: this is an "N-of-many" approach (not requiring *all* outputs to be equal), meaning it correctly detects CoinJoins that include change outputs, but risks false-flagging legitimate equal-payment transactions (like payroll/batch payouts) as CoinJoins. Flagging it as `PROBABLE_COINJOIN` (not `CONFIRMED_COINJOIN`) in the graph and in the risk engine is the honest representation. The flag feeds the mixer dimension of the risk engine.

**Cluster ID determinism is explicitly guaranteed.**
When clusters are merged via the common-input heuristic, the survivor cluster is always the one with the lexicographically smallest `clusterId` (which originates from the lowest-sorted BTC address in the cluster). This guarantees that repeated clustering runs over the same graph produce identical `clusterId` assignments, preventing silent cascading ID changes for downstream modules (Phase 3-5).

**Three distinct "no result" states (mirrors EVM trace.service.js discipline).**
- `BTC_ADDRESS_NOT_IN_GRAPH` — address was never ingested; re-ingest first.
- `NO_BTC_EXCHANGE_SEEDED` — BTC exchange registry is empty; seed it first.
- `NO_ROUTE_FOUND` — address is in the graph, exchanges are seeded, genuinely no path exists.
Collapsing these to an empty result is the "wrong quietly" failure mode. Each returns a distinct reason + hint.

**SENT_TO edges are persisted by Phase 2, not computed live.**
The `(:BtcCluster)-[:SENT_TO]->(:BtcCluster)` edge abstracts the underlying UTXO chain (`Cluster<-Address-Output-Tx-Output-Address->Cluster`). 
*Trade-off*: Materializing this edge in Phase 2 makes Phase 3's `shortestPath` trace query as simple and fast as the EVM equivalent. The cost is a staleness/invalidation burden: if a newly ingested transaction merges two previously distinct clusters, Phase 2 must explicitly manage and rewrite the affected `SENT_TO` edges. We accept this trade-off because computing the route live at trace-time across a 5-hop repeating UTXO pattern makes Neo4j's native `shortestPath()` unusable (requiring expensive APOC path expansion) and severely degrades trace performance.

**UTXO hop resolution is chronological, not value-based.**
When Phase 3 expands a `SENT_TO` edge back into an underlying transaction (to surface the hash, amount, and timestamp), it explicitly selects the *earliest* transaction chronologically (`ORDER BY blockTime ASC LIMIT 1`) between the two clusters. It has no connection to the traced value. **Known Limitation for Phase 5 (Export):** The exported affidavit evidence must not imply this single surfaced transaction is "the" complete money-laundering transfer between the clusters. It is simply the first chronological proof that funds flowed between them; other later or larger transactions between the same two clusters may exist but are hidden by this edge abstraction.

**Sanctions screening only checks the representative cluster ID.**
In Phase 4, `riskEngine.service.js` calls `isSanctioned(node.id)`. For BTC clusters, `node.id` is the `clusterId` (the lexicographically smallest address in the cluster). While this means OFAC screening *is* live and exercised for BTC, it is a **Known Limitation** that it currently does not check the other addresses grouped into that cluster. If a sanctioned address exists in a cluster but is not the `clusterId`, the risk engine will miss the OFAC hit.

**BTC exchange registry is separate from EVM `knownExchanges.js`.**
Address formats differ (EVM `0x...` vs BTC `1...`/`3...`/`bc1...`), attribution sources differ (Etherscan vs blockchain.com/Bitref/OXT), and the exchange deposit wallet structure differs (BTC exchanges typically use many P2SH or Bech32 deposit addresses, not a small number of hot wallets). Merging them would create a type-unsafe registry that requires address-format branching throughout the code. New file: `config/knownBtcExchanges.js`, same structure as the existing file.

**Sanctions screening already covers BTC addresses.**
`sanctions.service.js` parses BTC addresses from the OFAC XML using a BTC-specific regex alongside the EVM regex. The `isSanctioned()` function does a plain string lookup — it works for any address format. Once BTC ingestion exists and BTC nodes pass through the risk engine, this path will be exercised automatically. No sanctions code changes are needed in Phase 4 — but the path must be *confirmed* to actually execute for BTC nodes, not assumed.

**BTC valuation uses existing oracle infrastructure.**
CoinGecko already covers BTC (`SYMBOL_TO_COINGECKO_ID.BTC = 'bitcoin'`). The oracle service and `approximateUsd()` already handle BTC natively. UTXO values are in satoshis internally; conversion to BTC is `valueSats / 1e8` before passing to `approximateUsd()`. The "never report approximateUsd as an exact figure" rule applies to BTC values identically — they are for node ordering and sizing only, never for evidentiary reporting.

---

### 12.6 Phase Roadmap Summary

| Phase | Status | Deliverable |
|---|---|---|
| **Phase 0** | ✅ Design complete | Indexer decision, schema, coexistence design (this section) |
| **Phase 1** | ✅ Complete | `btcSchema.js` (constraints/indexes), `btcIngestion.service.js`, unit tests |
| **Phase 2** | ✅ Complete | Common-input-ownership clustering, CoinJoin detection, cluster writes to Neo4j, tests |
| **Phase 3** | ✅ Complete | `btcTrace.service.js` (shortestPath on UTXO graph), `knownBtcExchanges.js`, tests |
| **Phase 4** | ✅ Complete | Risk engine BTC path, sanctions confirmation, valuation, tests |
| **Phase 5** | ✅ Complete | API routes, `/health` BTC indexer status, Section 65B PDF BTC section |
| **Phase 6** | ⬜ Not started | Frontend wiring (reuse where D3 graph generalizes, diverge where it doesn't) |
