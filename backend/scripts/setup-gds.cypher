// =============================================================================
// scripts/setup-gds.cypher
// =============================================================================
// Neo4j Graph Data Science (GDS) — Graph Projection + Node2Vec Embeddings
//
// PURPOSE
//   This script prepares the CryptoTrace Neo4j graph for machine-learning
//   feature extraction using the GDS library.  Run it manually in the
//   Neo4j Browser (or `cypher-shell`) after the GDS plugin is installed.
//
//   Output: a 64-dimensional float vector stored as `w.embedding` on every
//   Wallet node.  These embeddings capture neighbourhood structure (which
//   wallets cluster together, which are structural bridges) in a form that
//   can be fed directly into a scikit-learn link-prediction classifier.
//
// PRE-REQUISITES
//   1. Neo4j 5.x with the GDS plugin ≥ 2.6 installed and licensed.
//      Community edition covers all algorithms used here.
//   2. At least one `/api/trace/:address` call has run so Wallet nodes and
//      TRANSACTION relationships exist in the database.
//
// EXECUTION ORDER
//   Run each section in sequence.  Sections are separated by blank lines
//   and labelled.  Re-running is safe: DROP is idempotent and the projection
//   is always recreated from the current state of the graph.
// =============================================================================


// -----------------------------------------------------------------------------
// SECTION 1 — Verify GDS is available
// -----------------------------------------------------------------------------
// Expected output: a row containing the GDS version string, e.g. "2.6.4".

RETURN gds.version() AS gdsVersion;


// -----------------------------------------------------------------------------
// SECTION 2 — Drop the projection if it already exists
// -----------------------------------------------------------------------------
// Prevents "graph already exists" errors when re-running this script.
// Safe to run even when the projection does not exist — GDS returns a warning
// instead of an error when the named graph is absent.

CALL gds.graph.drop('cryptoTraceGraph', false)
YIELD graphName
RETURN graphName;


// -----------------------------------------------------------------------------
// SECTION 3 — Project the in-memory graph
// -----------------------------------------------------------------------------
// We project:
//   Nodes  → all :Wallet nodes, carrying riskScore and hop distance as features.
//   Edges  → all :TRANSACTION relationships, weighted by the `amount` property.
//
// NATIVE PROJECTION is used (fastest; GDS reads directly from the store).
// UNDIRECTED orientation is intentional for Node2Vec: the random walk must be
// able to traverse edges in both directions to discover structural communities.
// A directed walk would prevent the algorithm from "backtracking" into the
// exchange vicinity and would produce embeddings blind to the deposit-address
// cluster signature.

CALL gds.graph.project(
  'cryptoTraceGraph',           // ← name used in all subsequent GDS calls
  {
    Wallet: {
      properties: {
        riskScore:       { defaultValue: 0.0 },
        minHopObserved:  { defaultValue: 99.0 },
        isExchange:      { defaultValue: 0.0 }   // GDS properties must be numeric
      }
    }
  },
  {
    TRANSACTION: {
      orientation: 'UNDIRECTED',
      properties: {
        amount: { defaultValue: 0.0 }
      }
    }
  }
)
YIELD
  graphName,
  nodeCount,
  relationshipCount,
  projectMillis;


// -----------------------------------------------------------------------------
// SECTION 4 — Inspect the projected graph (optional sanity check)
// -----------------------------------------------------------------------------

CALL gds.graph.list('cryptoTraceGraph')
YIELD
  graphName,
  nodeCount,
  relationshipCount,
  schema,
  creationTime;


