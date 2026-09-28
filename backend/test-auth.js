import http from 'http';

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
  console.log("=== Auth Revocation Test ===");
  try {
    // 1. Admin login
    console.log("1. Admin logging in...");
    const adminRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email: 'admin@cybercell.gov.in', password: '0vkiDqHP3uJd6vK4' }));
    const adminCookie = adminRes.headers['set-cookie'][0].split(';')[0];
    
    // Reactivate test user in case it was deactivated
    console.log("2. Admin fetching users to reactivate test user...");
    const listRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/investigators', method: 'GET',
      headers: { 'Cookie': adminCookie }
    });
    const investigators = JSON.parse(listRes.data).investigators;
    const testUser = investigators.find(i => i.email === 'test@cybercell.gov.in');
    
    if (!testUser.isActive) {
      console.log("   Reactivating test user...");
      await makeRequest({
        hostname: 'localhost', port: 4001, path: `/api/investigators/${testUser.id}`, method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
      }, JSON.stringify({ isActive: true }));
    }

    // 3. Test user logs in
    console.log("3. Test user logging in...");
    const testRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email: 'test@cybercell.gov.in', password: 'testpass123' }));
    const testCookie = testRes.headers['set-cookie'][0].split(';')[0];
    console.log("   Test user obtained session cookie:", testCookie.substring(0, 20) + "...");

    // 4. Test user does something (should succeed)
    console.log("4. Test user attempts a protected request...");
    const traceRes1 = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/trace', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': testCookie }
    }, JSON.stringify({ address: '0x123' }));
    console.log("   Initial trace request status:", traceRes1.statusCode); // Will be 200 or 400 (validation), but NOT 401

    // 5. Admin revokes test user
    console.log("5. Admin instantly REVOKES test user via Admin Dashboard API...");
    const patchRes = await makeRequest({
      hostname: 'localhost', port: 4001, path: `/api/investigators/${testUser.id}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie }
    }, JSON.stringify({ isActive: false }));
    console.log("   Admin deactivated test user. Status:", patchRes.statusCode);

    // 6. Test user uses EXISTING session cookie
    console.log("6. Test user attempts another protected request using their EXISTING session cookie...");
    const traceRes2 = await makeRequest({
      hostname: 'localhost', port: 4001, path: '/api/trace', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': testCookie }
    }, JSON.stringify({ address: '0x123' }));
    console.log("   Second trace request status:", traceRes2.statusCode);
    console.log("   Response from server:", traceRes2.data);
    
    if (traceRes2.statusCode === 401) {
      console.log("\n✅ SUCCESS: The existing session was instantly rejected by the requireAuth middleware!");
    } else {
      console.log("\n❌ FAIL: The session was still accepted.");
    }
    
  } catch (err) {
    console.error("Error:", err);
  }
})();
