/**
 * scripts/test-cross-chain.js
 * ---------------------------------------------------------------------------
 * Test script for Module 1: Cross-Chain Bridge Correlation Engine.
 *
 * Exercises:
 *   1. POST /api/cross-chain/deposit   (Cache pending bridge deposit)
 *   2. POST /api/cross-chain/reconcile (Match withdrawal using temporal-value heuristic)
 *   3. GET /api/cross-chain/bridges   (Query resulting BRIDGED_TO edges in Neo4j)
 *
 * Usage:
 *   node scripts/test-cross-chain.js
 */

import { config } from '../src/config/env.js';

const API_BASE = `http://localhost:${config.port || 4001}`;
const API_KEY = config.internalApiKey || 'local-dev-key-12345';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
};

async function runTest() {
  console.log('================================================================');
  console.log('   CryptoTrace - Cross-Chain Correlation Test Suite');
  console.log('================================================================\n');

  // Test Case Payload
  const depositPayload = {
    sourceChain: 'ETH-Mainnet',
    sourceTxHash: '0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
    walletAddress: '0x8b4EC26384BF34B9A81D412A40913dcB107038b8',
    bridgeProtocol: 'Thorchain',
    usdValue: 31500.0, // 10.5 ETH @ $3,000
  };

  const withdrawalPayload = {
    targetChain: 'Solana',
    targetTxHash: '5K3w2m4n9P7q1r8s2t3u4v5w6x7y8z9a0b1c2d3e',
    recipientAddress: '0x9b5be60e8b99e66bba942bae82f444dfbffed8d6',
    bridgeProtocol: 'Thorchain',
    targetUsdValue: 31185.0, // 1% bridge fee slippage -> 0.99 ratio (valid!)
  };

  // STEP 1: Cache Pending Deposit
  console.log('STEP 1: Caching Pending Bridge Deposit on Source Chain (ETH)...');
  const depRes = await fetch(`${API_BASE}/api/cross-chain/deposit`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(depositPayload),
  });
  const depData = await depRes.json();
  console.log('Response:', depData);
  if (!depData.ok) throw new Error('Deposit caching failed!');

  // STEP 2: Reconcile Cross-Chain Withdrawal
  console.log('\nSTEP 2: Reconciling Cross-Chain Withdrawal on Target Chain (Solana)...');
  const recRes = await fetch(`${API_BASE}/api/cross-chain/reconcile`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(withdrawalPayload),
  });
  const recData = await recRes.json();
  console.log('Response:', recData);
  if (!recData.ok || !recData.reconciled) {
    throw new Error('Withdrawal reconciliation failed!');
  }

  // STEP 3: Query Neo4j for BRIDGED_TO Relationships
  console.log('\nSTEP 3: Querying Neo4j Graph for BRIDGED_TO relationships...');
  const bridgeRes = await fetch(`${API_BASE}/api/cross-chain/bridges`, {
    headers: HEADERS,
  });
  const bridgeData = await bridgeRes.json();
  console.log('Bridges in Graph:', JSON.stringify(bridgeData, null, 2));

  console.log('\n================================================================');
  console.log('SUCCESS: Cross-Chain Bridge Correlation engine verified cleanly!');
  console.log('================================================================\n');
}

runTest().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
