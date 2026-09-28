/**
 * hooks/useHealth.js
 * ---------------------------------------------------------------------------
 * Polls the backend /health endpoint on mount and exposes a reactive status.
 * The poll interval is long (30s) because this is a liveness indicator, not
 * a real-time monitor. The first check runs immediately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHealth } from '../api/client.js';

/**
 * @typedef {object} HealthState
 * @property {boolean}      ok       Backend is healthy.
 * @property {boolean}      checked  At least one check has completed.
 * @property {object|null}  details  Full health response.
 * @property {() => void}   recheck  Force an immediate check.
 */

const POLL_INTERVAL_MS = 30_000;

/**
 * @returns {HealthState}
 */
export function useHealth() {
  const [ok, setOk] = useState(false);
  const [checked, setChecked] = useState(false);
  const [details, setDetails] = useState(null);
  const timerRef = useRef(null);

  const check = useCallback(async () => {
    try {
      const result = await fetchHealth();
      setOk(result.ok === true);
      setDetails(result);
    } catch {
      setOk(false);
      setDetails(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    check();
    timerRef.current = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [check]);

  return { ok, checked, details, recheck: check };
}
