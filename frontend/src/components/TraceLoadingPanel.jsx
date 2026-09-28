import React, { useEffect, useState } from 'react';
import { Network, Activity } from 'lucide-react';

/**
 * TraceLoadingPanel
 * ---------------------------------------------------------------------------
 * Replaces the static countdown timer with a live, backend-driven progress
 * feed and a procedural SVG graph animation. It visually communicates that
 * heavy work is happening, keeping the investigator engaged during long traces.
 * 
 * @param {object} props
 * @param {object} props.progress  The progress state from useTrace
 * @param {number} props.requestedDepth  The maxHops slider value
 */
export function TraceLoadingPanel({ progress, requestedDepth = 15, finalData, onContinue }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [pulses, setPulses] = useState([]);

  // The fallback estimate if SSE isn't working or we haven't received events
  const estimatedSeconds = Math.floor((15000 + Math.pow(requestedDepth, 1.5) * 5000) / 1000);
  const [timeLeft, setTimeLeft] = useState(estimatedSeconds);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // --- Procedural Graph Animation ---
  useEffect(() => {
    // Initial central node (the suspect)
    const initialNodes = [
      { id: 0, x: 50, y: 50, color: '#ef4444', size: 6 } // red suspect node
    ];
    setNodes(initialNodes);

    let nextNodeId = 1;
    
    // Add nodes and edges procedurally
    const growInterval = setInterval(() => {
      setNodes(prev => {
        if (prev.length > 25) return prev; // cap size
        
        // Pick a random existing node to connect to
        const sourceIdx = Math.floor(Math.random() * prev.length);
        const source = prev[sourceIdx];
        
        // Calculate new position bursting outward
        const angle = Math.random() * Math.PI * 2;
        const distance = 15 + Math.random() * 25;
        let newX = source.x + Math.cos(angle) * distance;
        let newY = source.y + Math.sin(angle) * distance;
        
        // Keep inside bounds (0-100 viewBox)
        newX = Math.max(5, Math.min(95, newX));
        newY = Math.max(5, Math.min(95, newY));
        
        // Random color: mostly neutral, occasionally high risk (amber/red)
        const rand = Math.random();
        const color = rand > 0.85 ? '#f59e0b' : rand > 0.95 ? '#ef4444' : '#94a3b8';
        const size = rand > 0.8 ? 5 : 3;

        const newNode = { id: nextNodeId++, x: newX, y: newY, color, size };
        
        setEdges(e => [...e, { id: `${source.id}-${newNode.id}`, source, target: newNode }]);
        
        // Trigger a pulse along the new edge
        setPulses(p => [...p, { id: Math.random().toString(), source, target: newNode }]);
        
        return [...prev, newNode];
      });
    }, 600);

    return () => clearInterval(growInterval);
  }, []);

  // Remove pulses after their animation completes
  useEffect(() => {
    if (pulses.length > 0) {
      const timeout = setTimeout(() => {
        setPulses(p => p.slice(1)); // remove oldest
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [pulses]);

  const latestLog = progress?.logs?.[progress.logs.length - 1];
  const previousLogs = progress?.logs?.slice(Math.max(0, progress.logs.length - 4), progress.logs.length - 1).reverse() || [];

  if (finalData) {
    const hasGraph = finalData.forceGraph?.nodes?.length > 0;
    
    // Prefer ingestion stats if they exist (since they represent the full BFS search space),
    // otherwise fallback to summary totals, wallet array length, forceGraph size, or 0.
    const numWallets = finalData.ingestion?.walletsWritten 
      ?? finalData.summary?.walletCount 
      ?? finalData.wallets?.length 
      ?? (finalData.forceGraph?.nodes?.length || 0);

    const numTransfers = finalData.ingestion?.transactionsWritten 
      ?? finalData.summary?.transactionCount 
      ?? finalData.transactions?.length 
      ?? (finalData.forceGraph?.links?.length || 0);

    const actualDepth = finalData.ingestion?.depth || finalData.query?.depth || requestedDepth;
    
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] w-full max-w-lg p-8 font-sans bg-slate-900/90 rounded-2xl border border-slate-700 shadow-2xl backdrop-blur-md text-center animate-in zoom-in-95 duration-300">
        <div className="w-16 h-16 bg-teal-500/20 rounded-full flex items-center justify-center mb-6">
          <Network className="w-8 h-8 text-teal-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-100 mb-2">Trace Complete</h2>
        <p className="text-slate-400 mb-8">The trace pipeline has finished execution successfully.</p>
        
        <div className="grid grid-cols-2 gap-4 w-full mb-8 text-left">
          <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Wallets Traced</div>
            <div className="text-2xl font-mono text-slate-200">{numWallets}</div>
          </div>
          <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Transfers Found</div>
            <div className="text-2xl font-mono text-slate-200">{numTransfers}</div>
          </div>
          <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Search Depth</div>
            <div className="text-2xl font-mono text-slate-200">{actualDepth} hops</div>
          </div>
          <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Status</div>
            <div className="text-lg font-mono text-teal-400 mt-1 uppercase">Completed</div>
          </div>
        </div>

        <button 
          onClick={onContinue}
          className="w-full py-3.5 bg-teal-500 hover:bg-teal-400 text-slate-900 font-bold rounded-xl transition-all shadow-[0_0_20px_rgba(20,184,166,0.3)] hover:shadow-[0_0_30px_rgba(20,184,166,0.5)] transform hover:-translate-y-0.5"
        >
          {hasGraph ? "View Interactive Graph" : "View Trace Details"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] w-full p-8 font-sans">
      
      {/* Procedural SVG Animation Container */}
      <div className="relative w-64 h-64 mb-8">
        <svg viewBox="0 0 100 100" className="w-full h-full overflow-visible">
          
          {/* Edges */}
          {edges.map(edge => (
            <line
              key={edge.id}
              x1={edge.source.x}
              y1={edge.source.y}
              x2={edge.target.x}
              y2={edge.target.y}
              stroke="#334155" // slate-700
              strokeWidth="0.5"
              className="animate-in fade-in duration-500"
            />
          ))}

          {/* Flow Pulses */}
          {pulses.map(pulse => (
            <circle
              key={pulse.id}
              r="1.5"
              fill="#14b8a6" // teal-500
              className="pulse-anim"
            >
              <animateMotion
                path={`M ${pulse.source.x} ${pulse.source.y} L ${pulse.target.x} ${pulse.target.y}`}
                dur="1s"
                fill="freeze"
                calcMode="linear"
              />
              <animate
                attributeName="opacity"
                values="1;0"
                dur="1s"
                fill="freeze"
              />
            </circle>
          ))}

          {/* Nodes */}
          {nodes.map(node => (
            <circle
              key={node.id}
              cx={node.x}
              cy={node.y}
              r={node.size / 2}
              fill={node.color}
              className="animate-in zoom-in duration-300"
            />
          ))}
        </svg>

        {/* Central glowing effect */}
        <div className="absolute inset-0 bg-blue-500/5 rounded-full blur-3xl -z-10 animate-pulse"></div>
      </div>

      {/* Progress Logs Feed */}
      <div className="w-full max-w-md flex flex-col items-center text-center space-y-4">
        
        {/* Current active stage */}
        <div className="flex flex-col items-center">
          <div className="flex items-center space-x-3 mb-2">
            <Activity className="w-5 h-5 text-teal-400 animate-spin-slow" />
            <h3 className="text-lg font-semibold text-slate-100">
              {latestLog ? latestLog.message : 'Initializing trace pipeline...'}
            </h3>
          </div>
          {latestLog?.detail && (
            <span className="text-sm font-medium text-teal-400/80 bg-teal-400/10 px-2.5 py-0.5 rounded-full">
              {latestLog.detail}
            </span>
          )}
        </div>

        {/* Rolling previous logs (faded) */}
        <div className="w-full flex flex-col space-y-1.5 mt-4 mask-image-bottom-fade">
          {previousLogs.map((log, i) => (
            <div 
              key={log.timestamp} 
              className={`text-sm text-slate-400 transition-all duration-500`}
              style={{ opacity: 1 - (i * 0.25) }}
            >
              {log.message} {log.detail && <span className="opacity-60 text-xs ml-1">({log.detail})</span>}
            </div>
          ))}
        </div>

        {/* Fallback Countdown Timer as secondary detail */}
        <div className="mt-8 text-xs font-mono text-slate-500 bg-slate-800/50 px-3 py-1.5 rounded-md border border-slate-700">
          ESTIMATED TIME REMAINING: {timeLeft}s
        </div>
        
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .mask-image-bottom-fade {
          mask-image: linear-gradient(to top, transparent, black 100%);
        }
        .animate-spin-slow {
          animation: spin 3s linear infinite;
        }
      `}} />
    </div>
  );
}
