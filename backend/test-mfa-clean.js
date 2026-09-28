import http from 'http';
import { runInTransaction } from './src/services/neo4j.service.js';
import speakeasy from 'speakeasy';

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''; res.on('data', c => data+=c);
      res.on('end', () => resolve({statusCode: res.statusCode, data}));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

(async () => {
  const email = 'mfatest@cybercell.gov.in';
  const password = 'MfaPassword123!';
  
  // 1. Create clean user in DB directly
  const { hash } = await import('bcrypt').then(m => m.default);
  const pwd = await hash(password, 10);
  const id = (await import('crypto')).randomUUID();
  await runInTransaction('WRITE', async tx => {
    await tx.run('MERGE (i:Investigator {email: $email}) SET i.id = $id, i.passwordHash = $pwd, i.isActive = true, i.mfaEnabled = false, i.name = "MFA Test", i.role = "ANALYST"', {email, id, pwd});
  });

  // 2. Login -> requiresMfaSetup
  const loginRes = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({email, password}));
  const loginData = JSON.parse(loginRes.data);
  const tempToken = loginData.tempToken;
  console.log("Login (Setup):", loginData.requiresMfaSetup);

  // 3. Setup MFA
  const setupRes = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/mfa/setup', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({tempToken}));
  const setupData = JSON.parse(setupRes.data);
  const secret = setupData.secret;
  console.log("Setup:", setupRes.statusCode, "Secret:", secret);

  // 4. Verify Code
  const code = speakeasy.totp({secret, encoding: 'base32'});
  const verifyRes = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/mfa/verify', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({tempToken, code}));
  console.log("Verify:", verifyRes.statusCode);

  // 5. Login again -> requiresMfa
  const login2Res = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({email, password}));
  const login2Data = JSON.parse(login2Res.data);
  console.log("Login (Verify):", login2Data.requiresMfa);
  
  // 6. Verify again
  const code2 = speakeasy.totp({secret, encoding: 'base32'});
  const verify2Res = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/mfa/verify', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({tempToken: login2Data.tempToken, code: code2}));
  console.log("Verify 2:", verify2Res.statusCode);
  process.exit(0);
})();
