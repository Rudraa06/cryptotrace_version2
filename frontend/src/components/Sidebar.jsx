/**
 * components/Sidebar.jsx
 * ---------------------------------------------------------------------------
 * Right panel. Scrollable. Contains:
 *   1. TraceSummary — the headline answer
 *   2. NodeTooltip  — selected node detail
 *   3. PathTimeline — route breakdown
 *   4. Warnings
 */

import TraceSummary from './TraceSummary.jsx';
import PathTimeline from './PathTimeline.jsx';
import NodeTooltip from './NodeTooltip.jsx';
import EmptyState from './EmptyState.jsx';
import ExportReportBtn from './ExportReportBtn.jsx';

/**
 * @param {object}       props
 * @param {object|null}  props.data          Backend trace response.
 * @param {object|null}  props.selectedNode  Currently selected graph node.
 * @param {(id: string|null) => void} props.onNodeSelect
 * @param {boolean}      props.loading
 */
export default function Sidebar({ data, selectedNode, onNodeSelect, onTryAddress, loading }) {
  // Loading skeleton
  if (loading) {
    return (
      <div className="h-full p-4 space-y-3 overflow-y-auto">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-20 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  // No data yet — idle state
  if (!data) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center">
          <div className="flex justify-center mb-4 opacity-30">
            <svg className="w-12 h-12 text-[var(--color-text-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">
            Enter a wallet address to begin tracing
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-2 opacity-60">
            The system will trace fund flows and identify exchange cash-out points
          </p>
        </div>
      </div>
    );
  }

  // Trace returned but found nothing
  if (data.found === false) {
    return (
      <div className="h-full p-4 overflow-y-auto">
        <EmptyState data={data} onTryAddress={onTryAddress} />
      </div>
    );
  }

  // Results
  return (
    <div className="h-full p-4 space-y-4 overflow-y-auto">
      <TraceSummary data={data} />
      
      <div className="flex justify-end">
        <ExportReportBtn traceData={data} />
      </div>

      {selectedNode && (
        <NodeTooltip
          node={selectedNode}
          onClose={() => onNodeSelect(null)}
        />
      )}

      <PathTimeline
        paths={data.paths}
        onNodeClick={(id) => onNodeSelect(id)}
      />

      {/* Ingestion info */}
      {data.ingestion?.attempted && (
        <div className="glass-card p-3 text-xs text-[var(--color-text-muted)] space-y-1">
          <p className="font-semibold text-[var(--color-text-secondary)]">Auto-Ingestion</p>
          {data.ingestion.ok ? (
            <p>
              ✅ Ingested {data.ingestion.walletsWritten ?? 0} wallets,{' '}
              {data.ingestion.transactionsWritten ?? 0} transactions
              {data.ingestion.durationMs ? ` in ${(data.ingestion.durationMs / 1000).toFixed(1)}s` : ''}
            </p>
          ) : (
            <p className="text-[var(--color-status-warn)]">
              ⚠ Ingestion failed: {data.ingestion.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
