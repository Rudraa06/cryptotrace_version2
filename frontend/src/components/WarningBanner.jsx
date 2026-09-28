/**
 * components/WarningBanner.jsx
 * ---------------------------------------------------------------------------
 * Renders backend warnings as a dismissible strip below the search bar.
 */

import { useState } from 'react';

/**
 * @param {object}   props
 * @param {string[]} props.warnings  Array of warning strings from the backend.
 */
export default function WarningBanner({ warnings }) {
  const [dismissed, setDismissed] = useState(false);

  if (!warnings?.length || dismissed) return null;

  return (
    <div className="w-full max-w-3xl mx-auto mt-2 animate-fade-in">
      <div className="glass-card border-[var(--color-status-warn)]/20 p-3 flex items-start gap-3">
        <span className="text-[var(--color-status-warn)] flex-shrink-0 mt-0.5">⚠</span>
        <div className="flex-1 space-y-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              {w}
            </p>
          ))}
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors flex-shrink-0"
          aria-label="Dismiss warnings"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
