/**
 * App.jsx
 * ---------------------------------------------------------------------------
 * Root component. Orchestrates:
 *   - SearchBar  → triggers trace
 *   - GraphCanvas → renders force graph
 *   - Sidebar    → shows trace details
 *   - WarningBanner → backend warnings
 *
 * State lives here because both the graph and the sidebar need the same trace
 * result, and the selected-node state flows in both directions (graph click →
 * sidebar detail, sidebar click → graph highlight).
 */

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import Layout from './components/Layout.jsx';
import SearchBar from './components/SearchBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import WarningBanner from './components/WarningBanner.jsx';
import EmptyState from './components/EmptyState.jsx';
const GraphCanvas = lazy(() => import('./components/GraphCanvas.jsx'));
const StoryTimelineView = lazy(() => import('./components/StoryTimelineView.jsx'));
import AiCopilotDrawer from './components/AiCopilotDrawer.jsx';
import ExportReportBtn from './components/ExportReportBtn.jsx';
import AlertsTray from './components/AlertsTray.jsx';
import CorrelationLookup from './components/CorrelationLookup.jsx';
import AdminDashboard from './components/AdminDashboard.jsx';
import { TraceLoadingPanel } from './components/TraceLoadingPanel.jsx';
import { useTrace } from './hooks/useTrace.js';
import { useAuth } from './hooks/AuthContext.jsx';
import Login from './components/Login.jsx';
import ActivateAccount from './components/ActivateAccount.jsx';
import ResetPassword from './components/ResetPassword.jsx';

