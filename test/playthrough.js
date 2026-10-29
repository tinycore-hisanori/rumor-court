// Automated playthrough with Playwright: node test/playthrough.js [preset] [side] [lang]
// Requires the server running on localhost:8787.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8787';
const preset = process.argv[2] || 'carrots';
const side = process.argv[3] || 'defense';
const lang = process.argv[4] || 'ja';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  if (process.env.LOCAL_FONTS) { // offline font substitutes for screenshots (Google Fonts unreachable)
    const dir = process.env.LOCAL_FONTS;
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8') }));
    await page.route('https://localfonts.test/**', (r) => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(dir, 'node_modules/@fontsource', new URL(r.request().url()).pathname)) }));
  }
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((l) => localStorage.setItem('rc-lang', l), lang);
  await page.goto(BASE);
  await page.waitForTimeout(800);
  let n = 0;
  const shot = async (name) => page.screenshot({ path: path.join(OUT, `${preset}-${side}-${lang}-${String(++n).padStart(2, '0')}-${name}.png`) });
  await shot('title');
  await page.click('#btnStart');

  const visible = (sel) => page.$eval(sel, (e) => !e.classList.contains('hidden')).catch(() => false);
  const clickThrough = async (until, max = 80) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return;
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
    }
    throw new Error('clickThrough timed out');
  };

  await clickThrough(() => visible('#picker'));
  await page.waitForTimeout(300);
  await shot('picker');
  const presets = await page.$$('.preset');
  const texts = await Promise.all(presets.map((p) => p.textContent()));
  const want = { carrots: ['ニンジン', 'carrot'], goldfish: ['金魚', 'oldfish'] }[preset];
  const idx = texts.findIndex((t) => want.some((w) => t.includes(w)));
  await presets[idx].click();
  await page.waitForTimeout(1500);
  await shot('investigating');
  await clickThrough(() => visible('#sidePick'));
  await shot('side');
  await page.click(`.side-card[data-side=${side}]`);

  // fetch the testimonies through the API to know the answers
  const caseRes = await (await fetch(BASE + '/api/case', { method: 'POST', body: JSON.stringify({ presetId: preset, lang }) })).json();
  for (let round = 1; round <= 2; round++) {
    const tm = (await (await fetch(BASE + '/api/testimony', { method: 'POST', body: JSON.stringify({ case: caseRes.case, side, round, lang }) })).json()).testimony;
    await clickThrough(() => visible('#cross'), 120);
    await page.waitForTimeout(400);
    await shot(`r${round}-cross`);
    // Press first statement
    await page.click('#btnPress');
    await clickThrough(() => visible('#cross'));
    // Wrong present once in round 1
    if (round === 1) {
      const wrong = caseRes.case.evidence.find((e) => e.id !== tm.flaw.evidenceId);
      await page.click('#btnPresent');
      await page.waitForTimeout(300);
      await shot('record');
      await page.click(`.present-btn[data-id=${wrong.id}]`);
      await clickThrough(() => visible('#cross'));
      await shot('after-wrong');
    }
    // navigate to flaw statement
    const target = tm.statements.findIndex((s) => s.id === tm.flaw.statementId);
    for (let k = 0; k < 5; k++) {
      const c = await page.textContent('#cxCounter');
      if (c.startsWith(String(target + 1))) break;
      await page.click('#btnNext');
      await clickThrough(() => visible('#cross'));
    }
    await page.click('#btnPresent');
    await page.waitForTimeout(200);
    await page.click(`.present-btn[data-id=${tm.flaw.evidenceId}]`);
    await page.waitForTimeout(700);
    await shot(`r${round}-present`);
    for (let k = 0; k < 60 && !(await visible('#cutin')); k++) await page.waitForTimeout(100);
    await page.waitForTimeout(800);
    await shot(`r${round}-cutin`);
    await page.waitForTimeout(850);
    await shot(`r${round}-objection`);
  }
  await clickThrough(() => visible('#verdict'), 60);
  await page.waitForTimeout(800);
  await shot('verdict');
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'OK no console errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
