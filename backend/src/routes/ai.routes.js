/**
 * routes/ai.routes.js
 * ---------------------------------------------------------------------------
 * Phase 4 AI endpoints — exposed separately so the frontend can request
 * an on-demand brief without triggering a full trace re-run.
 *
 *   POST /api/ai/generate-summary   → full forensic case brief
 *   POST /api/ai/copilot-chat       → single conversational turn
 */

import { Router } from 'express';
import { generateCaseBrief, handleCopilotChat } from '../services/aiNarrative.service.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { config } from '../config/env.js';

export const aiRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/ai/generate-summary
// ---------------------------------------------------------------------------
// Body: { traceData: <the full /api/trace/:address response payload> }
// Returns the structured forensic brief produced by Gemini.
// Fails open: if the LLM is unavailable the response has ok:false + a stub.

aiRouter.post(
  '/generate-summary',
  asyncRoute(async (req, res) => {
    const { traceData } = req.body;

    if (!traceData) {
      return res.status(400).json({ ok: false, error: 'traceData is required in the request body.' });
    }

    // generateCaseBrief never throws — it resolves with ok:false on error.
    const result = await generateCaseBrief(traceData);

    // Surface the brief at the top level for easy consumption by the frontend.
    res.json({
      ok: result.ok,
      brief: result.brief,
      durationMs: result.durationMs ?? null,
      ...(result.skipped ? { skipped: true, reason: result.reason } : {}),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/ai/copilot-chat
// ---------------------------------------------------------------------------
// Body:
//   traceContext  object  — current trace payload (used as AI system context)
//   query         string  — the investigator's message
//   history       array   — prior turns: [{ role: 'user'|'model', content }]

aiRouter.post(
  '/copilot-chat',
  asyncRoute(async (req, res) => {
    const { traceContext, query, history } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ ok: false, error: 'query is required and must be a non-empty string.' });
    }

    const result = await handleCopilotChat(traceContext ?? {}, query, history ?? []);

    res.json({
      ok: result.ok,
      response: result.response,
      durationMs: result.durationMs ?? null,
    });
  })
);
