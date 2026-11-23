// End-to-end check in headless Chromium: landing page, the Lokoja example run, results, exports, console errors.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2] || '.';
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT || 8765}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/fs_landing.png` });
  const t0 = Date.now();
  await page.click('#demo');
  await page.waitForSelector('#figures:not(.empty)', { timeout: 240000 });
  await page.waitForTimeout(2500);
  console.log('run seconds', (Date.now() - t0) / 1000);
  console.log('log:', await page.$$eval('#log li', ls => ls.map(l => l.textContent).join(' | ')));
  console.log('figures:', await page.$$eval('.kpi', fs => fs.map(f => f.textContent.replace(/\s+/g, ' ').trim()).join(' || ')));
  console.log('zones rows:', await page.$$eval('#zones tbody tr', rs => rs.length));
  await page.screenshot({ path: `${out}/fs_tool.png` });
  await page.screenshot({ path: `${out}/fs_results.png`, fullPage: false });
  for (const t of ['lc', 'zones', 'images']) { await page.click(`.tabs [data-tab="${t}"]`); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/fs_${t}.png` }); }
  await page.click('.tabs [data-tab="thr"]');
  for (const k of ['geojson', 'geotiff', 'csv', 'json', 'png']) {
    await page.click('#dl-btn');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(`[data-export="${k}"]`)]);
    const p = `${out}/${dl.suggestedFilename()}`; await dl.saveAs(p); console.log('export', k, fs.statSync(p).size, 'bytes', p);
  }
  // threshold change via the slider after the run
  await page.evaluate(() => { const s = document.getElementById('p-thr'); s.value = -20; s.dispatchEvent(new Event('input')); });  // the slider sits in the closed Settings panel
  await page.waitForTimeout(2500);
  console.log('figures at -20 dB:', await page.$$eval('.kpi .v', fs => fs.map(f => f.textContent).join(' | ')));
  const box = await page.$('#map').then(e => e.boundingBox());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 1);
  await page.waitForTimeout(1200);
  console.log('inspect:', (await page.textContent('#inspect')).replace(/\s+/g, ' ').slice(0, 300));
  await page.screenshot({ path: `${out}/fs_inspect.png` });
  // phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('horizontal overflow at 390 px:', overflow);
  await page.screenshot({ path: `${out}/fs_phone.png`, fullPage: false });
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
