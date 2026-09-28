/**
 * components/SearchBar.jsx
 * ---------------------------------------------------------------------------
 * The primary input: an Ethereum address field with a "Trace" button.
 * Validates the address format before submitting.
 */

import { useCallback, useState, useEffect } from 'react';

// ETH: 0x + 40 hex digits
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
// BTC P2PKH (starts with 1), P2SH (starts with 3): Base58Check, 25-34 chars
// BTC Bech32 (starts with bc1): 39-59 alphanumeric chars
const BTC_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i;

function isValidAddress(addr) {
  return ETH_RE.test(addr) || BTC_RE.test(addr);
}

function getChainLabel(addr) {
  if (ETH_RE.test(addr)) return 'ETH';
  if (BTC_RE.test(addr)) return 'BTC';
  return null;
}

/**
 * @param {object} props
 * @param {(address: string, opts: object) => void} props.onTrace
 * @param {boolean} props.loading
 */
export default function SearchBar({ onTrace, loading }) {
  const [address, setAddress] = useState('');
  const [complaintId, setComplaintId] = useState('');
  const [fraudType, setFraudType] = useState('investment_scam');
  const [victimWallet, setVictimWallet] = useState('');
  const [maxHops, setMaxHops] = useState(15);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    const handleFillDemo = (e) => {
      const { address: newAddr, label } = e.detail;
      setAddress(newAddr);
      setValidationError('');
      
      // Attempt to parse test case number from label "Test Case X: ..."
      const match = label.match(/Test Case (\d)/);
      if (match) {
        setComplaintId(`NCRP-TEST-00${match[1]}`);
        
        // Auto-select a plausible fraud typology based on the test case
        const num = match[1];
        if (num === '1') setFraudType('investment_scam'); // Peeling
        if (num === '2') setFraudType('other'); // Cross-chain
        if (num === '3') setFraudType('darknet_transaction'); // Mixer
        if (num === '4') setFraudType('task_based_fraud'); // Smurfing
      }
    };
    
    window.addEventListener('fill-demo', handleFillDemo);
    return () => window.removeEventListener('fill-demo', handleFillDemo);
  }, []);

  const handleComplaintChange = (e) => {
    const val = e.target.value;
    setComplaintId(val);
    setValidationError('');

    // Demo Autofill Logic
    if (val === 'NCRP-TEST-001') {
      setAddress('0x28C6c06298d514Db089934071355E5743bf21d60');
      setFraudType('investment_scam');
    } else if (val === 'NCRP-TEST-002') {
      setAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'); // Another mock address
      setFraudType('phishing');
    }
  };

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const trimmed = address.trim();

      if (!trimmed) {
        setValidationError('Enter a target wallet address');
        return;
      }
      if (!isValidAddress(trimmed)) {
        setValidationError('Invalid address — expected ETH (0x…) or BTC (1…/3…/bc1…)');
        return;
      }
      if (!complaintId.trim()) {
        setValidationError('Enter a Complaint ID (e.g., NCRP-2026-001)');
        return;
      }

      setValidationError('');
      onTrace(trimmed, { 
        maxHops, 
        complaintId: complaintId.trim(),
        fraudType,
        victimWallet: victimWallet.trim() || undefined
      });
    },
    [address, maxHops, complaintId, fraudType, onTrace]
  );

  return (
    <div className="dark-panel w-full max-w-4xl mx-auto flex flex-col overflow-hidden shadow-lg border-t-4 border-t-[var(--color-border-accent)] bg-[var(--color-bg-card)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border-subtle)] bg-[#1A1D24]">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
          <svg className="w-4 h-4 text-[var(--color-text-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Active Case Intake
        </div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[var(--color-text-muted)] hover:text-white transition-colors p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        </button>
      </div>

      {/* Main Form Row */}
      <form onSubmit={handleSubmit} className="p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        {/* Complaint ID */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Complaint ID</label>
          <input
            type="text"
            value={complaintId}
            onChange={handleComplaintChange}
            placeholder="NCRP-2026-..."
            className="bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded px-3 h-10 text-sm text-white placeholder-[var(--color-text-muted)] glow-input w-full"
          />
        </div>

        {/* Fraud Typology */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Fraud Typology</label>
          <div className="relative">
            <select
              value={fraudType}
              onChange={(e) => setFraudType(e.target.value)}
              className="bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded pl-3 pr-8 h-10 text-sm text-white glow-input appearance-none w-full"
            >
              <option value="investment_scam">Investment Scam</option>
              <option value="task_based_fraud">Task-based Fraud</option>
              <option value="sextortion">Sextortion</option>
              <option value="ransomware">Ransomware</option>
              <option value="phishing">Phishing</option>
              <option value="darknet_transaction">Darknet Transaction</option>
              <option value="other">Other</option>
            </select>
            {/* Custom dropdown arrow */}
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-[var(--color-text-muted)]">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
          </div>
        </div>

        {/* Target Wallet (Suspect) */}
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Suspect Wallet</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={address}
              onChange={(e) => { setAddress(e.target.value); setValidationError(''); }}
              placeholder="Enter suspect wallet address (e.g. 0x... or bc1...)"
              spellCheck={false}
              className="flex-1 bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded px-3 h-10 text-sm text-white placeholder-[var(--color-text-muted)] mono-data glow-input"
            />
          </div>
        </div>

        {/* Victim Wallet (Optional) */}
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Victim Wallet (Optional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={victimWallet}
              onChange={(e) => setVictimWallet(e.target.value)}
              placeholder="Enter victim wallet address (optional)"
              spellCheck={false}
              className="flex-1 bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded px-3 h-10 text-sm text-white placeholder-[var(--color-text-muted)] mono-data glow-input"
            />
            <button
              type="submit"
              disabled={loading}
              className="btn-accent flex items-center justify-center w-10 h-10 !p-0 flex-shrink-0 rounded"
              title="Run Trace"
            >
              {loading ? (
                <svg className="w-4 h-4 text-[#161920] animate-spin-slow" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-[#161920]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Validation error */}
      {validationError && (
        <p className="mt-2 text-xs text-[var(--color-status-error)] pl-4 animate-fade-in">
          {validationError}
        </p>
      )}

      {/* Advanced options */}
      {showAdvanced && (
        <div className="glass-card mt-2 p-4 animate-fade-in flex items-center gap-6 text-sm border-t-2 border-t-[var(--color-border-accent)] bg-[rgba(10,14,23,0.8)]">
          <label className="flex items-center gap-3 text-[var(--color-text-secondary)] mono-data uppercase tracking-wider text-[11px]">
            <span className="whitespace-nowrap">Max Hops</span>
            <input
              type="range"
              min={1}
              max={25}
              value={maxHops}
              onChange={(e) => setMaxHops(Number(e.target.value))}
              className="w-32 accent-[var(--color-accent-from)]"
            />
            <span className="font-mono text-[var(--color-text-accent)] w-6 text-right font-bold">{maxHops}</span>
          </label>
        </div>
      )}
    </div>
  );
}
