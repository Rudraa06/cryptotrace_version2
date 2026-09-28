import http from 'http';

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
  const loginRes = await makeRequest({hostname: 'localhost', port: 4001, path: '/api/auth/login', method: 'POST', headers: {'Content-Type': 'application/json'}}, JSON.stringify({email: 'admin@cybercell.gov.in', password: 'CryptoTrace123!'}));
  console.log("Login Res:", loginRes.statusCode, loginRes.data);
})();
