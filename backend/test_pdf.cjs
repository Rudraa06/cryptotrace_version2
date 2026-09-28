const fs = require('fs');
const PDFDocument = require('pdfkit');

const doc = new PDFDocument({ margin: 50 });
doc.pipe(fs.createWriteStream('C:/Users/rudra/.gemini/antigravity-ide/brain/229e785c-2a2a-4cec-8ff9-345666b8ad3e/65B_Certificate_Test.pdf'));

const apiKey = 'DEMO_INVESTIGATOR';

doc.fontSize(18).font('Helvetica-Bold').text('IN THE COURT OF ________________________', { align: 'center' })
  .fontSize(12).text('Case No. ________________________ of 20___', { align: 'center' }).moveDown(1)
  .text('Between:', { align: 'left' })
  .text('________________________ (Petitioner/Complainant)')
  .text('And')
  .text('________________________ (Respondent/Accused)')
  .moveDown(1.5).fontSize(14).font('Helvetica-Bold')
  .text('AFFIDAVIT / CERTIFICATE UNDER SECTION 65B OF THE INDIAN EVIDENCE ACT, 1872', { align: 'center' }).moveDown(1.5);

doc.fontSize(10).font('Helvetica')
  .text(`I, ${apiKey}, S/O/D/O ________________________, aged about _____ years, R/o ________________________, do hereby solemnly affirm and state as under:`, { align: 'justify' }).moveDown(1);

doc.text('1. I state that the electronic record in the form of the CryptoTrace graph output, trace report, and associated blockchain data attached hereto as Annexure-A, was produced by a computer operated by me.', { align: 'justify' }).moveDown(0.5);
doc.text('2. I state that the said printouts/digital documents were taken from the computer owned/maintained/operated by me, with the device and system particulars as follows:', { align: 'justify' }).moveDown(0.5);

doc.text(`   - OS Name: ${process.platform}`, { indent: 20 });
doc.text(`   - Version: ${process.version}`, { indent: 20 });
doc.text('   - OS Manufacturer: ________________________', { indent: 20 });
doc.text(`   - System Name: Demo-Server`, { indent: 20 });
doc.text('   - System Manufacturer: ________________________', { indent: 20 });
doc.text('   - System Model: ________________________', { indent: 20 });
doc.text('   - Start-up disk: ________________________', { indent: 20 });
doc.text('   - Installed Physical Memory (RAM): ________________________', { indent: 20 }).moveDown(0.5);

doc.text('3. I state that the computer output containing the information was produced by the computer during the period over which the computer was used regularly to store or process information for the purposes of any activities regularly carried on over that period by me having lawful control over the use of the computer.', { align: 'justify' }).moveDown(0.5);
doc.text('4. I state that during the said period, information of the kind contained in the electronic record or of the kind from which the information so contained is derived was regularly fed into the computer in the ordinary course of the said activities.', { align: 'justify' }).moveDown(0.5);
doc.text('5. I state that throughout the material part of the said period the computer was operating properly without affecting the contents of the electronic record or its accuracy or its contents.', { align: 'justify' }).moveDown(0.5);
doc.text('6. I state that the information contained in the electronic record reproduces or is derived from such information fed into the computer in the ordinary course of the said activities.', { align: 'justify' }).moveDown(2);

doc.font('Helvetica-Bold').text('Deponent: ________________________', { align: 'right' });
doc.font('Helvetica').text('(Signature)', { align: 'right' }).moveDown(2);

doc.font('Helvetica-Bold').text('VERIFICATION', { align: 'center' }).moveDown(0.5);
doc.font('Helvetica').text('Verified at ________________________ on this _____ day of __________________, 20___, that the contents of the above affidavit are true and correct to the best of my knowledge and belief, and that nothing material has been concealed therefrom.', { align: 'justify' }).moveDown(2);

doc.font('Helvetica-Bold').text('Deponent: ________________________', { align: 'right' });
doc.font('Helvetica').text('(Signature)', { align: 'right' }).moveDown(3);

doc.fontSize(9).font('Helvetica-Oblique').fillColor('red')
  .text('DISCLAIMER: This certificate has been generated in a format intended to align with Section 65B of the Indian Evidence Act, 1872. It has not been reviewed by legal counsel and should be verified by a qualified legal professional before being relied upon in any proceeding.', { align: 'justify' })
  .fillColor('black');

doc.end();
console.log('Done!');