export default function App() {
  const { user, initialLoad: authLoading } = useAuth();
  const { data, error, loading, progress, trace } = useTrace();
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [requestedDepth, setRequestedDepth] = useState(15);
  const [viewMode, setViewMode] = useState('graph');
  const [isCopilotOpen, setIsCopilotOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showCorrelation, setShowCorrelation] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  // Graph container sizing
  const graphContainerRef = useRef(null);
  const [graphDimensions, setGraphDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const updateSize = () => {
      if (graphContainerRef.current) {
        const { width, height } = graphContainerRef.current.getBoundingClientRect();
        if (width > 0 && height > 0) {
          setGraphDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    };

    // Initial size
    updateSize();

    // Setup listener
    window.addEventListener('resize', updateSize);
    
    // Also try ResizeObserver as a fallback for internal layout shifts
    let observer;
    if (graphContainerRef.current) {
      observer = new ResizeObserver(updateSize);
      observer.observe(graphContainerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateSize);
      if (observer) observer.disconnect();
    };
  }, []);

  // Clear selection when new trace data arrives
  useEffect(() => {
    setSelectedNodeId(null);
  }, [data]);


  // Handle trace submission
  const handleTrace = useCallback(
    (address, opts) => {
      setRequestedDepth(opts.maxHops ?? 15);
      trace(address, opts);
      setIsSidebarOpen(true);
      setShowSummary(true);
    },
    [trace]
  );

  // Find the selected node object from forceGraph data
  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !data?.forceGraph?.nodes) return null;
    return data.forceGraph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId, data]);

  // Has graph data to show?
  const hasGraph = data?.forceGraph?.nodes?.length > 0;

  if (authLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-400">
        Authenticating...
      </div>
    );
  }

  if (window.location.pathname === '/activate') {
    return <ActivateAccount />;
  }
  
  if (window.location.pathname === '/reset-password') {
    return <ResetPassword />;
  }

  if (!user) {
    return <Login />;
  }

  return (
    <Layout 
      viewMode={viewMode} 
      onToggleView={setViewMode} 
      onOpenCopilot={() => setIsCopilotOpen(true)}
      onOpenCorrelation={() => setShowCorrelation(true)}
      onOpenAdmin={() => setShowAdmin(true)}
    >
      <div className="h-full relative overflow-hidden">
        
        {showCorrelation && (
          <CorrelationLookup onClose={() => setShowCorrelation(false)} />
        )}

        {showAdmin && (
          <AdminDashboard onClose={() => setShowAdmin(false)} />
        )}
        
        {/* Main area (Graph or Timeline) spans full viewport behind UI */}
        <div ref={graphContainerRef} className="absolute inset-0 z-0">
            {hasGraph && (
              viewMode === 'graph' ? (
                <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><svg className="w-8 h-8 animate-spin text-[var(--color-accent-from)]" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg></div>}>
                  <GraphCanvas
                    graphData={data.forceGraph}
                    selectedNodeId={selectedNodeId}
                    onNodeSelect={setSelectedNodeId}
                    width={graphDimensions.width}
                    height={graphDimensions.height}
                  />
                </Suspense>
              ) : (
                <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><svg className="w-8 h-8 animate-spin text-[var(--color-accent-from)]" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg></div>}>
                  <StoryTimelineView 
                    traceData={data} 
                    selectedNodeId={selectedNodeId} 
                    onNodeSelect={setSelectedNodeId} 
                  />
                </Suspense>
              )
            )}
            
            {!loading && !data && (
              /* Landing state */
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center animate-fade-in max-w-md px-6">
                  <div className="flex justify-center mb-6 opacity-40">
                    <svg className="w-16 h-16 text-[var(--color-accent-from)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold gradient-text mb-3">
                    Trace Cryptocurrency Fund Flows
                  </h2>
                  <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
                    Enter a suspect wallet address to trace outgoing transfers across
                    the blockchain and identify which centralized exchanges the funds
                    reached.
                  </p>
                  <div className="flex items-center justify-center gap-4 text-xs text-[var(--color-text-muted)]">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[var(--color-node-source)]" />
                      Source
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[var(--color-node-intermediary)]" />
                      Intermediary
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[var(--color-node-exchange)]" />
                      Exchange
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Legend overlay */}
            {hasGraph && (
              <div className="absolute bottom-24 left-6 dark-panel p-3 z-10 border-l-2 border-l-[var(--color-accent-from)] hidden sm:block">
                <div className="flex flex-col gap-2 text-[10px] text-[var(--color-text-muted)] mono-data uppercase tracking-widest">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-[var(--color-node-source)]" />
                    Source
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-[var(--color-node-intermediary)]" />
                    Intermediary
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 bg-[var(--color-node-exchange)] shadow-[0_0_8px_var(--color-node-exchange)]" />
                    Exchange
                  </span>
                </div>
              </div>
            )}
          </div>
            {/* Foreground HUD layer */}
            <div className="absolute top-6 left-6 right-6 lg:right-[430px] z-10 flex flex-col pointer-events-none">
              <div className="w-full pointer-events-auto">
                <SearchBar onTrace={handleTrace} loading={loading} />
              </div>

              {/* Warnings & Errors */}
              <div className="w-full mt-3 flex flex-col gap-2 pointer-events-auto">
                {data?.warnings?.length > 0 && (
                  <div className="animate-fade-in">
                    <WarningBanner warnings={data.warnings} />
                  </div>
                )}
                {error && (
                  <div className="w-full animate-fade-in">
                    <div className="dark-panel border-[var(--color-status-error)] bg-[var(--color-status-error)]/10 p-3 flex items-center gap-3">
                      <span className="text-[var(--color-status-error)]">✕</span>
                      <p className="text-xs text-[var(--color-status-error)] mono-data">
                        {error.message ?? 'An unknown error occurred'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

        {/* Desktop Floating Sidebar */}
        <div className="absolute top-24 right-6 bottom-6 w-full max-w-[400px] z-10 transition-transform hidden lg:flex flex-col animate-slide-in pointer-events-none">
          <div className="flex-1 glass-card overflow-hidden shadow-2xl flex flex-col border-[rgba(255,255,255,0.08)] pointer-events-auto">
            <Sidebar
              data={data}
              selectedNode={selectedNode}
              onNodeSelect={setSelectedNodeId}
              onTryAddress={(addr) => handleTrace(addr, {})}
              loading={loading}
            />
          </div>
        </div>

        {/* Mobile Bottom Sheet Sidebar */}
        <div className={`absolute bottom-0 left-0 right-0 z-40 transition-transform duration-300 lg:hidden ${isSidebarOpen && data ? 'translate-y-0' : 'translate-y-full'}`}>
          <div className="h-[60vh] glass-card rounded-b-none border-b-0 shadow-2xl flex flex-col">
            <div className="flex justify-center p-2 cursor-pointer" onClick={() => setIsSidebarOpen(false)}>
              <div className="w-12 h-1.5 bg-white/20 rounded-full" />
            </div>
            <div className="flex-1 overflow-hidden flex flex-col">
              <Sidebar
                data={data}
                selectedNode={selectedNode}
                onNodeSelect={setSelectedNodeId}
                onTryAddress={(addr) => handleTrace(addr, {})}
                loading={loading}
              />
            </div>
          </div>
        </div>
        
        {/* Mobile Toggle Button (when closed and has data) */}
        {data && !isSidebarOpen && (
          <button 
            onClick={() => setIsSidebarOpen(true)}
            className="absolute bottom-6 right-6 lg:hidden z-30 btn-accent shadow-xl"
          >
            View Details
          </button>
        )}

        {/* Loading and Summary Overlay (z-50 ensures it covers HUD and Sidebar) */}
        {(loading || (showSummary && data)) && (
          <div className="absolute inset-0 flex items-center justify-center z-50 bg-slate-900/80 backdrop-blur-sm transition-opacity duration-300">
            <TraceLoadingPanel 
              progress={progress} 
              requestedDepth={requestedDepth} 
              finalData={showSummary && data ? data : null} 
              onContinue={() => setShowSummary(false)} 
            />
          </div>
        )}

      </div>
      
      <AiCopilotDrawer 
        isOpen={isCopilotOpen} 
        onClose={() => setIsCopilotOpen(false)} 
        traceData={data} 
      />
      <AlertsTray />
    </Layout>
  );
}




