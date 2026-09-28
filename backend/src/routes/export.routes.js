import { Router } from 'express';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import os from 'os';
import { logger } from '../lib/logger.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logAuditAction } from '../services/audit.service.js';
import { getSanctionsStatus } from '../services/sanctions.service.js';
import { requireCsrf } from '../middleware/auth.js';
import { runInTransaction } from '../services/neo4j.service.js';

export const exportRouter = Router();

/**
 * POST /api/export/evidence
 * Accepts a JSON payload containing trace data.
 * Generates a SHA-256 hash of the JSON and produces a BSA Section 63 Compliant Evidence PDF.
 */
exportRouter.post(
  '/export/evidence',
  requireCsrf,
  asyncRoute(async (req, res) => {
    const traceData = req.body;
    
    if (!traceData || Object.keys(traceData).length === 0) {
      return res.status(400).json({ ok: false, message: 'Missing trace data payload' });
    }

    const targetAddress = traceData.query?.address || traceData.targetAddress;
    if (!targetAddress) {
      return res.status(400).json({ ok: false, message: 'Cannot identify target address from trace payload.' });
    }

    // RBAC: Enforce Case Scoping for INVESTIGATOR role
    if (req.investigator.role === 'INVESTIGATOR') {
      let isAssigned = false;
      await runInTransaction('READ', async (tx) => {
        const result = await tx.run(
          `MATCH (c:Case)-[:ASSIGNED_TO]->(i:Investigator {id: $investigatorId})
           WHERE toLower(c.suspectWallet) = $targetAddress OR toLower(c.victimWallet) = $targetAddress
           RETURN c LIMIT 1`,
          { investigatorId: req.investigator.id, targetAddress: targetAddress.toLowerCase() }
        );
        if (result.records.length > 0) isAssigned = true;
      });

      if (!isAssigned) {
        return res.status(403).json({ 
          ok: false, 
          error: { code: 'FORBIDDEN', message: 'You are not assigned to a case involving this address. Export denied.' } 
        });
      }
    }

    // 1. Generate SHA-256 hash of the payload
    const jsonString = JSON.stringify(traceData);
    const hash = crypto.createHash('sha256').update(jsonString).digest('hex');
    const timestamp = new Date().toISOString();
    
    const investigatorName = req.investigator?.name || 'UNKNOWN_INVESTIGATOR';
    const investigatorId = req.investigator?.id || 'UNKNOWN';
    const sanctions = getSanctionsStatus();

    logger.info('Generating Evidence Export PDF', { hash, investigator: investigatorId });
    await logAuditAction('EXPORT_EVIDENCE', req.investigator, { hash, targetAddress });

    // 2. Setup PDF document
    const doc = new PDFDocument({ margin: 50 });
    
    // 3. Pipe to response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CryptoTrace_Evidence_${Date.now()}.pdf"`);
    doc.pipe(res);

    // --- Hard Safeguard: Unmistakable Watermark for Demo Auth ---
    const isDemoAuth = !req.investigator || req.investigator.name.includes('Demo') || req.investigator.name.includes('UNKNOWN');
    if (isDemoAuth) {
      doc.save();
      doc.fillColor('red').opacity(0.15).fontSize(60);
      doc.translate(doc.page.width / 2, doc.page.height / 2);
      doc.rotate(-45, { origin: [0, 0] });
      doc.text('DEMO — NOT FOR ACTUAL USE', -300, 0, { align: 'center', width: 600 });
      doc.restore();
    }

    // Document Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .fillColor('black')
      .text('IN THE COURT OF ________________________', { align: 'center' })
      .fontSize(12)
      .text('Case No. ________________________ of 20___', { align: 'center' })
      .moveDown(1)
      .text('Between:', { align: 'left' })
      .text('________________________ (Petitioner/Complainant)')
      .text('And')
      .text('________________________ (Respondent/Accused)')
      .moveDown(1.5)
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('AFFIDAVIT / CERTIFICATE UNDER SECTION 65B OF THE INDIAN EVIDENCE ACT, 1872', { align: 'center' })
      .moveDown(1.5);

    // --- Identification / Deponent Line ---
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(`I, ${investigatorName}, S/O/D/O ________________________, aged about _____ years, R/o ________________________, do hereby solemnly affirm and state as under:`, { align: 'justify' })
      .moveDown(1);

    // --- Statements 1-2 & Device Particulars ---
    doc.text('1. I state that the electronic record in the form of the CryptoTrace graph output, trace report, and associated blockchain data attached hereto as Annexure-A, was produced by a computer operated by me.', { align: 'justify' }).moveDown(0.5);
    doc.text('2. I state that the said printouts/digital documents were taken from the computer owned/maintained/operated by me, with the device and system particulars as follows:', { align: 'justify' }).moveDown(0.5);

    doc.text(`   - OS Name: ${os.type()}`, { indent: 20 });
    doc.text(`   - Version: ${os.release()}`, { indent: 20 });
    doc.text('   - OS Manufacturer: ________________________', { indent: 20 });
    doc.text(`   - System Name: ${os.hostname()}`, { indent: 20 });
    doc.text('   - System Manufacturer: ________________________', { indent: 20 });
    doc.text('   - System Model: ________________________', { indent: 20 });
    doc.text('   - Start-up disk: ________________________', { indent: 20 });
    doc.text(`   - Installed Physical Memory (RAM): ${Math.round(os.totalmem() / (1024 ** 3))} GB`, { indent: 20 }).moveDown(0.5);

    // --- Statements 3-6 (Verbatim from Act/User) ---
    doc.text('3. I state that the computer output containing the information was produced by the computer during the period over which the computer was used regularly to store or process information for the purposes of any activities regularly carried on over that period by me having lawful control over the use of the computer.', { align: 'justify' }).moveDown(0.5);
    doc.text('4. I state that during the said period, information of the kind contained in the electronic record or of the kind from which the information so contained is derived was regularly fed into the computer in the ordinary course of the said activities.', { align: 'justify' }).moveDown(0.5);
    doc.text('5. I state that throughout the material part of the said period the computer was operating properly without affecting the contents of the electronic record or its accuracy or its contents.', { align: 'justify' }).moveDown(0.5);
    doc.text('6. I state that the information contained in the electronic record reproduces or is derived from such information fed into the computer in the ordinary course of the said activities.', { align: 'justify' }).moveDown(1.5);

    // --- Sanctions Screening Record ---
    doc.font('Helvetica-Bold').fontSize(10).text('OFAC SANCTIONS SCREENING RECORD', { align: 'left' }).moveDown(0.3);
    doc.font('Helvetica').fontSize(9);

    // Collect any sanctioned addresses from the trace data nodes
    const traceNodes = traceData.nodes || [];
    const sanctionedNodes = traceNodes.filter(n => n.sanctionsHit === true);

    if (!sanctions.isUnavailable) {
      doc.fillColor('black').text(
        `Sanctions list checked against: U.S. Treasury OFAC Specially Designated Nationals (SDN) List.`,
        { align: 'left' }
      );
      doc.text(`List synchronised at: ${sanctions.lastSyncedAt} (${sanctions.addressCount} digital currency addresses indexed).`, { align: 'left' }).moveDown(0.3);

      if (sanctionedNodes.length > 0) {
        doc.fillColor('red').font('Helvetica-Bold');
        doc.text(`⚠ WARNING: ${sanctionedNodes.length} SANCTIONED ADDRESS(ES) IDENTIFIED IN THIS TRACE:`, { align: 'left' }).moveDown(0.2);
        doc.font('Helvetica');
        sanctionedNodes.forEach(n => {
          doc.text(`   • ${n.id} (checked at: ${n.sanctionsScreeningAt ?? 'unknown'})`, { indent: 10 });
        });
        doc.text('Interaction with OFAC-sanctioned addresses may constitute a violation of applicable sanctions law. This finding must be escalated to a compliance officer immediately.', { align: 'justify' }).moveDown(0.5);
        doc.fillColor('black');
      } else {
        doc.fillColor('black').text(
          `Screening result: No match found for any traced address on the OFAC SDN list as of the synchronisation date above. ` +
          `This indicates absence from this specific list at the time of synchronisation; it does not guarantee a clean bill of health, ` +
          `compliance, or absence from other international watchlists.`,
          { align: 'justify' }
        ).moveDown(0.5);
      }
    } else {
      doc.fillColor('red').font('Helvetica-Bold');
      doc.text('⚠ SANCTIONS SCREENING UNAVAILABLE: The OFAC SDN list could not be loaded at the time this report was generated.', { align: 'justify' });
      doc.font('Helvetica').fillColor('black');
      doc.text('Absence of a sanctions warning in this document does NOT confirm that any traced address is sanctions-free. Manual verification against the OFAC SDN list is required before any further action is taken.', { align: 'justify' }).moveDown(0.5);
    }
    doc.moveDown(1);

    // --- BTC UTXO Clustering Disclaimer ---
    const hasBtc = (traceNodes.length > 0 && traceNodes.some(n => n.memberAddresses && n.memberAddresses.length > 0)) ||
                   (traceData.query && traceData.query.address && /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc1)[0-9A-Za-z]{39,59}$/i.test(traceData.query.address));

    if (hasBtc) {
      doc.font('Helvetica-Bold').fontSize(10).text('BITCOIN (UTXO) CLUSTERING AND HOP RESOLUTION', { align: 'left' }).moveDown(0.3);
      doc.font('Helvetica').fontSize(9);
      doc.fillColor('black').text(
        'For Bitcoin (BTC) and other UTXO-based chains, this system groups cryptographically linked addresses into "clusters" ' +
        'representing a single controlling entity. Where a transfer is shown between two clusters, the system explicitly resolves ' +
        'and displays the earliest transaction chronologically that proves funds flowed between them. This specific surfaced ' +
        'transaction is not necessarily the complete or only money-laundering transfer between the clusters; other later or larger ' +
        'transactions may exist but are abstracted by this edge representation.',
        { align: 'justify' }
      ).moveDown(1);
    }

    // --- First Signature Block ---
    doc.font('Helvetica-Bold').text('Deponent: ________________________', { align: 'right' });
    doc.font('Helvetica').text('(Signature)', { align: 'right' }).moveDown(2);

    // --- VERIFICATION ---
    doc.font('Helvetica-Bold').text('VERIFICATION', { align: 'center' }).moveDown(0.5);
    doc.font('Helvetica').text('Verified at ________________________ on this _____ day of __________________, 20___, that the contents of the above affidavit are true and correct to the best of my knowledge and belief, and that nothing material has been concealed therefrom.', { align: 'justify' }).moveDown(2);

    // --- Second Signature Block ---
    doc.font('Helvetica-Bold').text('Deponent: ________________________', { align: 'right' });
    doc.font('Helvetica').text('(Signature)', { align: 'right' }).moveDown(3);

    // --- DISCLAIMER ---
    doc
      .fontSize(9)
      .font('Helvetica-Oblique')
      .fillColor('red')
      .text(
        '\nDISCLAIMER: This certificate has been generated in a format intended to align with Section 65B of the Indian Evidence Act, 1872. It has not been reviewed by legal counsel and should be verified by a qualified legal professional before being relied upon in any proceeding.',
        { align: 'justify' }
      )
      .fillColor('black');

    // --- ANNEXURE-A: GRAPH VISUALIZATION ---
    if (traceData.graphScreenshot) {
      doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('ANNEXURE-A: GRAPH VISUALIZATION', { align: 'center' }).moveDown(1);
      try {
        const base64Data = traceData.graphScreenshot.replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imgBuffer, {
          fit: [500, 700],
          align: 'center',
          valign: 'center'
        });
      } catch (err) {
        logger.error('Failed to embed graph screenshot in PDF', { error: err.message });
      }
    }

    // --- ANNEXURE-B: AI CASE BRIEF ---
    if (traceData.aiNarrative?.brief) {
      const brief = traceData.aiNarrative.brief;
      doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('ANNEXURE-B: FORENSIC CASE BRIEF', { align: 'center' }).moveDown(1);
      
      doc.fontSize(12).font('Helvetica-Bold').text('EXECUTIVE SUMMARY');
      doc.fontSize(10).font('Helvetica').text(brief.executiveSummary || 'N/A', { align: 'justify' }).moveDown(1);
      
      doc.fontSize(12).font('Helvetica-Bold').text('MODUS OPERANDI');
      const mo = Array.isArray(brief.modusOperandi) ? brief.modusOperandi : [brief.modusOperandi];
      mo.forEach(step => {
        if (step) doc.fontSize(10).font('Helvetica').text(`• ${step}`, { indent: 15 });
      });
      doc.moveDown(1);

      doc.fontSize(12).font('Helvetica-Bold').text('ACTIONABLE NEXT STEPS');
      doc.fontSize(10).font('Helvetica').text(brief.actionableNextSteps || 'N/A', { align: 'justify' }).moveDown(1);

      doc.fontSize(12).font('Helvetica-Bold').text('SUBPOENA NOTICE DRAFT');
      doc.fontSize(10).font('Helvetica').text(brief.subpoenaNotice || 'N/A', { align: 'justify' });
    }

    // --- ANNEXURE-C: SUBPOENA JUSTIFICATION & TRANSACTION LOGS ---
    if (traceData.paths && traceData.paths.length > 0) {
      doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('ANNEXURE-C: SUBPOENA JUSTIFICATION & TRANSACTION LOGS', { align: 'center' }).moveDown(1);
      
      doc.fontSize(10).font('Helvetica').text(
        'The following tabular logs represent the cryptographic transaction paths identified on the blockchain. ' +
        'This direct chain of custody demonstrates the flow of illicit funds from the subject wallet to the exchange deposit addresses, ' +
        'establishing probable cause for subpoena.', 
        { align: 'justify' }
      ).moveDown(1.5);

      traceData.paths.forEach((path, idx) => {
        const exchangeName = path.exchange?.exchange || 'Unknown Exchange';
        const exchangeLabel = path.exchange?.label || '';
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('black')
           .text(`CASH-OUT ROUTE #${idx + 1} ➔ ${exchangeName} ${exchangeLabel ? `(${exchangeLabel})` : ''}`);
        doc.moveDown(0.5);

        // Table Header
        doc.fontSize(8).font('Courier-Bold');
        const startY = doc.y;
        doc.text('HOP', 50, startY);
        doc.text('DATE (UTC)', 80, startY);
        doc.text('TXN HASH', 190, startY);
        doc.text('VALUE (USD)', 390, startY);
        doc.moveDown(0.5);
        
        // Table line
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(0.5);

        doc.font('Courier');
        if (path.steps && path.steps.length > 0) {
          path.steps.forEach((step, stepIdx) => {
            const rowY = doc.y;
            // Handle page breaks manually if needed, but PDFKit handles basic text wrapping. 
            // For a simple table, absolute X positioning per row works best:
            const dateStr = step.timestamp ? new Date(Number(step.timestamp) * 1000).toISOString().split('T')[0] : 'Unknown';
            const hashStr = step.hash ? `${step.hash.substring(0, 10)}...${step.hash.substring(step.hash.length - 8)}` : 'N/A';
            const valStr = step.valueUsd ? `$${Number(step.valueUsd).toFixed(2)}` : (step.amount ? `${step.amount} ${step.asset || ''}` : 'Unknown');
            
            doc.text(`${step.hop || stepIdx + 1}`, 50, rowY);
            doc.text(dateStr, 80, rowY);
            doc.text(hashStr, 190, rowY);
            doc.text(valStr, 390, rowY);
            
            // Advance Y for next row explicitly since we used absolute X/Y
            doc.y = rowY + 12;

            // Simple page break check
            if (doc.y > 700) {
              doc.addPage();
              doc.y = 50;
            }
          });
        } else {
          doc.text('No transaction steps available for this route.', 50, doc.y);
          doc.y += 12;
        }
        doc.moveDown(2);
      });
    }

    // Finalize PDF
    doc.end();
  })
);
