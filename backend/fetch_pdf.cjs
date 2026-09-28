const http = require('http');
const fs = require('fs');

const postData = JSON.stringify({ targetAddress: '0xabc' });

const options = {
  hostname: 'localhost',
  port: 4001,
  path: '/api/export/evidence',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'X-API-Key': 'local-dev-key-12345'
  }
};

const req = http.request(options, (res) => {
  const file = fs.createWriteStream('C:/Users/rudra/.gemini/antigravity-ide/brain/229e785c-2a2a-4cec-8ff9-345666b8ad3e/CryptoTrace_Real_Endpoint_2.pdf');
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log('Download complete.');
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(postData);
req.end();
