import { chromium } from 'playwright';
import path from 'path';

(async () => {
  const browser = await chromium.launch();
  const context1 = await browser.newContext(); // Test user session
  const context2 = await browser.newContext(); // Admin session

  // 1. Login as Test User
  const page1 = await context1.newPage();
  await page1.goto('http://localhost:5173');
  await page1.fill('input[type="email"]', 'test@cybercell.gov.in');
  await page1.fill('input[type="password"]', 'testpass123');
  await page1.click('button[type="submit"]');
  await page1.waitForSelector('text=Trace Cryptocurrency');
  
  // 2. Login as Admin
  const page2 = await context2.newPage();
  await page2.goto('http://localhost:5173');
  await page2.fill('input[type="email"]', 'admin@cybercell.gov.in');
  await page2.fill('input[type="password"]', '0vkiDqHP3uJd6vK4');
  await page2.click('button[type="submit"]');
  await page2.waitForSelector('text=Admin');
  
  // 3. Open Admin Dashboard
  await page2.click('text=Admin');
  await page2.waitForSelector('text=User Management');
  await page2.screenshot({ path: path.join(process.cwd(), 'admin_dashboard.png') });
  
  // 4. Create new user
  await page2.click('text=Add Investigator');
  await page2.fill('input[type="text"]', 'Rahul Hackathon');
  // Need exact placeholder matches since there are multiple email inputs in DOM? 
  // Let's use more specific selectors.
  await page2.fill('input[placeholder="e.g. rahul@cybercell.gov.in"]', 'rahul@cybercell.gov.in');
  await page2.fill('input[placeholder="e.g. Cyber Crime Unit"]', 'Cyber Crime Unit');
  await page2.click('button:has-text("Create Account")');
  
  // Accept alert dialog
  page2.once('dialog', dialog => dialog.accept());
  
  await page2.waitForTimeout(1000);
  await page2.screenshot({ path: path.join(process.cwd(), 'admin_dashboard_added.png') });

  // 5. Deactivate Test User
  // Find the row for Test User and click Deactivate
  const row = page2.locator('tr').filter({ hasText: 'test@cybercell.gov.in' });
  await row.locator('text=Deactivate').click();
  await page2.waitForTimeout(1000);
  await page2.screenshot({ path: path.join(process.cwd(), 'admin_dashboard_deactivated.png') });

  // 6. Prove Test User is instantly revoked
  // Go back to tab 1 (Test User) and try to run a trace
  await page1.bringToFront();
  await page1.fill('input[placeholder="Enter suspect wallet address..."]', '0x123');
  await page1.click('button:has-text("Trace")');
  
  await page1.waitForTimeout(1500);
  await page1.screenshot({ path: path.join(process.cwd(), 'test_user_revoked.png') });

  await browser.close();
  console.log('Test complete. Screenshots saved.');
})();
