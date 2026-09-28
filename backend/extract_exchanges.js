const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'temp_eth_lists', 'contracts', 'mainnet');
const exchanges = ['binance', 'coinbase', 'kraken', 'okex', 'kucoin', 'huobi', 'bitfinex', 'crypto.com', 'gemini', 'wazirx', 'coindcx'];

const results = [];

if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        const data = JSON.parse(content);
        const name = (data.name || '').toLowerCase();
        const project = (data.project || '').toLowerCase();
        
        for (const ex of exchanges) {
          if (name.includes(ex) || project.includes(ex)) {
            // Check if it's a hot or cold wallet
            let walletType = 'hot';
            if (name.includes('cold') || project.includes('cold')) walletType = 'cold';
            
            const address = file.replace('.json', '');
            
            // Format into our object structure
            results.push({
              address: address,
              exchange: ex.charAt(0).toUpperCase() + ex.slice(1),
              label: data.name || data.project || ex,
              walletType: walletType,
              verified: true
            });
            break; // found one exchange match, move to next file
          }
        }
      } catch (e) {
        // ignore invalid json
      }
    }
  }
}

fs.writeFileSync(path.join(__dirname, 'extracted_eth_exchanges.json'), JSON.stringify(results, null, 2));
console.log(`Extracted ${results.length} Ethereum exchange addresses.`);
