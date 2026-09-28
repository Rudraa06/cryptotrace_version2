/**
 * lib/logger.js
 * ---------------------------------------------------------------------------
 * Minimal structured logger. Deliberately dependency-free.
 *
 * Two goals:
 *  1. Readable, colourised output while you are demoing on a projector.
 *  2. Machine-parseable JSON when NODE_ENV=production, so the same code can be
 *     shipped without a logging rewrite.
 */

import { config } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// ANSI colours. Disabled in production (where we emit JSON) and when the
// output stream is not a TTY (e.g. piped into a file or captured by a runner).
const useColour = !config.isProduction && Boolean(process.stdout.isTTY);

/** ASCII 27 = ESC. Built with fromCharCode so this file stays pure ASCII and
 *  cannot be corrupted by editors or clipboards that strip control bytes. */
const ESC = String.fromCharCode(27);

/**
 * Wrap text in an ANSI SGR colour code.
 * @param {string} code e.g. '31' for red
 * @param {string} text
 */
const paint = (code, text) => (useColour ? `${ESC}[${code}m${text}${ESC}[0m` : text);

const LEVEL_STYLE = {
  debug: (t) => paint('90', t), // grey
  info: (t) => paint('36', t), // cyan
  warn: (t) => paint('33', t), // yellow
  error: (t) => paint('31', t), // red
};

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta] Structured context.
 */
function emit(level, message, meta) {
  if (LEVELS[level] < ACTIVE_LEVEL) return;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (config.isProduction) {
    stream.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta })}\n`
    );
    return;
  }

  const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const tag = LEVEL_STYLE[level](level.toUpperCase().padEnd(5));
  const context =
    meta && Object.keys(meta).length > 0 ? ` ${paint('90', JSON.stringify(meta))}` : '';

  stream.write(`${paint('90', time)} ${tag} ${message}${context}\n`);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
