import { logger } from '../lib/logger.js';

/**
 * OFAC SDN List Sanctions Service
 * Pulls and parses the digital currency addresses from the OFAC Specially Designated Nationals list.
 */

let sanctionedAddresses = new Set();
let lastSyncedAt = null;
let isUnavailable = true;

const OFAC_XML_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml';

// Fallback seed list for testing / extreme degraded mode if OFAC is permanently unreachable.
// Contains a few known OFAC-sanctioned Lazarus Group / Tornado Cash addresses.
const FALLBACK_SEED = [
  '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c', // Lazarus Group
  '0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a', // Lazarus Group
  '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc'  // Tornado Cash router
];

/**
 * Synchronizes the internal set with the latest OFAC SDN list.
 */
export async function syncOfacList() {
  logger.info('[Sanctions] Starting OFAC SDN list sync...');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for 100MB XML
    
    const response = await fetch(OFAC_XML_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CryptoTrace-Node/1.0' }
    });
    
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from OFAC`);
    }

    const text = await response.text();
    
    // OFAC XML contains crypto addresses in <FeatureValue> tags (and some text blocks).
    // Extract EVM and BTC style addresses directly via Regex to avoid huge XML parsing overhead.
    const evmRegex = /0x[a-fA-F0-9]{40}/g;
    const btcRegex = /\b(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{39,59})\b/g;

    const newSet = new Set();
    
    let match;
    while ((match = evmRegex.exec(text)) !== null) {
      newSet.add(match[0].toLowerCase());
    }
    while ((match = btcRegex.exec(text)) !== null) {
      newSet.add(match[0].toLowerCase());
    }

    // Parsing Fragility Check: 
    // The OFAC list currently contains several hundred crypto addresses.
    // If the regex strategy breaks due to an XML structure change, it will return 0 or very few.
    if (newSet.size < 50) {
      throw new Error(`Sanity check failed: Parsed only ${newSet.size} addresses. OFAC format likely changed.`);
    }

    // Success
    sanctionedAddresses = newSet;
    lastSyncedAt = new Date().toISOString();
    isUnavailable = false;
    
    logger.info(`[Sanctions] Successfully synced ${sanctionedAddresses.size} addresses from OFAC.`);

  } catch (err) {
    logger.error(`[Sanctions] OFAC sync failed: ${err.message}`);
    
    // If this is the first boot and it failed, load the fallback seed just so we have *something*
    // but keep it marked as unavailable / stale.
    if (sanctionedAddresses.size === 0) {
      FALLBACK_SEED.forEach(a => sanctionedAddresses.add(a.toLowerCase()));
      isUnavailable = true; // explicitly mark degraded mode
      logger.warn('[Sanctions] Server started in DEGRADED MODE (Sanctions unavailable). Seeded minimal fallback list.');
    } else {
      logger.warn('[Sanctions] Keeping previous known-good list due to sync failure.');
    }
  }
}

/**
 * Periodically refreshes the list (every 24 hours).
 */
export function startSanctionsSyncJob() {
  // Sync immediately on startup
  syncOfacList().catch(err => logger.error(err));
  
  // And every 24 hours
  setInterval(() => {
    syncOfacList().catch(err => logger.error(err));
  }, 24 * 60 * 60 * 1000);
}

/**
 * Checks if a given address is on the OFAC SDN list.
 *
 * Returns:
 *   true   — confirmed match on the list
 *   false  — list loaded, address not found
 *   null   — list has never successfully loaded (cold start / all syncs failed);
 *            callers MUST treat null as 'unknown', NOT as 'clean'
 *
 * @param {string} address The wallet address to check.
 * @returns {boolean | null}
 */
export function isSanctioned(address) {
  if (!address) return false;
  // If isUnavailable is still true AND the set only contains the fallback seed
  // (or is empty), we have never completed a real sync — return null so the
  // caller can surface an 'unknown' state rather than a silent false negative.
  if (isUnavailable) return null;
  return sanctionedAddresses.has(address.toLowerCase());
}

/**
 * Gets the status of the sanctions oracle for PDF/UI reporting.
 */
export function getSanctionsStatus() {
  return {
    isUnavailable,
    lastSyncedAt,
    addressCount: sanctionedAddresses.size
  };
}

/**
 * TEST-ONLY: reset internal state and optionally simulate a loaded list.
 *
 * With no arguments (or an empty options bag) this is identical to the
 * cold-start state — same as a fresh module import before any sync has run.
 *
 * Passing `seedAddresses` + `simulateLoaded: true` lets a test exercise the
 * post-sync code path (real Set.has() lookups, case normalisation) without
 * making any network call to OFAC:
 *
 *   __resetForTests({
 *     seedAddresses: ['0xDeAdBeEf...'],
 *     simulateLoaded: true,
 *   });
 *   isSanctioned('0xdeadbeef...'); // => true  (hits Set.has())
 *   isSanctioned('0xUnrelated');   // => false (hits Set.has(), not found)
 *
 * Addresses in seedAddresses are lowercased on write, exactly as syncOfacList()
 * does, so the write-path normalisation is exercised by the hook itself and the
 * read-path normalisation is exercised by isSanctioned() in the calling test.
 *
 * Guarded: throws when NODE_ENV !== 'test'. Cannot be reached from production.
 *
 * Naming convention (__reset*) matches __resetValuationCache() in this codebase.
 *
 * @param {{ seedAddresses?: string[], simulateLoaded?: boolean }} [opts]
 */
export function __resetForTests({ seedAddresses = [], simulateLoaded = false } = {}) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      '__resetForTests() must only be called in NODE_ENV=test. ' +
      'This function clears the live OFAC sanctions list and must never run in production.'
    );
  }
  // Always start from a clean slate.
  sanctionedAddresses = new Set();

  if (seedAddresses.length > 0) {
    // Mirror exactly what syncOfacList() does: lowercase on write.
    seedAddresses.forEach(a => sanctionedAddresses.add(a.toLowerCase()));
  }

  if (simulateLoaded) {
    // Simulate a completed sync: mark the list as available.
    isUnavailable = false;
    lastSyncedAt = new Date().toISOString();
  } else {
    isUnavailable = true;
    lastSyncedAt = null;
  }
}
