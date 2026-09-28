/**
 * services/aiNarrative.service.js
 * ---------------------------------------------------------------------------
 * PHASE 4: Generative AI Case Summarisation & Copilot
 *
 * Wraps the Google Gemini API (`@google/genai`).  All public functions:
 *
 *   generateCaseBrief(traceData)
 *     Takes the full enriched trace result and returns a structured,
 *     plain-English forensic executive summary.  Output is a parsed JS object:
 *
 *       {
 *         executiveSummary: string,          // 2-3 sentences for non-technical officers
 *         modusOperandi:   string[],         // Step-by-step laundering technique
 *         actionableNextSteps: string,       // Single paragraph for investigators
 *         cashOutEntity: {
 *           exchange:          string,
 *           depositAddress:    string,
 *           estimatedAmountUSD: string,
 *           lastHopTime:       string,
 *         },
 *         subpoenaNotice: string,            // Draft legal preservation notice
 *       }
 *
 *   handleCopilotChat(traceContext, userQuery, chatHistory)
 *     Stateless conversational turn; history is maintained by the caller.
 *
 * ---------------------------------------------------------------------------
 * RESILIENCE CONTRACTS
 * ---------------------------------------------------------------------------
 *   • If the Gemini API times out (> LLM_TIMEOUT_MS) the function resolves
 *     with a best-effort stub rather than throwing.  The calling route layer
 *     logs this at WARN and includes `aiNarrative.ok: false` in the response,
 *     so the rest of the payload (forceGraph, riskEngine) is still delivered.
 *
 *   • MOCK_MODE === true returns a deterministic stub immediately (no API call)
 *     so the endpoint works end-to-end in a dev environment without an API key.
 *
 *   • JSON parse errors fall back to returning the raw text in `executiveSummary`
 *     rather than throwing.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time to wait for a Gemini response before failing open. */
const LLM_TIMEOUT_MS = 45_000;

/** Gemini model name used for both endpoints. */
const MODEL = 'gemini-3.6-flash';

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _ai = null;

function getAI() {
  if (_ai) return _ai;
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables.');
  }
  _ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return _ai;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Race an async call against a timeout.  Resolves with `{ ok, value }` rather
 * than throwing so callers can always continue.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: string }>}
 */
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM request timed out after ${ms}ms`)), ms);
  });

  try {
    const value = await Promise.race([promise, timeout]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to parse a JSON response from the LLM, which may be wrapped in markdown
 * fences (```json ... ```) despite asking for application/json.
 *
 * @param {string} raw
 * @returns {object}
 */
function safeParseJson(raw) {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // If the model returned prose instead of JSON, surface it gracefully.
    return { executiveSummary: stripped };
  }
}

/**
 * Build a condensed, token-efficient summary of the trace for the prompt.
 * Sending the full forceGraph (with duplicate riskBreakdown objects) is noisy;
 * this produces a compact representation that fits comfortably in flash's window.
 *
 * @param {object} traceData
 * @returns {string}
 */
function buildTraceContext(traceData) {
  const fg = traceData?.forceGraph ?? {};
  const nodes = (fg.nodes ?? []).filter((n) => n.onPath || n.isExchange);
  const links = (fg.links ?? []).filter((l) => l.onPath);

  const paths = (traceData?.paths ?? []).map((p, i) => ({
    route: i + 1,
    hops: p.hops,
    exchange: p.exchange?.exchange ?? 'Unknown Exchange',
    exchangeLabel: p.exchange?.label ?? null,
    totalValueUsd: p.valueUsdApprox ?? null,
  }));

  const flaggedNodes = nodes
    .filter((n) => n.tags?.length > 0 && !n.isExchange)
    .map((n) => ({
      address: n.addressDisplay,
      hop: n.hop,
      riskScore: n.riskScore,
      tags: n.tags,
      riskFactors: n.riskFactors,
    }));

  const topExchange = traceData?.topExchange ?? null;

  return JSON.stringify(
    {
      query: traceData?.query,
      summary: {
        pathsFound: paths.length,
        shortestHops: traceData?.shortestHops ?? null,
        topExchange,
      },
      paths,
      flaggedNodes,
      linkCount: links.length,
      fraudType: traceData?.fraudType ?? 'Unknown',
    },
    null,
    2
  );
}

/**
 * Stub result for MOCK_MODE or when the LLM is unavailable.
 *
 * @param {string} [reason]
 * @returns {object}
 */
function stubBrief(reason = 'MOCK_MODE') {
  return {
    ok: false,
    skipped: true,
    reason,
    brief: {
      executiveSummary:
        '[AI generation skipped] Funds were traced through a series of intermediary wallets ' +
        'exhibiting high-velocity layering before reaching a known exchange deposit address.',
      modusOperandi: [
        'Source wallet initiates transfer.',
        'Funds pass through one or more rapid-turnover wallets.',
        'Funds reach a CEX deposit address for cash-out.',
      ],
      actionableNextSteps:
        'Submit a legal preservation notice to the identified exchange operator. ' +
        'Request KYC records associated with the deposit address.',
      cashOutEntity: {
        exchange: 'See forceGraph exchangesFound',
        depositAddress: 'N/A',
        estimatedAmountUSD: 'N/A',
        lastHopTime: 'N/A',
      },
      subpoenaNotice: '[Draft subpoena not generated — AI service unavailable or skipped.]',
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a structured forensic case brief for the trace.
 *
 * Returns `{ ok, brief, durationMs }` — never throws.
 *
 * @param {object} traceData  The enriched trace result (forceGraph + paths + etc.)
 * @returns {Promise<{ ok: boolean, brief: object, durationMs: number, reason?: string }>}
 */
export async function generateCaseBrief(traceData) {
  if (config.mockMode) {
    logger.info('[aiNarrative] MOCK_MODE — returning stub brief.');
    return stubBrief('MOCK_MODE');
  }

  let ai;
  try {
    ai = getAI();
  } catch (err) {
    logger.warn('[aiNarrative] Cannot initialise Gemini client', { error: err.message });
    return stubBrief(err.message);
  }

  const context = buildTraceContext(traceData);

  const prompt = `
