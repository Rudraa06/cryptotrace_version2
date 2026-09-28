const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new'
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await page.goto('http://localhost:5173');
  
  // Login
  await page.type('input[type="email"]', 'admin@cybercell.gov.in');
  await page.type('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 2000));
  
  // Find input by searching for placeholder text
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const target = inputs.find(i => i.placeholder && i.placeholder.toLowerCase().includes('suspect'));
    if (target) {
      target.value = '0xc8a65fadf0e0ddaf421f28feab69bf6e2e589963';
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const html = await page.evaluate(el => el.innerHTML, btn);
    if (html.includes('<svg')) {
      await btn.click();
      break;
    }
  }
  
  await new Promise(r => setTimeout(r, 4000));
  
  console.log('Clicking canvas...');
  await page.mouse.click(400, 300);
  
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'after_click.png' });
  console.log('Done');
  
  await browser.close();
})();