// -----------------------------------------------------------------------------
// SECTION 5 — Run Node2Vec (streaming mode)
// -----------------------------------------------------------------------------
// Node2Vec generates fixed-length vector embeddings for each node by running
// biased random walks and training a Word2Vec–style skip-gram model on them.
//
// KEY PARAMETERS
//   walkLength         ── steps per walk.  20 steps covers a 10-hop laundering
//                         chain twice, giving the model enough structural context.
//   walksPerNode       ── random walks per source node.  10 is the standard
//                         default; higher values improve quality at linear cost.
//   dimensions         ── embedding vector size.  64 is a pragmatic choice:
//                         rich enough to capture neighbourhood diversity, small
//                         enough to avoid the curse of dimensionality for a
//                         dataset of a few thousand wallet nodes.
//   returnFactor  (p)  ── breadth-first bias.  p < 1 encourages the walk to
//                         stay near the source, capturing local structure.
//   inOutFactor   (q)  ── depth-first bias.  q < 1 encourages exploration of
//                         distant neighbourhoods.  We set both p and q slightly
//                         below 1 to balance local (wallet cluster) and global
//                         (path-to-exchange) signals.
//   iterations         ── training epochs.  3 is sufficient for demo scale;
//                         increase for production datasets > 100k nodes.

CALL gds.node2vec.stream(
  'cryptoTraceGraph',
  {
    walkLength:    20,
    walksPerNode:  10,
    dimensions:    64,
    returnFactor:  0.8,
    inOutFactor:   0.6,
    iterations:    3,
    randomSeed:    42           // deterministic output for reproducibility
  }
)
YIELD nodeId, embedding
RETURN
  gds.util.asNode(nodeId).address  AS address,
  embedding
LIMIT 5;                           // ← preview; remove LIMIT to see all


// -----------------------------------------------------------------------------
// SECTION 6 — Write embeddings back to Wallet nodes
// -----------------------------------------------------------------------------
// After verifying the stream output above, run the WRITE variant to persist
// the embeddings as `w.embedding` on each Wallet node.  These can then be
// read by a Python/scikit-learn script for link-prediction training.

CALL gds.node2vec.write(
  'cryptoTraceGraph',
  {
    writeProperty: 'embedding',
    walkLength:    20,
    walksPerNode:  10,
    dimensions:    64,
    returnFactor:  0.8,
    inOutFactor:   0.6,
    iterations:    3,
    randomSeed:    42
  }
)
YIELD
  nodePropertiesWritten,
  computeMillis,
  writeMillis;


// -----------------------------------------------------------------------------
// SECTION 7 — Verify embeddings were written
// -----------------------------------------------------------------------------
// Returns a sample of wallets with their first 5 embedding dimensions.

MATCH (w:Wallet)
WHERE w.embedding IS NOT NULL
RETURN
  w.address          AS address,
  w.riskScore        AS riskScore,
  w.minHopObserved   AS minHop,
  w.isExchange       AS isExchange,
  w.embedding[0..5]  AS embeddingPreview
LIMIT 10;


// -----------------------------------------------------------------------------
// SECTION 8 — Optional: PageRank over the transaction graph
// -----------------------------------------------------------------------------
// PageRank identifies structurally central wallets (those that many paths pass
// through) — a strong signal for mixer detection.
//
// Results are written to `w.pageRank` for use as an additional ML feature.

CALL gds.pageRank.write(
  'cryptoTraceGraph',
  {
    writeProperty:     'pageRank',
    maxIterations:     20,
    dampingFactor:     0.85,
    relationshipWeightProperty: 'amount'
  }
)
YIELD
  nodePropertiesWritten,
  ranIterations,
  computeMillis;


// -----------------------------------------------------------------------------
// SECTION 9 — Optional: Community detection (Louvain)
// -----------------------------------------------------------------------------
// Groups wallets that transact closely together into communities.  A community
// containing both a victim wallet and an exchange node is strong evidence of a
// direct laundering pathway within that cluster.

CALL gds.louvain.write(
  'cryptoTraceGraph',
  {
    writeProperty: 'communityId',
    maxLevels:     10,
    gamma:         1.0
  }
)
YIELD
  nodePropertiesWritten,
  communityCount,
  modularity;


// -----------------------------------------------------------------------------
// SECTION 10 — Clean up (optional)
// -----------------------------------------------------------------------------
// Remove the in-memory projection after you are done to free GDS heap.
// Comment this out if you plan to run further GDS algorithms in the same session.

CALL gds.graph.drop('cryptoTraceGraph')
YIELD graphName
RETURN graphName;
