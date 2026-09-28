const crypto = require('crypto'); 
const bcrypt = require('bcrypt'); 
const neo4j = require('neo4j-driver'); 
const fs = require('fs');

async function run() { 
  const driver = neo4j.driver('neo4j://127.0.0.1:7687', neo4j.auth.basic('neo4j', '12345678')); 
  const session = driver.session(); 
  const hash = await bcrypt.hash('password123', 12); 
  await session.run("MERGE (i:Investigator {email: 'test@cybercell.gov.in'}) SET i.id = $id, i.passwordHash = $hash, i.name = 'Test Investigator', i.role = 'SUPERVISOR', i.department = 'Test Dept', i.isActive = true", { id: crypto.randomUUID(), hash }); 
  await session.close(); 
  await driver.close(); 
  console.log('Seeded test user'); 

  const loginRes = await fetch('http://localhost:4001/api/auth/login', { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ email: 'test@cybercell.gov.in', password: 'password123' }) 
  }); 
  
  if (!loginRes.ok) { 
    console.error('Login failed'); 
    process.exit(1); 
  } 
  
  const setCookie = loginRes.headers.get('set-cookie'); 
  const token = setCookie.split(';')[0]; 
  console.log('Login successful. Session cookie acquired.');
  
  const exportRes = await fetch('http://localhost:4001/api/export/evidence', { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': token }, 
    body: JSON.stringify({ query: { address: '0x123' }, nodes: [], links: [] }) 
  }); 
  
  if (!exportRes.ok) { 
    console.error('Export failed'); 
    process.exit(1); 
  } 
  
  console.log('Export request succeeded. Writing PDF to disk...');
  const buffer = Buffer.from(await exportRes.arrayBuffer()); 
  fs.writeFileSync('test_export.pdf', buffer);
  console.log('Wrote test_export.pdf successfully.');
} 
run();
