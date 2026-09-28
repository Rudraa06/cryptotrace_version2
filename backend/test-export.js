import fs from 'fs';
import pdfParseModule from 'pdf-parse';
const pdfParse = pdfParseModule.default || pdfParseModule;

async function run() {
  const loginRes = await fetch('http://localhost:4001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'john@cybercell.gov.in', password: 'password123' })
  });
  
  if (!loginRes.ok) {
    console.error('Login failed', await loginRes.text());
    process.exit(1);
  }

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) {
    console.error('No set-cookie header');
    process.exit(1);
  }
  
  // Extract token from set-cookie
  const token = setCookie.split(';')[0];
  console.log('Got cookie:', token.substring(0, 20) + '...');

  const traceData = {
    query: { address: '0x123' },
    nodes: [],
    links: []
  };

  const exportRes = await fetch('http://localhost:4001/api/export/evidence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': token
    },
    body: JSON.stringify(traceData)
  });

  if (!exportRes.ok) {
    console.error('Export failed', await exportRes.text());
    process.exit(1);
  }

  const arrayBuffer = await exportRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync('test_export.pdf', buffer);
  
  const data = await pdfParse(buffer);
  
  console.log('\n--- PDF CONTENT EXTRACT ---');
  console.log(data.text.substring(0, 1500));
  console.log('---------------------------\n');
  
  // The seeded test investigator in seed-investigators.js is 'John Doe' or something? 
  // Let's just check if it DOES NOT say "UNKNOWN_INVESTIGATOR" or "Internal Service System Account"
  if (data.text.includes('UNKNOWN_INVESTIGATOR') || data.text.includes('Internal Service')) {
    console.error('FAILED: Deponent field shows fake/internal name.');
  } else {
    console.log('SUCCESS: Deponent field contains real logged-in investigator name.');
  }
}

run();
