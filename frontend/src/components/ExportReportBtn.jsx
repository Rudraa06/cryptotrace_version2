import React, { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { API_BASE } from '../utils/constants.js';

/**
 * ExportReportBtn
 * ---------------------------------------------------------------------------
 * Calls the server-side /api/export/evidence endpoint which generates the 
 * full BSA Section 65B court-admissible PDF with:
 *   - SHA-256 hash integrity of the trace payload
 *   - OFAC sanctions screening record
 *   - BTC UTXO clustering disclaimer (when applicable)
 *   - Investigator identity from the session cookie
 *   - Demo watermark when running outside real auth
 */
export default function ExportReportBtn({ traceData }) {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    if (!traceData) return;
    setLoading(true);

    try {
      // 1. Capture graph screenshot if canvas exists
      let graphScreenshot = null;
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        try {
          // Find the largest canvas to determine dimensions
          let maxWidth = 0;
          let maxHeight = 0;
          canvases.forEach(c => {
            if (c.width > maxWidth) maxWidth = c.width;
            if (c.height > maxHeight) maxHeight = c.height;
          });

          if (maxWidth > 0 && maxHeight > 0) {
            // Create a composite offscreen canvas
            const composite = document.createElement('canvas');
            composite.width = maxWidth;
            composite.height = maxHeight;
            const ctx = composite.getContext('2d');

            // Fill with the application's dark background color so transparent pixels aren't rendered black
            ctx.fillStyle = '#0A0E17'; 
            ctx.fillRect(0, 0, maxWidth, maxHeight);

            // Draw every canvas over the background
            canvases.forEach(c => {
              ctx.drawImage(c, 0, 0);
            });

            // Save the composited image
            graphScreenshot = composite.toDataURL('image/jpeg', 0.85);
          }
        } catch (e) {
          console.error("Failed to composite canvases", e);
        }
      }

      const payload = {
        ...traceData,
        graphScreenshot
      };

      const res = await fetch(`${API_BASE}/api/export/evidence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest', // CSRF bypass for same-origin
        },
        credentials: 'include', // Send the HttpOnly session cookie
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        const msg = errorBody?.error?.message || errorBody?.message || `Export failed (HTTP ${res.status})`;
        alert(msg);
        return;
      }

      // The server streams a PDF binary — save it as a file download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CryptoTrace_Evidence_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!import.meta.env.PROD) console.error('Export failed', error);
      alert('Failed to generate export. Check console.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      className="btn-liquid flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold tracking-wide uppercase transition-colors"
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <FileText className="w-4 h-4" />
      )}
      {loading ? 'Generating Brief...' : 'Export Court PDF'}
    </button>
  );
}
