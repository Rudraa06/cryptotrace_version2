import { useState } from 'react';
import { fetchJson } from '../api/client.js';

export default function CorrelationLookup({ onClose }) {
  const [victimWallet, setVictimWallet] = useState('');
  const [suspectWallet, setSuspectWallet] = useState('');
  const [maxHops, setMaxHops] = useState(15);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleCorrelate = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await fetchJson('/api/trace/correlate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ victimWallet, suspectWallet, maxHops }),
      });
      if (!data.ok) throw new Error(data.error || 'Failed to correlate');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute top-16 left-4 z-50 w-96 glass-card p-4 rounded-xl shadow-2xl animate-fade-in border border-[var(--color-border-subtle)] bg-slate-900/90 backdrop-blur-xl">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold tracking-wide uppercase text-slate-100 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Cross-Case Lookup
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <form onSubmit={handleCorrelate} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Victim Wallet</label>
          <input
            type="text"
            className="w-full bg-slate-800/50 border border-slate-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
            placeholder="0x..."
            value={victimWallet}
            onChange={(e) => setVictimWallet(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Suspect Wallet</label>
          <input
            type="text"
            className="w-full bg-slate-800/50 border border-slate-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
            placeholder="0x..."
            value={suspectWallet}
            onChange={(e) => setSuspectWallet(e.target.value)}
            required
          />
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={loading}
            className="btn-primary text-xs px-4 py-1.5 font-semibold uppercase tracking-wider"
          >
            {loading ? 'Analyzing...' : 'Run Correlation'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-red-900/20 border border-red-500/30 rounded text-xs text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-3">
          <div className="p-3 bg-slate-800/50 rounded border border-slate-700">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">Direct Link Check</h4>
            {result.directLink?.found ? (
              <p className="text-xs text-emerald-400 font-medium">
                Confirmed: {result.directLink.hops} hops between victim and suspect.
              </p>
            ) : (
              <p className="text-xs text-gray-400">
                No direct on-chain route found within {maxHops} hops.
              </p>
            )}
          </div>
          
          <div className="p-3 bg-slate-800/50 rounded border border-slate-700">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">Cross-Case Footprint</h4>
            {result.footprint?.cases > 0 ? (
              <>
                <p className="text-xs text-amber-400 font-medium mb-1">
                  Suspect wallet linked to {result.footprint.cases} other cases.
                </p>
                <ul className="text-xs text-gray-400 space-y-1 mt-2 max-h-24 overflow-y-auto pr-1">
                  {result.footprint.roles.map((r, i) => (
                    <li key={i} className="flex justify-between border-b border-slate-700/50 pb-1">
                      <span>{r.caseId}</span>
                      <span className="capitalize">{r.role}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-gray-400">
                No footprint in other reported cases.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
