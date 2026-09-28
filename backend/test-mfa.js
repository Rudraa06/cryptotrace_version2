import http from 'http';
import { runInTransaction } from './src/services/neo4j.service.js';
import speakeasy from 'speakeasy';

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

(async () => {
  console.log("=== MFA Flow Test ===");
  try {
    const email = 'admin@cybercell.gov.in';

    // 1. Initial login -> should return requiresMfaSetup (or requiresMfa if already setup)
    console.log("1. Admin logging in...");
    const loginRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email, password: '0vkiDqHP3uJd6vK4' }));
    
    console.log("   Login response:", loginRes.statusCode);
    const loginData = JSON.parse(loginRes.data);
    
    let tempToken = loginData.tempToken;
    let mfaSecretToUse = null;

    if (loginData.requiresMfaSetup) {
      console.log("   MFA Setup Required.");
      
      // 2. Fetch MFA Setup
      console.log("2. Fetching MFA Setup QR/Secret...");
      const setupRes = await makeRequest({
        hostname: 'localhost', port: 4001, path: '/api/auth/mfa/setup', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ tempToken }));
      
      const setupData = JSON.parse(setupRes.data);
      console.log("   Setup generated secret:", setupData.secret);
      mfaSecretToUse = setupData.secret;
      
    } else if (loginData.requiresMfa) {
      console.log("   MFA Already Setup, requires verification.");
      
      // Fetch the actual secret from Neo4j to generate a valid code
      await runInTransaction('READ', async (tx) => {
        const res = await tx.run('MATCH (i:Investigator {email: $email}) RETURN i.mfaSecret AS secret', { email });
        mfaSecretToUse = res.records[0].get('secret');
      });
    }

    // 3. Verify MFA Code
    const code = speakeasy.totp({ secret: mfaSecretToUse, encoding: 'base32' });
    console.log("3. Verifying MFA code:", code);
    
    const verifyRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/mfa/verify', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ tempToken, code }));
    
    console.log("   Verify response:", verifyRes.statusCode);
    if (verifyRes.statusCode === 200) {
      console.log("\n✅ SUCCESS: MFA flow is working correctly!");
      const finalCookie = verifyRes.headers['set-cookie'][0];
      console.log("   Received secure cookie:", finalCookie.split(';')[0].substring(0, 30) + '...');
    } else {
      console.log("\n❌ FAIL: MFA verification failed.", verifyRes.data);
    }
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
})();

