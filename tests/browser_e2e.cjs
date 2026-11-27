// End-to-end journey in headless Chromium: landing, Lokoja example, map layers, threshold drag, every export, share link,
// method, and the phone flow (search, tour, image pair, run). Needs the page at 127.0.0.1:8766 (npx http-server . -p 8766).
// Usage: node tests/browser_e2e.cjs [screenshot folder]
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] || require('os').tmpdir() + '/floodscope_e2e';
fs.mkdirSync(OUT, { recursive: true });
const URL0 = 'http://127.0.0.1:8766/';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const errors = [];
  const watch = p => { p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', e => errors.push('pageerror ' + e.message)); };
  const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const waitView = (p, v, t = 900000) => p.waitForSelector(`[data-view="${v}"]:not([hidden])`, { timeout: t });
  const text = async (p, s) => (await p.textContent(s)).replace(/\s+/g, ' ').trim();

  // ---- desktop
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto(URL0); await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/d1_welcome.png` });
  const t0 = Date.now();
  await page.click('[data-ex="0"]');
  await waitView(page, 'running', 60000); await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/d2_running.png` });
  await page.waitForSelector('[data-view="result"]:not([hidden]), [data-view="error"]:not([hidden])', { timeout: 900000 });
  if (await page.isVisible('[data-view="error"]')) { log('ERROR VIEW:', await text(page, '#err-msg')); process.exit(1); }
  log('lokoja run s', ((Date.now() - t0) / 1000).toFixed(0));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/d3_result.png` });
  log('verdict:', await text(page, '#r-verdict'));
  log('where:', await text(page, '#r-where'));
  log('reading:', await text(page, '#r-reading'));
  log('stats:', await text(page, '#r-stats'));
  log('example note:', await page.isVisible('#r-example') ? await text(page, '#r-example') : '(none)');
  log('threshold note:', await text(page, '#thr-note'));
  log('land cover:', (await text(page, '#lc')).slice(0, 160));
  await page.click('#zones-box summary'); log('zones rows:', await page.$$eval('#zones tbody tr', rs => rs.length));
  // click the map centre for pixel values
  const box = await page.$('#map').then(e => e.boundingBox());
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height / 2); await page.waitForTimeout(800);
  log('inspect:', (await text(page, '#inspect')).slice(0, 160));
  // layers and swipe
  await page.click('#legend [data-k="radar"]'); await page.fill('#swipe', '30'); await page.dispatchEvent('#swipe', 'input'); await page.waitForTimeout(400);
  await page.click('#legend [data-k="radar"]');
  // exports
  await page.click('#export-open'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/d5_export.png` });
  for (const k of ['png', 'geojson', 'geotiff', 'csv', 'json']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(`[data-export="${k}"]`)]);
    const f = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(f); log('download', k, dl.suggestedFilename(), fs.statSync(f).size, 'bytes');
  }
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL0 });
  await page.click('[data-export="link"]'); await page.waitForTimeout(300);
  log('link note:', await text(page, '#x-note'));
  const shared = page.url(); log('shared url:', shared);
  await page.click('#export [data-close]');
  // drag the threshold to −20 dB and back to the automatic value through the keyboard
  const before = await text(page, '#r-verdict');
  const hb = await page.$('#hist').then(e => e.boundingBox());
  await page.mouse.click(hb.x + 6 + (10 / 30) * (hb.width - 12), hb.y + hb.height / 2); await page.waitForTimeout(1500);
  log('threshold −20 dB:', await text(page, '#r-verdict'), '| was', before, '| note', await text(page, '#thr-note'));
  await page.screenshot({ path: `${OUT}/d4_threshold.png` });
  await page.click('#about-open'); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/d6_method.png` });
  await page.click('#about [data-close]');
  await page.click('#stepper [data-s="images"] button'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/d7_images.png` });
  const p2 = await ctx.newPage(); watch(p2);
  await p2.goto(shared); await waitView(p2, 'result');
  log('shared verdict:', await text(p2, '#r-verdict'), '|', await text(p2, '#r-stats'));
  await p2.close(); await ctx.close();

  // ---- phone: search, tour, images, pick a pair, run
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pp = await ph.newPage(); watch(pp);
  await pp.goto(URL0); await pp.waitForTimeout(2500);
  log('phone welcome overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p1_welcome.png`, fullPage: true });
  await pp.fill('#w-q', 'Lokoja'); await pp.click('#w-search .btn');
  await pp.waitForSelector('#w-results button', { timeout: 20000 }); await pp.click('#w-results li:first-child button');
  await pp.waitForSelector('#tour[open]', { timeout: 5000 }); log('tour shown on first entry');
  await pp.screenshot({ path: `${OUT}/p2_tour.png` }); await pp.click('#tour-skip');
  await waitView(pp, 'images', 20000);
  await pp.waitForSelector('#timeline .tick', { timeout: 60000 });
  log('phone images:', await pp.$$eval('#timeline .track', ts => ts.map(t => t.querySelector('.lbl').textContent).join(' | ')));
  // first track with two images: its first and last date
  await pp.evaluate(() => { const t = [...document.querySelectorAll('#timeline .track')].find(x => x.querySelectorAll('.tick').length > 1); const b = t.querySelectorAll('.tick'); b[0].click(); });
  await pp.evaluate(() => { const t = [...document.querySelectorAll('#timeline .track')].find(x => x.querySelector('[data-role="pre"]')); const b = t.querySelectorAll('.tick'); b[b.length - 1].click(); });
  log('phone pair:', await text(pp, '#pair'), '| overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p3_images.png`, fullPage: true });
  await pp.click('#run');
  await pp.waitForSelector('[data-view="result"]:not([hidden]), [data-view="error"]:not([hidden])', { timeout: 900000 });
  await pp.waitForTimeout(2500);
  log('phone result:', await pp.isVisible('[data-view="result"]') ? `${await text(pp, '#r-verdict')} | ${await text(pp, '#r-stats')}` : `error: ${await text(pp, '#err-msg')}`);
  log('phone result overflow', await overflow(pp));
  await pp.screenshot({ path: `${OUT}/p4_result.png` });
  await ph.close(); await browser.close();
  log('errors:', errors.length ? errors : 'none');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
