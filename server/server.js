// Rumor Court server — zero dependencies (Node 18+).
//   node server/server.js            -> http://localhost:8787
// Env: NEBIUS_API_KEY, TAVILY_API_KEY (both required for LIVE mode; otherwise DEMO mode with bundled cases)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '..', '.env'));

const llm = require('./llm');
const tavily = require('./tavily');
const game = require('./game');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const LIVE = llm.hasKey() && tavily.hasKey() && process.env.FORCE_DEMO !== '1';

// ------------------------------------------------------------------ helpers
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const fixtures = {};
for (const f of fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR) : []) {
  if (f.endsWith('.json')) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8'));
    fixtures[fx.id] = fx;
  }
}

/** Pick one language out of {ja, en} leaves, recursively. */
function L(v, lang) {
  if (Array.isArray(v)) return v.map((x) => L(x, lang));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => k === 'ja' || k === 'en')) return v[lang] ?? v.en ?? v.ja;
    const o = {};
    for (const k of keys) o[k] = L(v[k], lang);
    return o;
  }
  return v;
}

/**
 * rumors.txt: your own list of rumors shown in the picker (one per line, re-read on every request).
 *   ニンジンを食べると夜目がきく | Carrots give you night vision     (Japanese | English)
 *   炭酸を飲むと骨がとける                                            (same text for both languages)
 *   # lines starting with # are comments
 */
const RUMOR_LIST = process.env.RUMOR_LIST || path.join(__dirname, '..', 'rumors.txt');
function readRumorList(lg) {
  if (!fs.existsSync(RUMOR_LIST)) return [];
  return fs.readFileSync(RUMOR_LIST, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [ja, en] = l.split('|').map((x) => x.trim()); return (lg === 'en' ? en || ja : ja || en).slice(0, 200); })
    .filter(Boolean).slice(0, 30);
}

// Disk + memory cache so repeated cases (and judges replaying the demo) cost nothing.
fs.mkdirSync(CACHE_DIR, { recursive: true });
const mem = new Map();
function cacheKey(kind, payload) {
  return kind + '-' + crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}
function isCached(kind, payload) {
  const key = cacheKey(kind, payload);
  return mem.has(key) || fs.existsSync(path.join(CACHE_DIR, key + '.json'));
}
async function cached(kind, payload, fn) {
  const key = cacheKey(kind, payload);
  if (mem.has(key)) return mem.get(key);
  const file = path.join(CACHE_DIR, key + '.json');
  if (fs.existsSync(file)) {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    mem.set(key, v);
    return v;
  }
  const v = await fn();
  mem.set(key, v);
  try { fs.writeFileSync(file, JSON.stringify(v)); } catch (_) { /* read-only FS is fine */ }
  return v;
}

// Simple rate limits to protect API credits on the public demo.
const hits = new Map();
function allow(ip, bucket, perHour) {
  const now = Date.now();
  const k = ip + ':' + bucket;
  const arr = (hits.get(k) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= perHour) return false;
  arr.push(now);
  hits.set(k, arr);
  return true;
}
// Daily + monthly caps on NEW live cases (the only thing that costs money).
// Counters are saved to disk so a server restart doesn't reset them.
const COUNTER_FILE = path.join(CACHE_DIR, 'usage-counter.json');
let counter = { day: '', dayCount: 0, month: '', monthCount: 0 };
try { counter = { ...counter, ...JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')) }; } catch (_) { /* first run */ }
function allowNewCase() {
  const now = new Date(Date.now() + 9 * 3600e3); // JST
  const d = now.toISOString().slice(0, 10);
  const m = d.slice(0, 7);
  if (counter.day !== d) { counter.day = d; counter.dayCount = 0; }
  if (counter.month !== m) { counter.month = m; counter.monthCount = 0; }
  if (counter.dayCount >= Number(process.env.LIVE_CASES_PER_DAY || 10)) return false;
  if (counter.monthCount >= Number(process.env.LIVE_CASES_PER_MONTH || 100)) return false;
  counter.dayCount++; counter.monthCount++;
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter)); } catch (_) { /* ignore */ }
  return true;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 200_000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ API
