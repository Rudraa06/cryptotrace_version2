/**
 * components/Layout.jsx
 * ---------------------------------------------------------------------------
 * Full-page shell: header bar + main content area.
 * The header carries the logo, title, and health indicator.
 */

import StatusIndicator from './StatusIndicator.jsx';
import { useAuth } from '../hooks/AuthContext.jsx';

/**
 * @param {object}           props
 * @param {React.ReactNode}  props.children
 */
export default function Layout({ children, viewMode, onToggleView, onOpenCopilot, onOpenCorrelation, onOpenAdmin }) {
  const { user, logout } = useAuth();

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      {/* ---- Header ---- */}
      <header className="flex items-center justify-between px-3 sm:px-5 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] z-20 flex-shrink-0">
        {/* Left: Brand Identity Header (Stark, Tactical + Logo) */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-sm bg-slate-900 border border-[var(--color-border-subtle)] shadow-sm">
            <img src="/logo.jpeg" alt="CryptoTrace Logo" className="h-6 w-auto rounded-sm opacity-90" />
            <div className="flex flex-col justify-center">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-widest text-slate-100 uppercase">
                  Crypto<span className="text-slate-400 font-normal">Trace</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-[1px]">
                <p className="text-[9px] font-mono font-medium text-slate-500 tracking-[0.1em] uppercase">

                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right: controls + badge */}
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center bg-[rgba(255,255,255,0.03)] rounded-lg p-1 border border-[var(--color-border-subtle)]">
            {onToggleView && (
              <>
                <button 
                  onClick={() => onToggleView('graph')}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-4 py-1 sm:py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'graph' ? 'bg-[var(--color-accent-from)]/10 text-[var(--color-text-accent)] shadow-sm' : 'text-gray-400 hover:text-white'}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
                  <span>Graph</span>
                </button>
                <button 
                  onClick={() => onToggleView('story')}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-4 py-1 sm:py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'story' ? 'bg-[var(--color-accent-from)]/10 text-[var(--color-text-accent)] shadow-sm' : 'text-gray-400 hover:text-white'}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <span>Timeline</span>
                </button>
              </>
            )}
            
            {onOpenCopilot && (
              <button 
                onClick={onOpenCopilot}
                className="flex items-center gap-1.5 px-2.5 sm:px-4 py-1 sm:py-1.5 text-xs font-bold uppercase tracking-wide btn-liquid rounded-md ml-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                <span className="hidden sm:inline">AI Copilot</span>
                <span className="sm:hidden">Copilot</span>
              </button>
            )}

            {onOpenCorrelation && user?.role === 'SUPERVISOR' && (
              <button 
                onClick={onOpenCorrelation}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs font-bold uppercase tracking-wide bg-slate-800 hover:bg-slate-700 text-amber-400 border border-amber-500/30 rounded-md ml-1 transition-colors shadow-sm"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span className="hidden sm:inline">Correlation</span>
              </button>
            )}

            {onOpenAdmin && user?.role === 'SUPERVISOR' && (
              <button 
                onClick={onOpenAdmin}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 text-xs font-bold uppercase tracking-wide bg-slate-800 hover:bg-slate-700 text-purple-400 border border-purple-500/30 rounded-md ml-1 transition-colors shadow-sm"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
                <span className="hidden sm:inline">Admin</span>
              </button>
            )}
          </div>
          
          {/* User Session Info */}
          {user && (
            <div className="flex items-center gap-3 pl-3 sm:pl-4 border-l border-[var(--color-border-subtle)]">
              <div className="hidden sm:flex flex-col text-right">
                <span className="text-xs font-bold text-slate-200 uppercase">{user.email.split('@')[0]}</span>
                <span className={`text-[9px] font-mono tracking-widest ${user.role === 'SUPERVISOR' ? 'text-amber-400' : 'text-slate-500'}`}>
                  {user.role}
                </span>
              </div>
              <button onClick={logout} className="text-slate-500 hover:text-slate-300 transition-colors" title="Disconnect Session">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Floating Status Indicator (Bottom Right) */}
      <div className="absolute bottom-4 right-4 z-50">
        <StatusIndicator />
      </div>

      {/* ---- Main content ---- */}
      <main className="flex-1 min-h-0">
        {children}
      </main>
    </div>
  );
}
