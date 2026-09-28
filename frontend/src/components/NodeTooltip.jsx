/**
 * components/NodeTooltip.jsx
 * ---------------------------------------------------------------------------
 * Detail panel shown in the sidebar when a node is selected on the graph.
 */

import { shortenAddress, formatAmount, etherscanUrl } from '../utils/format.js';
import { NODE_ROLES, ROLE_COLORS } from '../utils/constants.js';

const ROLE_LABELS = {
  [NODE_ROLES.SOURCE]: 'Source Wallet',
  [NODE_ROLES.INTERMEDIARY]: 'Intermediary',
  [NODE_ROLES.EXCHANGE]: 'Exchange',
  [NODE_ROLES.CONTEXT]: 'Off-Path Wallet',
};

/**
 * @param {object}       props
 * @param {object|null}  props.node  The selected node from forceGraph.nodes.
 * @param {() => void}   props.onClose
 */
export default function NodeTooltip({ node, onClose }) {
  if (!node) return null;

  const roleColor = node.color ?? ROLE_COLORS[node.role] ?? '#94a3b8';

  return (
    <div className="glass-card p-4 animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: roleColor, boxShadow: `0 0 6px ${roleColor}` }}
          />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: roleColor }}>
            {ROLE_LABELS[node.role] ?? node.role}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Address */}
      <a
        href={etherscanUrl(node.id, 'address')}
        target="_blank"
        rel="noopener noreferrer"
        className="block addr text-sm text-[var(--color-text-accent)] hover:underline mb-3 truncate"
        title={node.id}
      >
        {node.addressDisplay ?? node.id} ↗
      </a>

      {/* Cross-Case Shared Mule Warning */}
      {node.crossCaseAlert && (
        <div className="mb-3 p-2.5 rounded-lg bg-[rgba(225,29,72,0.12)] border border-[#E11D48] flex items-start gap-2">
          <span className="text-base">⚠️</span>
          <div className="text-xs">
            <p className="font-bold text-[#E11D48] uppercase tracking-wider text-[10px]">
              Shared Mule Infrastructure
            </p>
            <p className="text-[var(--color-text-secondary)] mt-0.5 font-mono text-[11px]">
              Shared across cases: <span className="font-semibold text-white">{node.crossCaseIds?.join(', ')}</span>
            </p>
          </div>
        </div>
      )}

      {/* Exchange info */}
      {node.isExchange && (node.exchange || node.exchangeLabel) && (
        <div className="mb-3 p-2 rounded-lg bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)]">
          <p className="text-xs text-[var(--color-node-exchange)] font-semibold">
            {node.exchangeLabel ?? node.exchange}
          </p>
        </div>
      )}

      {/* Contract Tag Info (Phase 1) */}
      {node.contractTag && (
        <div className={`mb-3 p-2 rounded-lg bg-opacity-10 border border-opacity-20 ${
          node.contractTag.type === 'dex' ? 'bg-[var(--color-node-dex)] border-[var(--color-node-dex)]' :
          node.contractTag.type === 'bridge' ? 'bg-[var(--color-node-bridge)] border-[var(--color-node-bridge)]' :
          'bg-[var(--color-node-mixer)] border-[var(--color-node-mixer)]'
        }`}>
          <p className={`text-xs font-semibold ${
            node.contractTag.type === 'dex' ? 'text-[var(--color-node-dex)]' :
            node.contractTag.type === 'bridge' ? 'text-[var(--color-node-bridge)]' :
            'text-[var(--color-node-mixer)]'
          }`}>
            {node.contractTag.name} <span className="opacity-75 font-normal ml-1 capitalize">({node.contractTag.type})</span>
          </p>
        </div>
      )}

      {/* Mixer Risk Pattern Warning (Phase 3) */}
      {node.riskBreakdown?.mixer && (
        <div className="mb-3 p-2 rounded-lg bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] flex items-center gap-2">
          <span title="Warning">⚠️</span>
          <p className="text-xs text-[var(--color-status-error)] font-semibold">
            High Risk: Mixer Pattern Detected
          </p>
        </div>
      )}

      {/* Swap Event (Phase 2) */}
      {node.swapEvent && (
        <div className="mb-3 space-y-1 bg-[rgba(148,163,184,0.08)] p-2 rounded-lg border border-[rgba(148,163,184,0.15)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">Swap Executed</p>
          <div className="flex justify-between items-center text-xs">
            <span className="text-[var(--color-text-primary)]">In: {node.swapEvent.fromToken}</span>
            <span className="text-[var(--color-text-muted)]">→</span>
            <span className="text-[var(--color-status-ok)]">Out: {node.swapEvent.toToken} ({node.swapEvent.toAmount ?? '?'})</span>
          </div>
        </div>
      )}

      {/* Properties grid */}
      <div className="space-y-2 text-xs">
        {node.hop !== null && node.hop !== undefined && (
          <Row label="Hop Distance" value={node.hop} />
        )}
        
        {/* Risk Score Breakdown Visualization */}
        {node.riskBreakdown && (
          <div className="mt-3 p-3 dark-panel border border-[var(--color-border-subtle)] rounded bg-[#1A1D24] space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Risk Breakdown</span>
              <div className="flex items-center gap-1.5">
                {node.riskScore >= 80 ? (
                  <svg className="w-4 h-4 text-[#E11D48]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                ) : node.riskScore >= 40 ? (
                  <svg className="w-4 h-4 text-[#F59E0B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-[#10B981]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                <span className={`text-sm font-bold ${node.riskScore >= 80 ? 'text-[#E11D48]' : node.riskScore >= 40 ? 'text-[#F59E0B]' : 'text-[#10B981]'}`}>
                  {node.riskScore}/100 {node.riskScore >= 80 ? '(HIGH)' : node.riskScore >= 40 ? '(MEDIUM)' : '(LOW)'}
                </span>
              </div>
            </div>
            
            {/* Master progress bar */}
            <div className="w-full bg-[#333845] h-2 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all ${node.riskScore >= 80 ? 'bg-[#E11D48]' : node.riskScore >= 40 ? 'bg-[#F59E0B]' : 'bg-[#10B981]'}`}
                style={{ width: `${node.riskScore}%` }}
              />
            </div>

            {/* Individual factors */}
            <div className="space-y-1.5 pt-2 border-t border-[var(--color-border-subtle)] text-[10px]">
              {node.riskBreakdown.priorRisk > 0 && (
                <MiniBar label="Prior Graph Risk" value={node.riskBreakdown.priorRisk} />
              )}
              {node.riskBreakdown.velocity > 0 && (
                <MiniBar label="Velocity" value={node.riskBreakdown.velocity} />
              )}
              {node.riskBreakdown.peeling > 0 && (
                <MiniBar label="Peeling Pattern" value={node.riskBreakdown.peeling} />
              )}
              {node.riskBreakdown.proximity > 0 && (
                <MiniBar label="Exchange Proximity" value={node.riskBreakdown.proximity} />
              )}
              {node.riskBreakdown.taint > 0 && (
                <MiniBar label="Taint Score" value={node.riskBreakdown.taint} />
              )}
              {node.riskBreakdown.mixer > 0 && (
                <MiniBar label="Mixer Interaction" value={node.riskBreakdown.mixer} />
              )}
              {node.riskBreakdown.crossChain > 0 && (
                <MiniBar label="Cross-Chain Flight" value={node.riskBreakdown.crossChain} />
              )}
              {node.riskBreakdown.privacy > 0 && (
                <MiniBar label="Privacy Coin Swap" value={node.riskBreakdown.privacy} />
              )}
              {node.riskBreakdown.otcBroker > 0 && (
                <MiniBar label="Suspected OTC Broker" value={node.riskBreakdown.otcBroker} />
              )}
              {node.riskBreakdown.crossCase > 0 && (
                <MiniBar label="Shared Mule Infrastructure" value={node.riskBreakdown.crossCase} />
              )}
              {node.riskBreakdown.aiModel > 0 && (
                <MiniBar label="GNN AI Model" value={node.riskBreakdown.aiModel} />
              )}
            </div>

            {/* Textual Risk Factors */}
            {node.riskFactors && node.riskFactors.length > 0 && (
              <div className="pt-2 border-t border-[var(--color-border-subtle)]">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Risk Factors</p>
                <ul className="list-disc pl-3 text-[10px] space-y-1 text-[var(--color-text-secondary)]">
                  {node.riskFactors.map((factor, idx) => (
                    <li key={idx} className={factor.includes('Graph Neural Network') ? 'text-[#E11D48] font-semibold' : ''}>
                      {factor}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <Row label="Volume (≈USD)" value={`$${formatAmount(node.volumeUsdApprox)}`} />
        <Row label="Inbound" value={`${node.inboundCount ?? 0} tx · $${formatAmount(node.inboundValueUsdApprox)}`} />
        <Row label="Outbound" value={`${node.outboundCount ?? 0} tx · $${formatAmount(node.outboundValueUsdApprox)}`} />

        {/* Per-asset breakdown */}
        {node.totalsByAsset && Object.keys(node.totalsByAsset).length > 0 && (
          <div className="pt-2 mt-2 border-t border-[var(--color-border-subtle)]">
            <p className="text-[var(--color-text-muted)] mb-1.5 font-medium">By Asset</p>
            {Object.entries(node.totalsByAsset).map(([asset, { in: inAmt, out: outAmt }]) => (
              <div key={asset} className="flex justify-between text-[var(--color-text-secondary)] py-0.5">
                <span className="font-mono">{asset}</span>
                <span>
                  <span className="text-[var(--color-status-ok)]">↓{formatAmount(inAmt)}</span>
                  {' / '}
                  <span className="text-[var(--color-status-error)]">↑{formatAmount(outAmt)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between items-center text-xs py-1">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="text-[var(--color-text-primary)] font-semibold font-mono">{value}</span>
    </div>
  );
}

function MiniBar({ label, value = 0 }) {
  // Map score (usually 0..100) to progress bar width
  const percent = Math.min(Math.max(value, 0), 100);
  const colorClass = percent >= 80 ? 'bg-[#E11D48]' : percent >= 40 ? 'bg-[#F59E0B]' : 'bg-[#3B82F6]';
  
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-[var(--color-text-muted)]">
        <span>{label}</span>
        <span className="font-mono">{percent}%</span>
      </div>
      <div className="w-full bg-[#222631] h-1 rounded-full overflow-hidden">
        <div 
          className={`h-full rounded-full ${colorClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
