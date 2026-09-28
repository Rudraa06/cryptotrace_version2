import React, { useState } from 'react';
import { useAuth } from '../hooks/AuthContext.jsx';

export default function Login() {
  const { login, completeMfa, error } = useAuth();
  
  const [step, setStep] = useState('LOGIN'); // 'LOGIN', 'FORGOT', 'MFA_SETUP', 'MFA_VERIFY'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);
  
  const [forgotMessage, setForgotMessage] = useState(null);
  
  // MFA States
  const [tempToken, setTempToken] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [qrCodeData, setQrCodeData] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setLocalError(null);
    try {
      const data = await login(email, password);
      
      if (data.requiresMfaSetup) {
        setTempToken(data.tempToken);
        await fetchMfaSetup(data.tempToken);
        setStep('MFA_SETUP');
      } else if (data.requiresMfa) {
        setTempToken(data.tempToken);
        setStep('MFA_VERIFY');
      }
    } catch (err) {
      setLocalError(err.message || 'Authentication failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setLocalError(null);
    setForgotMessage(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || 'Failed to send reset email');
      setForgotMessage(data.message);
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const fetchMfaSetup = async (token) => {
    try {
      const res = await fetch('/api/auth/mfa/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: token })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || 'Failed to generate MFA setup');
      setQrCodeData(data.qrCodeDataUrl);
    } catch (err) {
      setLocalError(err.message);
    }
  };

  const handleMfaVerify = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setLocalError(null);
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken, code: mfaCode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || 'Invalid code');
      
      completeMfa(data.investigator);
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-dvh flex flex-col items-center justify-center bg-[var(--color-bg-primary)] p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 pointer-events-none opacity-20" style={{
        background: 'radial-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px)',
        backgroundSize: '24px 24px'
      }}></div>

      <div className="w-full max-w-sm z-10 dark-panel border border-[var(--color-border-subtle)] shadow-2xl overflow-hidden animate-fade-in">
        <div className="bg-slate-900 border-b border-[var(--color-border-subtle)] p-4 flex items-center justify-center gap-3">
          <img src="/logo.jpeg" alt="CryptoTrace" className="h-8 w-auto rounded opacity-90" />
          <div className="flex flex-col">
            <span className="text-sm font-bold tracking-widest text-slate-100 uppercase">
              Crypto<span className="text-slate-400 font-normal">Trace</span>
            </span>
            <span className="text-[9px] font-mono font-medium text-slate-500 tracking-[0.1em] uppercase">
              Restricted Access
            </span>
          </div>
        </div>

        {step === 'LOGIN' && (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {(error || localError) && (
              <div className="bg-red-900/20 border border-red-500/50 text-red-400 p-3 rounded text-xs font-mono">
                ⚠️ {localError || error}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Investigator ID / Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded p-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors font-mono"
                placeholder="id@cybercell.gov.in"
                autoComplete="username"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Passphrase
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded p-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors font-mono"
                placeholder="••••••••••••"
                autoComplete="current-password"
              />
            </div>

            <div className="flex justify-between items-center mt-2">
              <button
                type="button"
                onClick={() => { setStep('FORGOT'); setLocalError(null); }}
                className="text-[10px] text-amber-500 hover:text-amber-400 font-mono tracking-wider transition-colors"
              >
                FORGOT PASSPHRASE?
              </button>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase text-xs tracking-wider py-3 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Authenticating...' : 'Establish Session'}
            </button>
          </form>
        )}

        {step === 'FORGOT' && (
          <form onSubmit={handleForgotSubmit} className="p-6 space-y-5">
            {localError && (
              <div className="bg-red-900/20 border border-red-500/50 text-red-400 p-3 rounded text-xs font-mono">
                {localError}
              </div>
            )}
            {forgotMessage && (
              <div className="bg-green-900/20 border border-green-500/50 text-green-400 p-3 rounded text-xs font-mono">
                {forgotMessage}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Enter Investigator Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#1A1D24] border border-[var(--color-border-subtle)] rounded p-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 transition-colors font-mono"
                placeholder="id@cybercell.gov.in"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase text-xs tracking-wider py-3 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Processing...' : 'Send Reset Link'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('LOGIN'); setLocalError(null); setForgotMessage(null); }}
              className="w-full text-xs text-slate-400 hover:text-white transition-colors uppercase tracking-wider font-bold"
            >
              Back to Login
            </button>
          </form>
        )}

        {step === 'MFA_SETUP' && (
          <form onSubmit={handleMfaVerify} className="p-6 space-y-4">
            {localError && (
              <div className="bg-red-900/20 border border-red-500/50 text-red-400 p-3 rounded text-xs font-mono">
                ⚠️ {localError}
              </div>
            )}

            <div className="text-center">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest mb-2">Setup Authenticator</h3>
              <p className="text-xs text-slate-400">Scan this QR code with Google Authenticator or Authy to secure your account.</p>
            </div>

            <div className="flex justify-center bg-white p-2 rounded w-40 h-40 mx-auto">
              {qrCodeData ? (
                <img src={qrCodeData} alt="MFA QR Code" className="w-full h-full object-contain" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400 text-xs">Loading...</div>
              )}
            </div>

            <div className="space-y-1.5 pt-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-amber-500 text-center">
                Enter 6-Digit Code
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-[#1A1D24] border border-amber-500/30 rounded p-3 text-lg text-center text-slate-100 placeholder-slate-700 focus:outline-none focus:border-amber-500 transition-colors font-mono tracking-[0.5em]"
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || mfaCode.length !== 6}
              className="w-full mt-2 bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase text-xs tracking-wider py-3 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Verifying...' : 'Verify & Complete Setup'}
            </button>
          </form>
        )}

        {step === 'MFA_VERIFY' && (
          <form onSubmit={handleMfaVerify} className="p-6 space-y-5">
            {localError && (
              <div className="bg-red-900/20 border border-red-500/50 text-red-400 p-3 rounded text-xs font-mono">
                ⚠️ {localError}
              </div>
            )}

            <div className="text-center pb-2">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest mb-1">Two-Factor Auth</h3>
              <p className="text-xs text-slate-400">Open your authenticator app.</p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-amber-500 text-center">
                Enter 6-Digit Code
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-[#1A1D24] border border-amber-500/30 rounded p-3 text-lg text-center text-slate-100 placeholder-slate-700 focus:outline-none focus:border-amber-500 transition-colors font-mono tracking-[0.5em]"
                placeholder="000000"
                autoComplete="one-time-code"
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || mfaCode.length !== 6}
              className="w-full mt-2 bg-amber-600 hover:bg-amber-500 text-white font-bold uppercase text-xs tracking-wider py-3 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Authenticating...' : 'Verify'}
            </button>
            
            <button
              type="button"
              onClick={() => { setStep('LOGIN'); setLocalError(null); setPassword(''); setMfaCode(''); }}
              className="w-full text-xs text-slate-400 hover:text-white transition-colors uppercase tracking-wider font-bold"
            >
              Cancel
            </button>
          </form>
        )}

        <div className="bg-slate-900/50 p-3 border-t border-[var(--color-border-subtle)] text-center">
          <p className="text-[10px] text-slate-500 font-mono">
            UNAUTHORIZED ACCESS IS PROHIBITED. ALL ACTIVITY IS LOGGED.
          </p>
        </div>
      </div>
    </div>
  );
}






