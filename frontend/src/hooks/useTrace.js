/**
 * hooks/useTrace.js
 * ---------------------------------------------------------------------------
 * Manages the lifecycle of a single trace request: idle → loading → result/error.
 *
 * The hook does NOT auto-fire on mount. The caller invokes `trace(address, opts)`
 * and the hook updates `{ data, error, loading }` accordingly. A new call while
 * one is in flight replaces the old one (stale closure guard).
 */

import { useCallback, useRef, useState } from 'react';
import { traceAddress, ingestComplaint } from '../api/client.js';

/**
 * @typedef {object} TraceState
 * @property {object|null}  data     Parsed backend response.
 * @property {Error|null}   error    ApiError or generic Error.
 * @property {boolean}      loading  True while a request is in flight.
 * @property {(address: string, opts?: object) => Promise<void>} trace
 * @property {() => void}   reset    Clear data and error.
 */

/**
 * @returns {TraceState}
 */
export function useTrace() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);

  // Monotonic request ID so a stale response cannot overwrite a fresh one.
  const reqId = useRef(0);

  const trace = useCallback(async (address, opts = {}) => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setData(null);
    setProgress({ stage: 'started', message: 'Initiating trace request...', detail: '', logs: [] });

    const handleProgress = (event) => {
      if (id !== reqId.current) return; // stale closure check
      setProgress(prev => {
        const logs = [...(prev?.logs || []), event];
        return { ...event, logs };
      });
    };

    try {
      let result;
      if (opts.complaintId) {
        const payload = {
          walletAddress: address,
          complaintId: opts.complaintId,
          fraudType: opts.fraudType,
          maxHops: opts.maxHops
        };
        const res = await ingestComplaint(payload, handleProgress);
        // The ingest endpoint wraps the traceResult in { ok, caseId, complaintId, fraudType, traceResult }
        // We inject the context back into traceResult so the UI can read it
        if (res.traceResult) {
          result = {
            ...res.traceResult,
            caseId: res.caseId,
            complaintId: res.complaintId,
            fraudType: res.fraudType
          };
        } else {
          result = res;
        }
      } else {
        result = await traceAddress(address, opts, handleProgress);
      }
      
      // Guard: only apply if this is still the latest request.
      if (id === reqId.current) {
        setData(result);
      }
    } catch (err) {
      if (id === reqId.current) {
        setError(err);
      }
    } finally {
      if (id === reqId.current) {
        setLoading(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    reqId.current += 1;
    setData(null);
    setError(null);
    setLoading(false);
    setProgress(null);
  }, []);

  return { data, error, loading, progress, trace, reset };
}
