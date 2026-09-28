/**
 * components/TraceSummary.jsx
 * ---------------------------------------------------------------------------
 * The headline card: "Funds traced to {Exchange} in {N} hops".
 * Sits at the top of the sidebar when a trace has results.
 */

import { shortenAddress, formatAmount, etherscanUrl } from '../utils/format.js';

/**
 * @param {object} props
 * @param {object} props.data  Backend trace response (with found: true).
 */
export default function TraceSummary({ data }) {
  if (!data?.found) return null;

  const { topExchange, shortestHops, paths, stats } = data;

  return (
    <div className="dark-panel p-4 animate-slide-in bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] rounded-lg">
      {/* Case Details / Fraud Typology Header */}
      {data.caseId && (
        <div className={`p-3 mb-4 rounded border text-xs ${
          data.fraudType === 'sextortion' || data.fraudType === 'ransomware'
            ? 'bg-[#E11D48]/10 border-[#E11D48]/30 text-[#E11D48]'
            : 'bg-[#1A1D24] border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]'
        }`}>
          <div className="flex justify-between items-center font-bold mb-1 uppercase tracking-widest text-[9px]">
            <span>Case File: {data.caseId}</span>
            <span className="px-1.5 py-0.5 rounded bg-black/40">
              {data.fraudType ? data.fraudType.toUpperCase().replace('_', ' ') : 'UNKNOWN'}
            </span>
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
            Complaint Ref: <span className="font-mono text-[var(--color-text-secondary)]">{data.complaintId}</span>
          </div>
        </div>
      )}

      {/* Headline */}
      <div className="flex items-start gap-3 mb-3">
        {/* Exchange icon */}
        <div className="w-10 h-10 rounded-full bg-[rgba(239,68,68,0.15)] flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg className="w-5 h-5 text-[var(--color-node-exchange)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider mb-1">
            Cash-Out Identified
          </p>
          <h2 className="text-lg font-bold text-[var(--color-text-primary)] leading-tight">
            Funds traced to{' '}
            <span className="text-[var(--color-node-exchange)]">
              {topExchange?.label ?? topExchange?.exchange ?? 'Unknown Exchange'}
            </span>
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
            in <span className="font-semibold text-[var(--color-text-accent)]">{shortestHops}</span> hop{shortestHops !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-[rgba(255,255,255,0.05)]">
        <Stat label="Routes" value={paths?.length ?? 0} delay="0ms" />
        <Stat label="Exchanges" value={stats?.exchangesReached ?? 0} delay="50ms" />
        <Stat label="Swaps" value={stats?.swapsDetected ?? 0} delay="100ms" />
        <Stat
          label="Time"
          value={stats?.durationMs ? `${(stats.durationMs / 1000).toFixed(1)}s` : '—'}
          delay="150ms"
        />
      </div>

      {/* Exchange address */}
      {topExchange?.address && (
        <a
          href={etherscanUrl(topExchange.address, 'address')}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block text-xs addr text-[var(--color-text-accent)] hover:underline truncate"
          title={topExchange.address}
        >
          {shortenAddress(topExchange.addressDisplay ?? topExchange.address)}
          <span className="ml-1 opacity-50">↗</span>
        </a>
      )}

      {/* Cross-Chain Banner (Phase 4) */}
      {data.crossChain?.length > 0 && (
        <div className="mt-4 p-3 rounded-lg border border-[var(--color-node-bridge)] bg-[rgba(249,115,22,0.08)]">
          <div className="flex items-center gap-2 mb-1">
            <svg className="w-5 h-5 text-[var(--color-node-bridge)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
            </svg>
            <span className="text-xs font-bold text-[var(--color-node-bridge)] uppercase tracking-wider">Multi-Chain Trace</span>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Trace continues automatically on <span className="font-semibold text-[var(--color-text-primary)]">
              {data.crossChain.map(cc => cc.chain).join(', ')}
            </span>.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, delay = '0ms' }) {
  return (
    <div className="text-center animate-fade-in" style={{ animationDelay: delay, animationFillMode: 'both' }}>
      <p className="mono-large text-[var(--color-text-primary)]">{value}</p>
      <p className="label-muted mt-1">{label}</p>
    </div>
  );
}
