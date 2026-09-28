import React from 'react';
import { Network, Activity, AlertCircle, ArrowRight, Wallet, Banknote } from 'lucide-react';

export default function StoryTimelineView({ traceData, selectedNodeId, onNodeSelect }) {
  if (!traceData || !traceData.forceGraph) {
    return <div className="p-8 text-center text-[var(--color-text-muted)]">No trace data available.</div>;
  }

  const { nodes, links } = traceData.forceGraph;

  const sourceNode = nodes.find(n => n.role === 'source');
  if (!sourceNode) return null;
  
  // Display a flat list of nodes ordered by hop distance for the narrative view
  const timelineNodes = [...nodes]
    .filter(n => n.role !== 'context') // hide contexts in this view to keep it simple
    .sort((a, b) => (a.hop || 0) - (b.hop || 0));

  return (
    <div className="h-full overflow-y-auto p-8 pt-[240px] lg:pr-[450px] custom-scrollbar bg-[var(--color-bg-primary)]">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold gradient-text mb-2">Investigation Timeline</h2>
        <p className="text-[var(--color-text-muted)] mb-8">
          Plain-English narrative of the funds flow from the reported wallet to the final cash-out point.
        </p>

        <div className="relative border-l-2 border-[var(--color-border-subtle)] ml-4 space-y-8 pb-12">
          {timelineNodes.map((node, i) => {
            const isSource = node.role === 'source';
            const isExchange = node.role === 'exchange';
            
            return (
              <div 
                key={node.id} 
                className={`relative pl-8 cursor-pointer transition-all ${selectedNodeId === node.id ? 'opacity-100 scale-[1.02]' : 'opacity-80 hover:opacity-100'}`}
                onClick={() => onNodeSelect(node.id)}
              >
                {/* Timeline Dot */}
                <div className={`absolute -left-[11px] top-1 w-5 h-5 rounded-full border-4 border-[var(--color-bg-primary)] 
                  ${isSource ? 'bg-[var(--color-status-success)]' : 
                    isExchange ? 'bg-[var(--color-status-error)]' : 'bg-yellow-500'}`} 
                />

                <div className={`glass-card p-5 rounded-xl border transition-colors
                  ${selectedNodeId === node.id ? 'border-cyan-500/50 bg-cyan-900/10' : 'border-[var(--color-border-subtle)]'}
                  ${isExchange ? 'border-red-500/30 bg-red-900/10' : ''}
                `}>
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      {isSource && <Wallet className="w-5 h-5 text-green-400" />}
                      {!isSource && !isExchange && <Activity className="w-5 h-5 text-yellow-400" />}
                      {isExchange && <Banknote className="w-5 h-5 text-red-400" />}
                      
                      <h3 className="font-semibold text-white">
                        {isSource ? 'Source Wallet' : isExchange ? `Cash-Out: ${node.exchangeLabel || node.exchange}` : `Intermediary (Hop ${node.hop})`}
                      </h3>
                    </div>
                    <span className="text-xs font-mono text-[var(--color-text-muted)] bg-slate-800/50 px-2 py-1 rounded">
                      {node.addressDisplay}
                    </span>
                  </div>

                  <p className="text-sm text-gray-300 leading-relaxed mb-4">
                    {isSource 
                      ? `The investigation starts here. The victim-reported wallet initiated transfers totaling approximately $${node.outboundValueUsdApprox.toLocaleString()}. `
                      : isExchange 
                      ? `Funds reached this known exchange deposit address. A total of $${node.inboundValueUsdApprox.toLocaleString()} was successfully traced to this fiat off-ramp. `
                      : `Funds were layered through this intermediate wallet. It received $${node.inboundValueUsdApprox.toLocaleString()} and forwarded $${node.outboundValueUsdApprox.toLocaleString()}. `
                    }
                  </p>

                  {/* Risk Factors & Tags */}
                  {(node.riskFactors?.length > 0 || node.tags?.length > 0) && (
                    <div className="mt-4 pt-4 border-t border-[var(--color-border-subtle)]">
                      <div className="flex flex-wrap gap-2 mb-2">
                        {node.tags?.map(tag => (
                          <span key={tag} className="text-[10px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-400 px-2 py-1 rounded border border-orange-500/20">
                            {tag.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                      <ul className="space-y-1">
                        {node.riskFactors?.map((factor, idx) => (
                          <li key={idx} className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                            <AlertCircle className="w-3 h-3 text-red-400/70" />
                            {factor}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