const lang = (b) => (b.lang === 'en' ? 'en' : 'ja');

const routes = {
  'GET /api/status': async () => ({
    mode: LIVE ? 'live' : 'demo',
    models: Object.fromEntries(Object.entries(llm.TIERS).map(([k, v]) => [k, v.model])),
    usage: { llm: llm.usage, tavily: tavily.usage },
  }),

  'POST /api/presets': async (b) => {
    const lg = lang(b);
    const own = readRumorList(lg).map((r, i) => ({ id: 'list-' + i, rumor: r, live: true, available: LIVE }));
    const bundled = process.env.HIDE_BUNDLED_CASES === '1' && LIVE ? [] : Object.values(fixtures).map((f) => ({ id: f.id, rumor: L(f.rumor, lg), available: true }));
    return { presets: [...own, ...bundled], allowCustom: LIVE };
  },

  'POST /api/case': async (b, ip) => {
    const lg = lang(b);
    if (b.presetId && fixtures[b.presetId] && (!LIVE || process.env.LIVE_PRESETS !== '1')) {
      const f = fixtures[b.presetId];
      return { case: { presetId: f.id, rumor: L(f.rumor, lg), queries: f.queries, evidence: L(f.evidence, lg), lang: lg }, cached: true };
    }
    if (!LIVE) throw Object.assign(new Error(lg === 'ja' ? 'デモモードではプリセットの事件のみ遊べます。' : 'Only preset cases are available in demo mode.'), { userFacing: true });
    const rumor = String(b.rumor || '').trim().slice(0, 200);
    if (rumor.length < 4) throw Object.assign(new Error(lg === 'ja' ? 'うわさを入力してください。' : 'Please enter a rumor.'), { userFacing: true });
    const casePayload = { rumor: rumor.toLowerCase(), lg };
    if (!isCached('case', casePayload) && (!allow(ip, 'case', Number(process.env.LIVE_CASES_PER_IP_PER_HOUR || 3)) || !allowNewCase())) {
      throw Object.assign(new Error(lg === 'ja' ? '混み合っています。少し時間をおくか、プリセットの事件で遊んでください。' : 'Too many new cases right now. Try a preset case or come back later.'), { userFacing: true, status: 429 });
    }
    const c = await cached('case', casePayload, () => game.buildCase(rumor, lg));
    return { case: c };
  },

  'POST /api/testimony': async (b, ip) => {
    const lg = lang(b);
    const side = b.side === 'prosecutor' ? 'prosecutor' : 'defense';
    const round = b.round === 2 ? 2 : 1;
    const opp = side === 'prosecutor' ? 'defense' : 'prosecutor';
    if (b.case?.presetId && fixtures[b.case.presetId]) {
      const f = fixtures[b.case.presetId];
      const t = L(f.testimony[opp][round - 1], lg);
      return { testimony: { ...t, round, speaker: opp } };
    }
    if (!LIVE) throw new Error('Live mode is off');
    if (!allow(ip, 'gen', 60)) throw Object.assign(new Error('Rate limited'), { status: 429 });
    const c = b.case;
    const prev = (Array.isArray(b.previous) ? b.previous : []).slice(0, 2).map((p) => ({
      statement: String(p.statement || '').slice(0, 300),
      evidenceId: String(p.evidenceId || '').slice(0, 20),
      testimony: p.testimony ? {
        intro: String(p.testimony.intro || '').slice(0, 300),
        statements: (p.testimony.statements || []).slice(0, 3).map((x) => String(x).slice(0, 300)),
        angle: String(p.testimony.angle || '').slice(0, 20),
        flawType: String(p.testimony.flawType || '').slice(0, 30),
      } : null,
    }));
    const t = await cached('testimony2', { e: c.evidence, r: c.rumor, side, round, prev, lg }, () =>
      game.buildTestimony(c, side, round, prev, lg),
    );
    return { testimony: t };
  },

  'POST /api/judge': async (b, ip) => {
    const lg = lang(b);
    const { case: c, testimony: t, statementId, evidenceId } = b;
    if (!c || !t) throw new Error('Missing case/testimony');
    if (c.presetId && fixtures[c.presetId]) {
      const f = fixtures[c.presetId];
      // Use the server's copy of the testimony (not the client's) to rule.
      const src = L(f.testimony[t.speaker === 'defense' ? 'defense' : 'prosecutor'][t.round === 2 ? 1 : 0], lg);
      const fl = src.flaw;
      if (fl.statementId === statementId && (fl.evidenceId === evidenceId || (fl.alsoAccept && fl.alsoAccept[evidenceId]))) {
        const line = fl.evidenceId === evidenceId ? fl.playerArgument : fl.alsoAccept[evidenceId];
        return { correct: true, playerLine: line, opponentLine: fl.opponentReaction, judgeLine: fl.judgeComment };
      }
      const lines = L(f.rebuttals[t.speaker], lg);
      const st = t.statements.find((s) => s.id === statementId);
      const custom = st && st.wrong && st.wrong[evidenceId];
      return { correct: false, opponentLine: custom || lines[Math.floor(Math.random() * lines.length)] };
    }
    if (!LIVE) throw new Error('Live mode is off');
    if (!allow(ip, 'judge', 120)) throw Object.assign(new Error('Rate limited'), { status: 429 });
    return cached('judge', { s: t.statements.find((s) => s.id === statementId), e: evidenceId, f: t.flaw, r: c.rumor, lg }, () =>
      game.judgeObjection(c, t, statementId, evidenceId, lg),
    );
  },

  'POST /api/argue': async (b, ip) => {
    const lg = lang(b);
    if (!LIVE) throw Object.assign(new Error(lg === 'ja' ? '「つっこむ」はLIVEモード専用です。' : '"Argue" needs LIVE mode.'), { userFacing: true });
    const { case: c, testimony: t, statementId } = b;
    const argument = String(b.argument || '').trim().slice(0, 200);
    if (!c || !t || argument.length < 3) throw new Error('Missing data');
    if (!allow(ip, 'judge', 120)) throw Object.assign(new Error('Rate limited'), { status: 429 });
    return cached('argue', { s: t.statements.find((x) => x.id === statementId), a: argument, f: t.flaw, r: c.rumor, lg }, () =>
      game.judgeArgument(c, t, statementId, argument, lg),
    );
  },

  'POST /api/verdict': async (b, ip) => {
    const lg = lang(b);
    const c = b.case;
    if (c?.presetId && fixtures[c.presetId]) return { verdict: L(fixtures[c.presetId].verdict, lg) };
    if (!LIVE) throw new Error('Live mode is off');
    if (!allow(ip, 'gen', 60)) throw Object.assign(new Error('Rate limited'), { status: 429 });
    const v = await cached('verdict', { e: c.evidence, r: c.rumor, lg }, () => game.buildVerdict(c, lg));
    return { verdict: v };
  },
};

const server = http.createServer(async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!route) return serveStatic(req, res);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await route(body, ip));
  } catch (e) {
    console.error(`[${req.url}]`, e.message);
    send(res, e.status || (e.userFacing ? 400 : 500), { error: e.userFacing ? e.message : 'Server error: ' + e.message, userFacing: !!e.userFacing });
  }
});

server.listen(PORT, () => {
  console.log(`Rumor Court running at http://localhost:${PORT}  [${LIVE ? 'LIVE: Nemotron on Nebius + Tavily' : 'DEMO mode (set NEBIUS_API_KEY and TAVILY_API_KEY for live)'}]`);
});
