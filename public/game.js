/* Rumor Court — front-end game engine (vanilla JS, no dependencies) */
(() => {
  'use strict';

  // ------------------------------------------------------------ state
  const S = {
    lang: (navigator.language || 'ja').startsWith('ja') ? 'ja' : 'en',
    mode: 'demo',
    allowCustom: false,
    gameCase: null,
    side: null, // player's side
    opp: null,
    life: 5,
    maxLife: 5,
    previous: [],
    verdictPromise: null,
    exprs: { defense: 'normal', prosecutor: 'normal' },
  };
  try { const l = localStorage.getItem('rc-lang'); if (l === 'ja' || l === 'en') S.lang = l; } catch (_) { /* ignore */ }
  const T = () => window.I18N[S.lang];
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Japanese line breaking: split into phrases (BudouX) and allow breaks only between phrases.
  const JA = /[\u3040-\u30ff\u3400-\u9fff]/;
  const phrases = (text) => (JA.test(text) && window.BudouX ? window.BudouX.parse(text) : [text]);
  function jt(el, text) {
    el.textContent = '';
    for (const ph of phrases(String(text ?? ''))) { el.appendChild(document.createTextNode(ph)); el.appendChild(document.createElement('wbr')); }
    return el;
  }

  // ------------------------------------------------------------ layout scaling
  function fit() {
    const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    $('stage').style.transform = `scale(${s})`;
  }
  window.addEventListener('resize', fit);
  // focusing inputs must never scroll the fixed-size stage
  $('stage').addEventListener('scroll', () => { $('stage').scrollTop = 0; $('stage').scrollLeft = 0; });
  fit();

  // ------------------------------------------------------------ audio (WebAudio synth: SFX + chiptune BGM)
  let ac = null, master = null, sfxBus = null, bgmBus = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('rc-mute') === '1'; } catch (_) { /* storage blocked */ }
  function audio() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.2;
      master = ac.createGain(); master.gain.value = muted ? 0 : 1;
      master.connect(comp); comp.connect(ac.destination);
      sfxBus = ac.createGain(); sfxBus.gain.value = 1; sfxBus.connect(master);
      bgmBus = ac.createGain(); bgmBus.gain.value = 0.32; bgmBus.connect(master);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      setTimeout(preload, 0);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => audio(), { capture: true }));
  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('rc-mute', m ? '1' : '0'); } catch (_) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(m ? 0 : 1, ac.currentTime, 0.02);
    const b = $('btnMute'); if (b) b.textContent = m ? '🔇' : '🔊';
  }
  /** One oscillator note with a fast attack and exponential decay. */
  function tone(freq, dur, type = 'square', vol = 0.1, slide = 0, o2 = {}) {
    const a = audio(); if (!a) return;
    const t0 = o2.at ?? a.currentTime;
    const o = a.createOscillator(); const g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (o2.detune) o.detune.value = o2.detune;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + (o2.attack || 0.004));
    if (o2.hold) g.gain.setValueAtTime(vol, t0 + o2.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(o2.bus || sfxBus); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  /** Filtered white-noise burst (impacts, snares, whooshes). */
  function noise(dur, vol = 0.3, o2 = {}) {
    const a = audio(); if (!a) return;
    const t0 = o2.at ?? a.currentTime;
    const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = a.createBiquadFilter(); f.type = o2.filter || 'lowpass'; f.frequency.setValueAtTime(o2.freq || 1200, t0); f.Q.value = o2.q || 1;
    if (o2.sweep) f.frequency.exponentialRampToValueAtTime(o2.sweep, t0 + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + (o2.attack || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(o2.bus || sfxBus); s.start(t0); s.stop(t0 + dur + 0.02);
  }
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const boom = (v = 0.9) => { tone(140, 0.7, 'sine', v, -100); noise(0.5, v * 0.5, { freq: 300 }); };
  const SFX = {
    blip: (who) => tone({ defense: 392, prosecutor: 587, judge: 294, client: 740 }[who] || 470, 0.035, 'square', 0.07),
    // OBJECTION!: whoosh -> boom + crash + brass stab
    objection: (who) => {
      if (S.lang === 'ja') playFile('matta', 1.1);
      else playFile('wait_' + who, 1.1);
      noise(0.25, 0.35, { filter: 'bandpass', freq: 400, sweep: 5000, q: 1.5 });
      const a = audio(); if (!a) return; const t = a.currentTime + 0.18;
      tone(150, 0.8, 'sine', 1, -110, { at: t });
      noise(0.9, 0.55, { filter: 'highpass', freq: 2500, at: t });
      noise(0.4, 0.5, { freq: 500, at: t });
      [48, 55, 60, 64, 67].forEach((m) => { tone(hz(m), 0.75, 'sawtooth', 0.14, 0, { at: t, hold: 0.25, detune: -8 }); tone(hz(m), 0.75, 'square', 0.07, 0, { at: t, hold: 0.25, detune: 8 }); });
    },
    // the presented card slams onto the screen
    slam: () => { boom(0.85); noise(0.08, 0.6, { filter: 'bandpass', freq: 2500, q: 2 }); tone(1800, 0.12, 'square', 0.08, -1200); },
    damage: () => {
      noise(0.35, 0.6, { filter: 'bandpass', freq: 900, q: 1.2 });
      tone(420, 0.6, 'sawtooth', 0.3, -360); tone(415, 0.6, 'square', 0.15, -360);
      tone(90, 0.4, 'sine', 0.7, -50);
    },
    // statement broken: hit + rising fanfare
    crash: () => {
      boom(1);
      noise(1.2, 0.5, { filter: 'highpass', freq: 3000 });
      [60, 64, 67, 72].forEach((m, i) => tone(hz(m + 7), 0.5, 'sawtooth', 0.12, 0, { at: audio().currentTime + 0.05 + i * 0.07, hold: 0.15 }));
    },
    success: () => {
      const t = audio()?.currentTime; if (t == null) return;
      [72, 76, 79, 84].forEach((m, i) => tone(hz(m), 0.3, 'square', 0.12, 0, { at: t + i * 0.08 }));
      [72, 76, 79, 84].forEach((m) => tone(hz(m), 1.1, 'sawtooth', 0.08, 0, { at: t + 0.34, hold: 0.4 }));
    },
    gavel: () => {
      if (playFile('hyoshigi', 1.4)) return;
      const t = audio()?.currentTime; if (t == null) return;
      [0, 0.26].forEach((d) => {
        tone(200, 0.18, 'sine', 1, -120, { at: t + d });
        tone(620, 0.07, 'triangle', 0.5, -300, { at: t + d });
        noise(0.09, 0.7, { filter: 'bandpass', freq: 1600, q: 3, at: t + d });
      });
    },
    evidence: () => {
      const t = audio()?.currentTime; if (t == null) return;
      [84, 88, 91, 96].forEach((m, i) => tone(hz(m), 0.35, 'triangle', 0.16, 0, { at: t + i * 0.06 }));
      noise(0.4, 0.12, { filter: 'highpass', freq: 6000, at: t });
    },
    whoosh: () => noise(0.45, 0.4, { filter: 'bandpass', freq: 300, sweep: 4000, q: 1.2, attack: 0.15 }),
    select: () => { tone(988, 0.06, 'square', 0.1); tone(1319, 0.09, 'square', 0.08, 0, { at: audio()?.currentTime + 0.05 }); },
    press: () => { tone(330, 0.12, 'square', 0.12, 200); noise(0.1, 0.2, { filter: 'bandpass', freq: 1500 }); },
  };

  // ---- recorded audio (music, voice and sound effects)
  const buffers = {};
  function loadBuf(url) {
    const a = audio(); if (!a) return Promise.resolve(null);
    if (!buffers[url]) buffers[url] = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => a.decodeAudioData(ab, res, rej))).catch(() => null) // missing file = stay silent, don't refetch
      .then((buf) => { buffers[url].done = buf; return buf; });
    return buffers[url];
  }
  const FILES = {
    daily: 'assets/bgm/daily.mp3', trial: 'assets/bgm/trial.mp3', matta: 'assets/sfx/matta.mp3', hyoshigi: 'assets/sfx/hyoshigi.mp3',
    wait_defense: 'assets/sfx/wait_boy.mp3', wait_prosecutor: 'assets/sfx/wait_girl.mp3', // English "Wait!" voices (VOICEVOX)
  };
  /** Play a recorded sound effect; returns false if it isn't loaded yet (caller can fall back to synth). */
  function playFile(key, vol = 1) {
    const p = buffers[FILES[key]];
    loadBuf(FILES[key]);
    if (!p || !p.done) return false;
    const a = audio(); const src = a.createBufferSource(); src.buffer = p.done;
    const g = a.createGain(); g.gain.value = vol; src.connect(g).connect(sfxBus); src.start();
    return true;
  }
  function preload() {
    for (const url of Object.values(FILES)) loadBuf(url);
  }
  // Scene -> music file. Scenes that share a file keep playing without restarting.
  const SCENE_MUSIC = { title: 'daily', investigate: 'daily', win: 'daily', court: 'trial', cross: 'trial', pursuit: 'trial', lose: null };
  const BGM = { cur: null, file: null, src: null, gain: null, seq: 0 };
  function stopMusic(fade = 0.6) {
    if (!BGM.src) return;
    const a = ac, { src, gain } = BGM;
    gain.gain.cancelScheduledValues(a.currentTime); gain.gain.setValueAtTime(gain.gain.value, a.currentTime);
    gain.gain.linearRampToValueAtTime(0, a.currentTime + fade);
    try { src.stop(a.currentTime + fade + 0.05); } catch (_) { /* already stopped */ }
    BGM.src = null; BGM.gain = null; BGM.file = null;
  }
  /** Switch background music by scene name (null = silence). */
  function bgm(name) {
    BGM.cur = name;
    const key = name ? SCENE_MUSIC[name] : null;
    if (key && key === BGM.file) return;
    const a = audio(); if (!a) return;
    stopMusic(key ? 0.6 : 0.25);
    if (!key) return;
    const seq = ++BGM.seq;
    BGM.file = key;
    loadBuf(FILES[key]).then((buf) => {
      if (!buf || seq !== BGM.seq) return;
      const src = a.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = a.createGain(); g.gain.setValueAtTime(0, a.currentTime); g.gain.linearRampToValueAtTime(1, a.currentTime + 0.5);
      src.connect(g).connect(bgmBus); src.start();
      BGM.src = src; BGM.gain = g;
    });
  }

  // ------------------------------------------------------------ sprites
  const HEAD_TOP = { judge: 17, defense: -132, prosecutor: -132, client: -207 };
  const SLOT = { left: $('sp-left'), center: $('sp-center'), right: $('sp-right') };
  const sprite = (who, expr) => `assets/sprites/${who}_${expr}.webp`;
  // preload all sprites
  { const ex = { defense: ['normal', 'smug', 'thinking', 'nervous', 'shocked', 'triumph'], prosecutor: ['normal', 'smug', 'thinking', 'nervous', 'shocked', 'triumph'], judge: ['normal', 'stern', 'surprised'], client: ['normal', 'surprised', 'relieved'] };
    for (const [w, list] of Object.entries(ex)) for (const e of list) { const i = new Image(); i.src = sprite(w, e); } }

  function setSlot(slot, who, expr, dim) {
    const el = SLOT[slot];
    if (!who) { el.classList.remove('show'); return; }
    const src = sprite(who, expr || 'normal');
    if (!el.src.endsWith(src)) el.src = src;
    el.style.top = HEAD_TOP[who] + 'px';
    el.classList.add('show');
    el.classList.toggle('dim', !!dim);
  }
  function setDesks(scene) {
    document.querySelector('.desk.left').classList.toggle('show', scene === 'court');
    document.querySelector('.desk.right').classList.toggle('show', scene === 'court');
    document.querySelector('.desk.center').classList.toggle('show', scene === 'judge');
  }
  /** Arrange the stage for whoever is speaking. */
  function stageFor(who, expr) {
    if (who === 'defense' || who === 'prosecutor') {
      if (expr) S.exprs[who] = expr;
      setSlot('center', null);
      setSlot('left', 'defense', S.exprs.defense, who !== 'defense');
      setSlot('right', 'prosecutor', S.exprs.prosecutor, who !== 'prosecutor');
      setDesks('court');
    } else {
      setSlot('left', null); setSlot('right', null);
      setSlot('center', who, expr || 'normal', false);
      setDesks(who === 'judge' ? 'judge' : 'none');
    }
  }
  function slotOf(who) { return who === 'defense' ? SLOT.left : who === 'prosecutor' ? SLOT.right : SLOT.center; }
  function anim(who, cls) { const el = slotOf(who); el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  // ------------------------------------------------------------ dialogue
  let advanceResolver = null;
  let typing = null;
  function advance() {
    audio();
    if (typing) { typing.finish(); return; }
    if (advanceResolver) { const r = advanceResolver; advanceResolver = null; r(); }
  }
  function typeText(el, text, who) {
    // Lay out the whole line first (invisible), then reveal it character by character,
    // so words never jump to the next line while typing.
    el.textContent = '';
    const chars = [];
    for (const ph of phrases(text)) {
      for (const ch of ph) { const sp = document.createElement('span'); sp.className = 'h'; sp.textContent = ch; el.appendChild(sp); chars.push(sp); }
      el.appendChild(document.createElement('wbr'));
    }
    return new Promise((resolve) => {
      let i = 0;
      let timer;
      const done = () => { typing = null; resolve(); };
      const step = () => {
        if (i >= chars.length) { done(); return; }
        chars[i].className = '';
        if (i % 2 === 0 && chars[i].textContent.trim()) SFX.blip(who);
        i++;
        timer = setTimeout(step, 26);
      };
      timer = setTimeout(step, 26);
      typing = { finish: () => { clearTimeout(timer); for (const c of chars) c.className = ''; done(); } };
    });
  }
  /**
   * Show a line of dialogue. opts: { statement, wait=true }
   */
  async function say(who, expr, text, opts = {}) {
    stageFor(who, expr);
    $('textbox').classList.remove('hidden');
    const np = $('nameplate');
    np.textContent = T().names[who];
    np.className = who;
    if ((who === 'defense' || who === 'prosecutor') && S.side) {
      const b = document.createElement('span'); b.className = 'np-badge';
      b.textContent = `${T().stanceShort[who]}・${who === S.side ? T().you : T().rival}`;
      np.appendChild(b);
    }
    const tx = $('text');
    tx.className = opts.statement ? 'statement' : '';
    $('nextArrow').classList.add('hidden');
    const pages = paginate(String(text ?? ''));
    for (let p = 0; p < pages.length; p++) {
      $('nextArrow').classList.add('hidden');
      await typeText(tx, pages[p], who);
      const last = p === pages.length - 1;
      if (last && opts.wait === false) return;
      $('nextArrow').classList.remove('hidden');
      await new Promise((r) => { advanceResolver = r; });
    }
  }

  /** Split long lines into pages that fit the 3-line text box (sentence boundaries first). */
  function paginate(text) {
    const max = JA.test(text) ? 96 : 210;
    if (text.length <= max) return [text];
    const sentences = text.match(/[^。！？!?.]+[。！？!?.」』"]*\s*/g) || [text];
    const pages = [];
    let cur = '';
    for (let sn of sentences) {
      while (sn.length > max) { // a single very long sentence: cut at a comma near the limit
        let cut = Math.max(sn.lastIndexOf('、', max), sn.lastIndexOf(', ', max));
        if (cut < max * 0.4) cut = max;
        if (cur) { pages.push(cur.trim()); cur = ''; }
        pages.push(sn.slice(0, cut + 1).trim());
        sn = sn.slice(cut + 1);
      }
      if ((cur + sn).length > max && cur) { pages.push(cur.trim()); cur = ''; }
      cur += sn;
    }
    if (cur.trim()) pages.push(cur.trim());
    return pages;
  }
  $('textbox').addEventListener('click', advance);
  $('chars').addEventListener('click', advance);
  $('bg').addEventListener('click', advance);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!$('cross').classList.contains('hidden')) return; advance(); }
    if (!$('cross').classList.contains('hidden') && $('record').classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') $('btnPrev').click();
      if (e.key === 'ArrowRight') $('btnNext').click();
      if (e.key === 'p' || e.key === 'P') $('btnPress').click();
      if (e.key === 'e' || e.key === 'E') $('btnPresent').click();
      if (e.key === 'a' || e.key === 'A') $('btnArgue').click();
    }
    if (e.key === 'Escape' && !$('record').classList.contains('hidden')) $('recordClose').click();
  });

  // ------------------------------------------------------------ effects
  async function cutin(who) {
    bgm(null);
    SFX.objection(who);
    $('cutinFace').src = sprite(who, 'triumph');
    $('cutinText').textContent = T().holdIt;
    $('cutin').classList.remove('hidden');
    await sleep(1100);
    $('cutin').classList.add('hidden');
  }
  function flash() { const f = $('flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
  function quake() { const s = $('stage'); s.classList.remove('quake'); void s.offsetWidth; s.classList.add('quake'); }
  async function banner(small, big, ms = 1900) {
    SFX.whoosh();
    $('bannerSmall').textContent = small; jt($('bannerBig'), big);
    const b = $('banner'); b.classList.add('hidden'); void b.offsetWidth; b.classList.remove('hidden');
    await sleep(ms); b.classList.add('hidden');
  }
  async function toast(card) {
    SFX.evidence();
    const t = $('toast');
    t.innerHTML = '';
    t.appendChild(visualEl(card, 'mini'));
    const msg = document.createElement('div'); msg.className = 'toast-msg'; jt(msg, T().evidenceAdded(card.title));
    t.appendChild(msg);
    t.classList.remove('hidden'); t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    await sleep(1300);
    t.classList.add('hidden');
  }

  function renderRoleTags() {
    const t = T();
    for (const side of ['defense', 'prosecutor']) {
      const el = $(side === 'defense' ? 'tagDefense' : 'tagProsecutor');
      el.innerHTML = '';
      const role = document.createElement('b'); role.textContent = t.roles[side];
      const stance = document.createElement('span'); stance.className = 'stance'; stance.textContent = t.stanceLong[side];
      const name = document.createElement('span'); name.className = 'who'; name.textContent = t.names[side];
      const me = document.createElement('span'); me.className = 'me' + (side === S.side ? ' you' : ''); me.textContent = side === S.side ? t.you : t.rival;
      el.append(me, role, stance, name);
    }
    $('roleTags').classList.remove('hidden');
  }
  function renderHearts(breakIdx = -1) {
    const h = $('hearts'); h.innerHTML = '';
    for (let i = 0; i < S.maxLife; i++) {
      const d = document.createElement('span');
      d.className = 'heart' + (i >= S.life ? ' lost' : '') + (i === breakIdx ? ' breaking' : '');
      h.appendChild(d);
    }
  }

  // ------------------------------------------------------------ API
  async function api(path, body) {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ lang: S.lang, ...body }) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { userFacing: data.userFacing });
    return data;
  }
  function showLoading(text) { $('loadingText').textContent = text; $('loadingChips').innerHTML = ''; $('loading').classList.remove('hidden'); }
  function hideLoading() { $('loading').classList.add('hidden'); }
  function addChip(text, cls = '') { const c = document.createElement('span'); c.className = 'chip ' + cls; c.textContent = text; $('loadingChips').appendChild(c); }
  /** Run an async task; on failure show an error panel with retry. */
  async function withRetry(fn) {
    for (;;) {
      try { return await fn(); } catch (e) {
        hideLoading();
        jt($('errorText'), T().errorPrefix + e.message);
        $('errorRetry').textContent = T().retry;
        $('error').classList.remove('hidden');
        await new Promise((r) => { $('errorRetry').onclick = () => { $('error').classList.add('hidden'); r(); }; });
        if (e.userFacing) throw e;
      }
    }
  }

  // ------------------------------------------------------------ court record
  /** Big visual "key fact" block for an evidence card. size: 'mini' | 'card' | 'huge' */
  function visualEl(c, size) {
    const v = document.createElement('div'); v.className = `visual ${size} ${c.stance}`;
    const icon = document.createElement('div'); icon.className = 'v-icon'; icon.textContent = c.icon || '📄';
    const big = document.createElement('div'); big.className = 'v-big'; jt(big, c.big || c.id);
    v.append(icon, big);
    if (c.small && size !== 'mini') { const sm = document.createElement('div'); sm.className = 'v-small'; jt(sm, c.small); v.appendChild(sm); }
    return v;
  }
  function cardEl(c, presentable) {
    const el = document.createElement('div'); el.className = 'card';
    el.appendChild(visualEl(c, 'card'));
    const body = document.createElement('div'); body.className = 'card-body';
    const top = document.createElement('div'); top.className = 'card-top';
    const id = document.createElement('span'); id.className = 'card-id'; id.textContent = c.id;
    const title = document.createElement('span'); title.className = 'card-title'; jt(title, c.title);
    const tag = document.createElement('span'); tag.className = 'tag ' + c.stance; tag.textContent = T().stance[c.stance] || c.stance;
    top.append(id, title, tag);
    const easy = document.createElement('div'); easy.className = 'card-easy'; jt(easy, c.easy || c.summary);
    const more = document.createElement('details'); more.className = 'card-more';
    const sm = document.createElement('summary'); sm.textContent = T().details;
    const sum = document.createElement('div'); sum.className = 'card-summary'; jt(sum, c.summary);
    const meta = document.createElement('div'); meta.className = 'card-meta';
    const src = document.createElement('span'); src.textContent = c.source + (c.published ? ` · ${c.published}` : '');
    const rel = document.createElement('span'); rel.textContent = T().reliability[c.reliability] || '';
    const a = document.createElement('a'); a.href = c.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = T().openSource + ' ↗';
    meta.append(src, rel, a);
    more.append(sm, sum, meta);
    body.append(top, easy, more);
    if (presentable) {
      const b = document.createElement('button'); b.className = 'present-btn'; b.textContent = T().present;
      b.dataset.id = c.id; body.appendChild(b);
    }
    el.appendChild(body);
    return el;
  }

  /** Slam the presented evidence onto the screen. */
  async function showPresented(c) {
    const box = $('presented'); box.innerHTML = '';
    box.appendChild(visualEl(c, 'huge'));
    const cap = document.createElement('div'); cap.className = 'presented-cap'; jt(cap, c.easy || c.title);
    box.appendChild(cap);
    box.classList.remove('hidden'); box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
    SFX.slam(); quake();
    await new Promise((r) => { const end = () => { box.removeEventListener('click', end); r(); }; box.addEventListener('click', end); setTimeout(end, 2600); });
    box.classList.add('hidden');
  }

  function openRecord(presentMode) {
    return new Promise((resolve) => {
      SFX.select();
      $('recordTitle').textContent = T().record;
      $('recordClose').textContent = T().close;
      const list = $('recordList'); list.innerHTML = '';
      for (const c of S.gameCase.evidence) list.appendChild(cardEl(c, presentMode));
      $('record').classList.remove('hidden');
      const done = (v) => { $('record').classList.add('hidden'); list.onclick = null; resolve(v); };
      $('recordClose').onclick = () => done(null);
      list.onclick = (e) => { const b = e.target.closest('.present-btn'); if (b) done(b.dataset.id); };
    });
  }
  $('btnRecord').addEventListener('click', (e) => { e.stopPropagation(); if (S.gameCase && $('record').classList.contains('hidden')) openRecord(false); });

  // ------------------------------------------------------------ title
  function renderTitle() {
    const t = T();
    document.documentElement.lang = S.lang;
    $('logo').textContent = t.title;
    $('logo').classList.toggle('en', S.lang === 'en');
    jt($('tagline'), t.subtitle);
    $('btnStart').textContent = t.start;
    $('btnLang').textContent = t.langToggle;
    jt($('modeLabel'), S.mode === 'live' ? t.modeLive : t.modeDemo);
    $('lifeLabel').textContent = t.credibility;
    $('btnRecord').textContent = t.record;
    $('btnPress').textContent = t.press;
    $('btnPresent').textContent = t.present;
    $('btnArgue').textContent = t.argue;
    $('chalkLabel').textContent = S.lang === 'ja' ? '本日の議題' : "Today's motion";
  }
  $('btnLang').addEventListener('click', () => {
    S.lang = S.lang === 'ja' ? 'en' : 'ja';
    try { localStorage.setItem('rc-lang', S.lang); } catch (_) { /* ignore */ }
    renderTitle();
  });

  // ------------------------------------------------------------ scenes
  async function chooseRumor() {
    const { presets, allowCustom } = await withRetry(() => api('/api/presets', {}));
    const t = T();
    $('pickerTitle').textContent = t.chooseRumor;
    const list = $('presetList'); list.innerHTML = '';
    $('customBox').classList.toggle('hidden', !allowCustom);
    jt($('customHint'), t.customHint);
    $('customInput').placeholder = t.customPlaceholder;
    $('customGo').textContent = t.customButton;
    $('picker').classList.remove('hidden');
    return new Promise((resolve) => {
      for (const p of presets) {
        const b = document.createElement('button'); b.className = 'preset' + (p.live ? ' live' : ''); const lbl = document.createElement('span'); lbl.className = 'preset-text'; jt(lbl, p.rumor); b.appendChild(lbl);
        if (!p.available) { b.disabled = true; b.title = t.liveOnly; const n = document.createElement('small'); n.textContent = t.liveOnly; b.appendChild(n); }
        b.onclick = () => { SFX.select(); $('picker').classList.add('hidden'); resolve(p.live ? { rumor: p.rumor } : { presetId: p.id, rumor: p.rumor }); };
        list.appendChild(b);
      }
      $('customGo').onclick = () => {
        const v = $('customInput').value.trim();
        if (v.length < 4) { $('customInput').focus({ preventScroll: true }); return; }
        SFX.select(); $('picker').classList.add('hidden'); resolve({ rumor: v });
      };
    });
  }

  function chooseSide() {
    const t = T();
    $('sideTitle').textContent = t.chooseSide;
    jt($('sideNote'), t.sideNote);
    document.querySelectorAll('.side-card').forEach((c) => {
      const s = c.dataset.side;
      c.querySelector('.side-role').textContent = t.roles[s];
      c.querySelector('.side-name').textContent = t.names[s];
      jt(c.querySelector('.side-claim'), t.sideClaim[s]);
    });
    $('sidePick').classList.remove('hidden');
    return new Promise((resolve) => {
      document.querySelectorAll('.side-card').forEach((c) => {
        c.onclick = () => { SFX.select(); $('sidePick').classList.add('hidden'); resolve(c.dataset.side); };
      });
    });
  }

  async function investigate(choice) {
    const t = T();
    bgm('investigate');
    showLoading(t.investigating + '…');
    let res;
    if (choice.presetId) {
      res = await withRetry(() => api('/api/case', { presetId: choice.presetId }));
      for (const q of res.case.queries) { addChip(q, 'search'); await sleep(350); }
      $('loadingText').textContent = t.reading + '…';
      await sleep(900);
    } else {
      const msgs = [t.searching, t.reading];
      let k = 0;
      const iv = setInterval(() => { $('loadingText').textContent = msgs[++k % 2] + '…'; }, 3500);
      try { res = await withRetry(() => api('/api/case', { rumor: choice.rumor })); } finally { clearInterval(iv); }
      for (const q of res.case.queries) { addChip(q, 'search'); await sleep(200); }
      await sleep(500);
    }
    hideLoading();
    bgm('court');
    S.gameCase = res.case;
  }

  async function fetchTestimony(round) {
    return api('/api/testimony', { case: S.gameCase, side: S.side, round, previous: S.previous }).then((r) => r.testimony);
  }

  // ------------------------------------------------------------ cross-examination
  function crossAction() {
    return new Promise((resolve) => {
      $('btnPrev').onclick = (e) => { e.stopPropagation(); resolve({ type: 'prev' }); };
      $('btnNext').onclick = (e) => { e.stopPropagation(); resolve({ type: 'next' }); };
      $('btnPress').onclick = (e) => { e.stopPropagation(); resolve({ type: 'press' }); };
      $('btnPresent').onclick = async (e) => {
        e.stopPropagation();
        const id = await openRecord(true);
        if (id) resolve({ type: 'present', id });
      };
      $('btnArgue').onclick = async (e) => {
        e.stopPropagation();
        if (S.mode !== 'live') { flashHint(T().argueLiveOnly); return; }
        const text = await openArgue();
        if (text) resolve({ type: 'argue', text });
      };
    });
  }

  function flashHint(msg) {
    jt($('hint'), msg); $('hint').classList.remove('hidden');
  }

  /** Free-text objection input. Resolves with the text or null. */
  function openArgue() {
    const t = T();
    return new Promise((resolve) => {
      $('argueTitle').textContent = t.argueTitle;
      jt($('argueHelp'), t.argueHelp);
      $('argueInput').placeholder = t.arguePlaceholder;
      $('argueInput').value = '';
      $('argueSend').textContent = t.argueSend;
      $('argueCancel').textContent = t.close;
      $('argue').classList.remove('hidden');
      setTimeout(() => $('argueInput').focus({ preventScroll: true }), 50);
      const done = (v) => { $('argue').classList.add('hidden'); resolve(v); };
      $('argueCancel').onclick = () => done(null);
      $('argueSend').onclick = () => {
        const v = $('argueInput').value.trim();
        if (v.length < 6) { $('argueInput').focus(); return; }
        done(v.slice(0, 200));
      };
    });
  }

  async function breakStatement(tm, st, r, evidenceId) {
    const opp = tm.speaker;
    flash();
    await cutin(S.side);
    if (r.playerLine) await say(S.side, 'triumph', r.playerLine);
    quake(); anim(opp, 'shake');
    SFX.crash();
    await say(opp, 'shocked', r.opponentLine);
    SFX.success();
    await say('judge', 'surprised', r.judgeLine);
    S.previous.push({
      statement: st.text, evidenceId,
      testimony: { intro: tm.intro, statements: tm.statements.map((x) => x.text), angle: tm.angle || '', flawType: tm.flaw?.type || '' },
    });
  }

  async function loseLife(tm, opponentLine, judgeLine) {
    const t = T();
    const opp = tm.speaker;
    anim(opp, 'bump');
    await say(opp, 'smug', opponentLine || pick(t.judgeWrong));
    S.life--;
    SFX.damage(); quake(); flash();
    if (S.life === 1) bgm('pursuit');
    renderHearts(S.life);
    await say('judge', 'stern', judgeLine || pick(t.judgeWrong));
    S.exprs[S.side] = 'nervous';
  }

  /** Ms. Amano helps after repeated misses in the same testimony. */
  async function maybeHint(tm, misses) {
    const t = T();
    if (misses === 2) {
      const n = tm.statements.findIndex((x) => x.id === tm.flaw.statementId) + 1;
      await say('judge', 'normal', t.hintStatement(n));
    } else if (misses >= 3) {
      const ev = S.gameCase.evidence.find((e) => e.id === tm.flaw.evidenceId);
      const n = tm.statements.findIndex((x) => x.id === tm.flaw.statementId) + 1;
      if (ev) await say('judge', 'normal', t.hintEvidence(n, ev.title));
    }
  }

  /** @returns {Promise<boolean>} true = contradiction found, false = out of credibility */
  async function crossExamine(tm) {
    const t = T();
    const opp = tm.speaker;
    let i = 0;
    let misses = 0;
    for (;;) {
      const st = tm.statements[i];
      jt($('hint'), t.hint);
      $('hint').classList.remove('hidden');
      $('cxCounter').textContent = `${i + 1} / ${tm.statements.length}`;
      $('btnPrev').disabled = i === 0;
      $('btnArgue').classList.toggle('locked', S.mode !== 'live');
      await say(opp, S.exprs[opp] === 'shocked' ? 'nervous' : S.exprs[opp], st.text, { statement: true, wait: false });
      $('nextArrow').classList.add('hidden');
      $('cross').classList.remove('hidden');
      const act = await crossAction();
      $('cross').classList.add('hidden');
      $('hint').classList.add('hidden');

      if (act.type === 'prev') { i = Math.max(0, i - 1); continue; }
      if (act.type === 'next') { i = (i + 1) % tm.statements.length; continue; }
      if (act.type === 'press') {
        SFX.press();
        await say(S.side, 'thinking', pick(t.pressLine));
        await say(opp, pick(['smug', 'normal', 'thinking']), st.press || '…');
        continue;
      }

      if (act.type === 'argue') {
        await say(S.side, 'smug', act.text, { wait: false });
        await sleep(400);
        showLoading(t.ruling + '…');
        const r = await withRetry(() => api('/api/argue', { case: S.gameCase, testimony: tm, statementId: st.id, argument: act.text }));
        hideLoading();
        if (r.result === 'valid') {
          await breakStatement(tm, st, { playerLine: '', opponentLine: r.opponentLine, judgeLine: r.judgeLine }, 'ARGUMENT');
          return true;
        }
        if (r.result === 'weak') {
          await say(opp, 'thinking', r.opponentLine);
          await say('judge', 'normal', r.judgeLine);
          continue;
        }
        await loseLife(tm, r.opponentLine, r.judgeLine);
        if (S.life <= 0) return false;
        misses++; await maybeHint(tm, misses);
        continue;
      }

      // present evidence
      const card = S.gameCase.evidence.find((c) => c.id === act.id);
      await say(S.side, 'smug', t.presentLine(card.title), { wait: false });
      await showPresented(card);
      showLoading(t.ruling + '…');
      const r = await withRetry(() => api('/api/judge', { case: S.gameCase, testimony: tm, statementId: st.id, evidenceId: card.id }));
      hideLoading();
      if (r.correct) { await breakStatement(tm, st, r, card.id); return true; }
      await loseLife(tm, r.opponentLine, null);
      if (S.life <= 0) return false;
      misses++; await maybeHint(tm, misses);
    }
  }

  // ------------------------------------------------------------ verdict card
  async function showVerdict(win) {
    const t = T();
    showLoading(t.ruling + '…');
    const { verdict: v } = await withRetry(() => S.verdictPromise.catch(() => (S.verdictPromise = api('/api/verdict', { case: S.gameCase }))));
    hideLoading();
    $('resultBadge').textContent = win ? t.result.win : t.result.lose;
    $('resultBadge').className = 'result-badge' + (win ? '' : ' lose');
    $('verdictTitle').textContent = t.verdictTitle;
    jt($('verdictRumor'), S.lang === 'ja' ? `「${S.gameCase.rumor}」` : `“${S.gameCase.rumor}”`);
    const stamp = $('stamp');
    stamp.textContent = t.labels[v.label] || v.label;
    stamp.className = 'stamp ' + ({ TRUE: 'true', MOSTLY_TRUE: 'true', FALSE: 'false', MOSTLY_FALSE: 'false', MIXED: 'mixed', UNPROVEN: 'unproven' }[v.label] || '');
    jt($('verdictHeadline'), v.headline);
    jt($('verdictSummary'), v.summary);
    const ul = $('verdictPoints'); ul.innerHTML = '';
    for (const p of v.points || []) {
      const li = document.createElement('li');
      const span = document.createElement('span'); jt(span, p.text); li.appendChild(span);
      for (const id of p.evidenceIds || []) {
        const c = S.gameCase.evidence.find((e) => e.id === id); if (!c) continue;
        const a = document.createElement('a'); a.className = 'src-chip'; a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = `${c.id} ${c.source} ↗`; li.appendChild(a);
      }
      ul.appendChild(li);
    }
    $('tipLabel').textContent = t.tip;
    jt($('verdictTip'), v.tip);
    $('btnAgain').textContent = t.again;
    $('btnTitle').textContent = t.toTitle;
    $('powered').textContent = t.poweredBy;
    $('verdict').classList.remove('hidden');
    SFX.gavel();
    return new Promise((resolve) => {
      $('btnAgain').onclick = () => { $('verdict').classList.add('hidden'); resolve('again'); };
      $('btnTitle').onclick = () => { $('verdict').classList.add('hidden'); resolve('title'); };
    });
  }

  // ------------------------------------------------------------ main flow
  function resetStage() {
    ['textbox', 'cross', 'hint', 'hud', 'banner', 'roleTags'].forEach((id) => $(id).classList.add('hidden'));
    S.side = null;
    setSlot('left', null); setSlot('center', null); setSlot('right', null); setDesks('none');
    $('chalkText').textContent = '';
  }

  async function playCase(skipIntro) {
    const t = T();
    resetStage();
    S.life = S.maxLife; S.previous = []; S.exprs = { defense: 'normal', prosecutor: 'normal' };
    bgm('title');

    if (!skipIntro) {
      await say('client', 'normal', t.clientHello);
      await say('judge', 'normal', t.judgeWhat);
    }
    await say('client', 'surprised', t.clientRumor, { wait: false });
    let choice;
    for (;;) {
      choice = await chooseRumor();
      try { await investigate(choice); break; } catch (e) { /* user-facing error (e.g. rejected rumor) -> pick again */ }
    }
    jt($('chalkText'), S.gameCase.rumor);
    await say('judge', 'normal', t.judgeTopic);
    SFX.gavel();
    jt($('topicText'), S.gameCase.rumor);
    $('topicLabel').textContent = t.topic;
    $('lifeLabel').textContent = t.credibility;
    $('roundLabel').textContent = '';
    renderHearts();
    $('hud').classList.remove('hidden');
    await say('judge', 'stern', t.judgeAgenda(S.gameCase.rumor));

    S.side = await chooseSide();
    renderRoleTags();
    S.opp = S.side === 'prosecutor' ? 'defense' : 'prosecutor';

    // Kick off long-running generations early so the player doesn't wait later.
    S.verdictPromise = api('/api/verdict', { case: S.gameCase });
    let nextTestimony = fetchTestimony(1);
    nextTestimony.catch(() => {});

    SFX.gavel();
    await say('judge', 'normal', t.judgeOpen);
    await say('judge', 'stern', t.judgeRule);
    for (const c of S.gameCase.evidence) await toast(c);
    $('hud').classList.remove('hidden');
    renderHearts();
    await say('judge', 'normal', t.judgeEvidence(S.gameCase.evidence.length));

    let win = true;
    for (let round = 1; round <= 2; round++) {
      $('roundLabel').textContent = t.round(round);
      let tm;
      try { tm = await nextTestimony; } catch (_) { tm = null; }
      if (!tm) {
        showLoading(t.preparing + '…');
        tm = await withRetry(() => fetchTestimony(round));
        hideLoading();
      }
      S.exprs[S.opp] = 'smug';
      bgm('court');
      await say(S.opp, 'smug', tm.intro);
      await banner(t.testimonyStart, tm.title);
      for (const st of tm.statements) await say(S.opp, 'normal', st.text, { statement: true });
      await say('judge', 'normal', t.judgeStartCross);
      bgm(round === 1 && S.life > 1 ? 'cross' : 'pursuit');
      await banner(t.crossExam, '', 1300);
      S.exprs[S.side] = 'normal';
      const ok = await crossExamine(tm);
      if (!ok) { win = false; break; }
      if (round === 1) { nextTestimony = fetchTestimony(2); nextTestimony.catch(() => {}); }
    }

    if (win) {
      bgm('win');
      await say(S.opp, 'nervous', t.winOpponent[S.opp]);
      await say(S.side, 'triumph', t.winPlayer[S.side]);
      SFX.gavel();
      await say('judge', 'normal', t.judgeEnd);
      await say('client', 'relieved', t.clientThanks);
    } else {
      bgm('lose');
      await say('judge', 'stern', t.loseJudge);
      await say(S.side, 'shocked', t.losePlayer[S.side]);
    }
    $('textbox').classList.add('hidden');
    return showVerdict(win);
  }

  async function main() {
    renderTitle();
    try { const st = await api('/api/status'); S.mode = st.mode; } catch (_) { S.mode = 'demo'; }
    renderTitle();
    for (;;) {
      $('title').classList.remove('hidden');
      bgm('title');
      await new Promise((r) => { $('btnStart').onclick = () => { audio(); SFX.select(); r(); }; });
      $('title').classList.add('hidden');
      let skip = false;
      for (;;) {
        const next = await playCase(skip);
        skip = true;
        if (next === 'title') break;
      }
      resetStage();
    }
  }
  $('btnMute').onclick = (e) => { e.stopPropagation(); setMuted(!muted); };
  setMuted(muted);
  window.addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') setMuted(!muted); });
  main();

  // debug hook for automated tests
  window.__rc = { S, advance };
})();
