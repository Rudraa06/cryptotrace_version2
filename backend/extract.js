import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

async function run() {
    let dataBuffer = fs.readFileSync('C:/Users/rudra/.gemini/antigravity-ide/brain/229e785c-2a2a-4cec-8ff9-345666b8ad3e/CryptoTrace_Real_Endpoint.pdf');
    try {
        const data = await pdf(dataBuffer);
        console.log(data.text);
    } catch (e) {
        console.error(e);
    }
}
run();
