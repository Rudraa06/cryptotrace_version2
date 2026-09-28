import http from 'http';
import { runInTransaction } from './src/services/neo4j.service.js';

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
  console.log("=== Password Reset Flow Test ===");
  try {
    const email = 'admin@cybercell.gov.in';

    // 1. Request forgot password
    console.log("1. Requesting password reset...");
    const forgotRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/forgot-password', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email }));
    
    console.log("   Forgot response:", forgotRes.statusCode, forgotRes.data);
    if (forgotRes.statusCode !== 200) throw new Error("Forgot password failed");

    // 2. Extract the token from DB (simulating email reception)
    console.log("2. Extracting token from DB (simulating email reception)...");
    let token = null;
    await runInTransaction('READ', async (tx) => {
      const res = await tx.run('MATCH (i:Investigator {email: $email}) RETURN i.resetToken AS token', { email });
      token = res.records[0].get('token');
    });
    console.log("   Token extracted:", token);
    
    if (!token) throw new Error("Reset Token was not generated or saved in DB");

    // 3. Reset the password
    console.log("3. Resetting account with new password...");
    const newPassword = 'NewSecurePassword123!';
    const resetRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/reset-password', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ token, password: newPassword }));
    
    console.log("   Reset response:", resetRes.statusCode, resetRes.data);
    if (resetRes.statusCode !== 200) throw new Error("Reset failed");

    // 4. Try to login with the new password
    console.log("4. Logging in with new password...");
    const loginRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email, password: newPassword }));
    
    console.log("   Login response:", loginRes.statusCode);
    if (loginRes.statusCode === 200) {
      console.log("\n✅ SUCCESS: The password reset flow works perfectly!");
    } else {
      console.log("\n❌ FAIL: Could not log in after password reset.");
    }
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
})();
