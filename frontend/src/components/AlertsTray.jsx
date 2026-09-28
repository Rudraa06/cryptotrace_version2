/**
 * components/AlertsTray.jsx
 * ---------------------------------------------------------------------------
 * PHASE 7/9: Alerts Notification Tray
 * 
 * Periodically polls /api/alerts (every 5 seconds) to fetch automated alerts
 * generated when high-risk thresholds are crossed.
 */

import { useEffect, useState } from 'react';
import { API_BASE } from '../utils/constants.js';

export default function AlertsTray() {
  const [alerts, setAlerts] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState(null);

  const fetchAlerts = async () => {
    try {
      const headers = {
        'X-Requested-With': 'XMLHttpRequest'
      };
      const res = await fetch(`${API_BASE}/api/alerts`, { headers, credentials: 'include' });
      const data = await res.json();
      if (data.ok && Array.isArray(data.alerts)) {
        setAlerts(data.alerts);
        
        // Count unread (newer than lastSeenTimestamp)
        if (lastSeenTimestamp) {
          const unread = data.alerts.filter(
            (a) => new Date(a.timestamp) > new Date(lastSeenTimestamp)
          ).length;
          setUnreadCount(unread);
        } else {
          setUnreadCount(data.alerts.length);
        }
      }
    } catch (err) {
      if (!import.meta.env.PROD) console.error('Failed to fetch alerts', err);
    }
  };

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 5000);
    return () => clearInterval(interval);
  }, [lastSeenTimestamp]);

  const toggleOpen = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setUnreadCount(0);
      setLastSeenTimestamp(new Date().toISOString());
    }
  };

  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col items-start pointer-events-auto">
      {/* Alert List Drawer */}
      {isOpen && (
        <div className="dark-panel w-80 max-h-96 flex flex-col mb-2 shadow-2xl border-l-2 border-l-[#E11D48] overflow-hidden bg-[var(--color-bg-card)]">
          <div className="px-4 py-2.5 bg-[#1A1D24] border-b border-[var(--color-border-subtle)] flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-[#E11D48] flex items-center gap-1.5 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-[#E11D48]" />
              Threat Center
            </span>
            <span className="text-[10px] text-[var(--color-text-muted)] font-mono">{alerts.length} active</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2 max-h-72">
            {alerts.length === 0 ? (
              <p className="text-center text-xs text-[var(--color-text-muted)] py-8 font-medium">
                No active threats detected.
              </p>
            ) : (
              alerts.map((alert, i) => (
                <div key={i} className="p-2.5 rounded border border-[#E11D48]/20 bg-[#E11D48]/5 space-y-1 text-[11px]">
                  <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    <span className="text-[#E11D48]">Case: {alert.caseId}</span>
                    <span className="text-[var(--color-text-muted)] font-mono">
                      {new Date(alert.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-[var(--color-text-primary)] font-semibold leading-relaxed">
                    {alert.reason}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-muted)] truncate font-mono">
                    {alert.walletAddress}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main Alert Bubble Button */}
      <button
        onClick={toggleOpen}
        className={`flex items-center gap-2.5 px-4 py-2.5 rounded-md font-semibold text-xs uppercase tracking-wider border shadow-lg transition-all ${
          unreadCount > 0
            ? 'bg-[#E11D48] text-white border-[#E11D48] hover:bg-[#E11D48]/90 scale-105 animate-bounce'
            : 'bg-[#1A1D24] text-[var(--color-text-secondary)] border-[var(--color-border-subtle)] hover:text-white'
        }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        <span>Alerts</span>
        {unreadCount > 0 && (
          <span className="bg-black/30 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold">
            {unreadCount}
          </span>
        )}
      </button>
    </div>
  );
}
