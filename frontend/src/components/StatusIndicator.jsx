/**
 * components/StatusIndicator.jsx
 * ---------------------------------------------------------------------------
 * A small dot that shows green/red based on backend health. Sits in the header.
 */

import { useHealth } from '../hooks/useHealth.js';

export default function StatusIndicator() {
  const { ok, checked } = useHealth();

  if (!checked) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
        <span className="status-dot warn" />
        Connecting…
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={`status-dot ${ok ? 'ok' : 'error'}`} />
      <span className={ok ? 'text-[var(--color-status-ok)]' : 'text-[var(--color-status-error)]'}>
        {ok ? 'Backend Online' : 'Backend Offline'}
      </span>
    </span>
  );
}
