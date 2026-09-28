/**
 * components/PathTimeline.jsx
 * ---------------------------------------------------------------------------
 * Expandable accordion of every route found by the trace. Each route shows
 * its step-by-step timeline: hop number, from→to, amount, tx hash, timestamp.
 */

import { useState } from 'react';
import {
  shortenAddress,
  formatAmount,
  formatTimestamp,
  etherscanUrl,
} from '../utils/format.js';

/**
 * @param {object}   props
 * @param {object[]} props.paths  Array of path objects from backend.
 * @param {(id: string) => void} props.onNodeClick  Select a node on the graph.
 */
export default function PathTimeline({ paths, onNodeClick }) {
  const [expanded, setExpanded] = useState(0); // First route open by default

  if (!paths?.length) return null;

  return (
    <div className="space-y-2 animate-slide-in">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] px-1 mb-2">
        Routes ({paths.length})
      </h3>

      {paths.map((path, index) => (
        <RouteAccordion
          key={index}
          path={path}
          index={index}
          isOpen={expanded === index}
          onToggle={() => setExpanded(expanded === index ? -1 : index)}
          onNodeClick={onNodeClick}
        />
      ))}
    </div>
  );
}

function RouteAccordion({ path, index, isOpen, onToggle, onNodeClick }) {
  const { exchange, hops, amountIntoExchange, assetIntoExchange, temporallyOrdered, steps } = path;

  return (
    <div className="glass-card overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-[rgba(255,255,255,0.03)] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-[var(--color-text-muted)] w-5">#{index + 1}</span>
          <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
            {exchange?.label ?? exchange?.exchange ?? 'Unknown'}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {hops} hop{hops !== 1 ? 's' : ''}
          </span>
          {!temporallyOrdered && (
            <span className="text-[10px] bg-[rgba(245,158,11,0.15)] text-[var(--color-status-warn)] px-1.5 py-0.5 rounded font-medium">
              ⚠ TIME
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-[var(--color-text-accent)]">
            {formatAmount(amountIntoExchange, assetIntoExchange, 2)}
          </span>
          <svg
            className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Steps — visible when expanded */}
      {isOpen && steps && (
        <div className="border-t border-[var(--color-border-subtle)] px-3 pb-3">
          <div className="relative ml-3 mt-3">
            {/* Vertical timeline line */}
            <div className="absolute left-0 top-1 bottom-1 w-px bg-[var(--color-border-subtle)]" />

            {steps.map((step, stepIdx) => (
              <div key={stepIdx} className="relative pl-6 pb-4 last:pb-0">
                {/* Timeline dot */}
                <div
                  className={`absolute left-0 top-1 w-2 h-2 rounded-full -translate-x-[3.5px] ${
                    step.toIsExchange
                      ? 'bg-[var(--color-node-exchange)] shadow-[0_0_6px_var(--color-node-exchange)]'
                      : stepIdx === 0
                      ? 'bg-[var(--color-node-source)]'
                      : 'bg-[var(--color-node-intermediary)]'
                  }`}
                />

                {/* Step content */}
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <span className="font-semibold">Hop {step.hop}</span>
                    <span>·</span>
                    <span>{formatTimestamp(step.timestamp)}</span>
                  </div>

                  <div className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                    <button
                      onClick={() => onNodeClick?.(step.from)}
                      className="addr hover:text-[var(--color-text-accent)] transition-colors"
                      title={step.from}
                    >
                      {shortenAddress(step.fromDisplay ?? step.from)}
                    </button>
                    <span className="text-[var(--color-text-muted)]">→</span>
                    <button
                      onClick={() => onNodeClick?.(step.to)}
                      className={`addr transition-colors ${
                        step.toIsExchange
                          ? 'text-[var(--color-node-exchange)] font-semibold'
                          : 'hover:text-[var(--color-text-accent)]'
                      }`}
                      title={step.to}
                    >
                      {shortenAddress(step.toDisplay ?? step.to)}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[var(--color-text-primary)]">
                      {formatAmount(step.amount, step.asset)}
                    </span>
                    {step.hash && (
                      <a
                        href={etherscanUrl(step.hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="addr text-[var(--color-text-accent)] opacity-60 hover:opacity-100"
                        title={step.hash}
                      >
                        tx:{shortenAddress(step.hash, 6, 4)}↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
