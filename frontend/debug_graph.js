import puppeteer from 'puppeteer-core';

(async () => {
  try {
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: 'new'
    });
    const page = await browser.newPage();
    
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });
    page.on('pageerror', err => {
      console.log(`[BROWSER ERROR] ${err.message}`);
    });
    
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
    
    // Login
    await page.type('input[type="email"]', 'admin@cryptotrace.gov');
    await page.type('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Enter trace address
    await page.type('input[placeholder*="suspect"]', '0xc8a65fadf0e0ddaf421f28feab69bf6e2e589963');
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const icon = await btn.$('svg');
      if (icon) {
        await btn.click();
        break;
      }
    }
    
    // Wait for trace to finish
    await new Promise(r => setTimeout(r, 5000));
    
    console.log("Trace done, captured logs.");
    await browser.close();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
