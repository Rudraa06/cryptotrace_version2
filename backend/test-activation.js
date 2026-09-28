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
  console.log("=== Email Activation Flow Test ===");
  try {
    // 1. Admin login
    console.log("1. Admin logging in...");
    const adminRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email: 'admin@cybercell.gov.in', password: '0vkiDqHP3uJd6vK4' }));
    
    if (adminRes.statusCode !== 200) throw new Error("Admin login failed");
    const adminCookie = adminRes.headers['set-cookie'][0].split(';')[0];
    
    // 2. Admin creates a new user
    console.log("2. Admin creates a new user...");
    const newEmail = `activation_test_${Date.now()}@cybercell.gov.in`;
    const createRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/investigators', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
    }, JSON.stringify({ name: 'Activation Test', email: newEmail, role: 'ANALYST', department: 'Testing' }));
    
    console.log("   Create user response:", createRes.statusCode, createRes.data);
    if (createRes.statusCode !== 200) throw new Error("Create user failed");

    // 3. Extract the token from DB (simulating clicking the email link)
    console.log("3. Extracting token from DB (simulating email reception)...");
    let token = null;
    await runInTransaction('READ', async (tx) => {
      const res = await tx.run('MATCH (i:Investigator {email: $email}) RETURN i.activationToken AS token', { email: newEmail });
      token = res.records[0].get('token');
    });
    console.log("   Token extracted:", token);
    
    if (!token) throw new Error("Token was not generated or saved in DB");

    // 4. Activate the account
    console.log("4. Activating account with new password...");
    const activateRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/activate', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ token, password: 'SecurePassword123!' }));
    
    console.log("   Activation response:", activateRes.statusCode, activateRes.data);
    if (activateRes.statusCode !== 200) throw new Error("Activation failed");

    // 5. Try to login with the new account
    console.log("5. Logging in with activated account...");
    const loginRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email: newEmail, password: 'SecurePassword123!' }));
    
    console.log("   Login response:", loginRes.statusCode);
    if (loginRes.statusCode === 200) {
      console.log("\n✅ SUCCESS: The activation flow works perfectly!");
    } else {
      console.log("\n❌ FAIL: Could not log in after activation.");
    }
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
})();