You are a senior cybercrime forensic analyst advising a law-enforcement financial-intelligence unit.

You have been given a structured summary of a live cryptocurrency trace.
The trace followed illicit funds from a victim-reported Ethereum wallet through a network of
pass-through wallets and identified the likely cash-out point at a centralised exchange (CEX).

## Trace Data
${context}

The reported fraud type is: ${traceData?.fraudType || 'Unknown'}.
Adjust your tone and urgency accordingly (e.g., cases of sextortion/ransomware require immediate action and sensitivity, while investment scams follow routine procedures).

## Instructions
Produce a response in **strict JSON** with the following exact keys. Do not add extra keys or wrap in markdown.

{
  "executiveSummary": "2–3 plain-English sentences explaining what happened, suitable for a non-technical police officer or magistrate.",
  "modusOperandi": [
    "Step-by-step explanation of the laundering technique observed.",
    "Each element should be a complete sentence."
  ],
  "actionableNextSteps": "A single paragraph describing the immediate investigative steps, including which exchange to contact and what to request.",
  "cashOutEntity": {
    "exchange": "Name of the exchange operator",
    "depositAddress": "The terminal deposit address (0x...)",
    "estimatedAmountUSD": "Approximate USD value that reached the exchange",
    "lastHopTime": "ISO-8601 timestamp of the final transfer, or 'Unknown'"
  },
  "subpoenaNotice": "A formal draft of a Law Enforcement Preservation / Disclosure Notice, including the deposit address, requesting KYC records (name, ID, residential address, linked bank accounts) from the exchange operator under applicable jurisdiction."
}
`.trim();

  const t0 = Date.now();
  try {
    const result = await withTimeout(
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      }),
      LLM_TIMEOUT_MS
    );
    const durationMs = Date.now() - t0;

    if (!result.ok) {
      logger.warn('[aiNarrative] generateCaseBrief timed out or errored', { error: result.error });
      return { ...stubBrief(result.error), durationMs };
    }

    const brief = safeParseJson(result.value.text);
    logger.info('[aiNarrative] Case brief generated', { durationMs });

    return { ok: true, brief, durationMs };
  } catch (error) {
    const durationMs = Date.now() - t0;
    logger.error('[aiNarrative] Unhandled exception during case brief generation', { error: error.message });
    return { ...stubBrief(error.message), durationMs };
  }
}

/**
 * Process a single conversational turn for the AI Investigator Copilot.
 *
 * @param {object}   traceContext The current trace result (used as system context).
 * @param {string}   userQuery    The investigator's message.
 * @param {Array<{ role: 'user'|'model', content: string }>} chatHistory
 * @returns {Promise<{ ok: boolean, response: string, durationMs: number }>}
 */
export async function handleCopilotChat(traceContext, userQuery, chatHistory = []) {
  if (config.mockMode) {
    return {
      ok: true,
      response:
        '[MOCK] This is a simulated AI Copilot response. The system is running in mock mode.',
      durationMs: 0,
    };
  }

  let ai;
  try {
    ai = getAI();
  } catch (err) {
    logger.warn('[aiNarrative] Copilot: Cannot initialise Gemini client', { error: err.message });
    return { ok: false, response: `AI service unavailable: ${err.message}`, durationMs: 0 };
  }

  const systemInstruction = `
You are the CryptoTrace AI Investigator Copilot, embedded in a law-enforcement blockchain analytics tool.
You are analysing the following trace context:
${buildTraceContext(traceContext)}

Answer questions directly and with forensic precision.
Use plain English — your audience may not be technical.
Keep responses concise unless asked to elaborate.
`.trim();

  const contents = [
    { role: 'user', parts: [{ text: systemInstruction }] },
    {
      role: 'model',
      parts: [{ text: 'Understood. I am ready to assist with this investigation.' }],
    },
  ];

  for (const msg of chatHistory) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    });
  }

  contents.push({ role: 'user', parts: [{ text: userQuery }] });

  const t0 = Date.now();
  try {
    const result = await withTimeout(
      ai.models.generateContent({ model: MODEL, contents }),
      LLM_TIMEOUT_MS
    );
    const durationMs = Date.now() - t0;

    if (!result.ok) {
      const isTimeout = String(result.error).includes('timed out');
      const msg = isTimeout 
        ? `The AI Copilot did not respond in time (${LLM_TIMEOUT_MS / 1000}s). Please try again.`
        : `AI API Error: ${result.error}`;
      
      logger.warn('[aiNarrative] Copilot request failed', { error: result.error });
      return {
        ok: false,
        response: msg,
        durationMs,
      };
    }

    return { ok: true, response: result.value.text, durationMs };
  } catch (error) {
    const durationMs = Date.now() - t0;
    logger.error('[aiNarrative] Unhandled exception during copilot chat generation', { error: error.message });
    return {
      ok: false,
      response: `AI service encountered an error: ${error.message}`,
      durationMs,
    };
  }
}
