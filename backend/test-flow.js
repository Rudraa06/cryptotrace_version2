const API_BASE = 'http://localhost:4001';

async function request(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function run() {
  try {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@cybercell.gov.in', password: 'CryptoTrace123!' })
    });
    console.log("Login data:", data);
    
    if (data.requiresMfaSetup) {
      console.log("Requires MFA setup, calling /api/auth/mfa/setup");
      const setupData = await request('/api/auth/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ tempToken: data.tempToken })
      });
      console.log("Setup data keys:", Object.keys(setupData));
    }
  } catch (err) {
    console.error("Caught Error:", err.message);
  }
}
run();
