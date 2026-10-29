// Nebius Token Factory client (OpenAI-compatible) with model routing:
//   nano  -> fast, cheap calls (search-query planning, judging a single objection, short rebuttals)
//   super -> evidence extraction from Tavily results (long context, structured output)
//   ultra -> the opponent's testimony and the final verdict (serious reasoning)
'use strict';

const DEFAULT_BASE = 'https://api.tokenfactory.nebius.com/v1/';
const US_BASE = 'https://api.tokenfactory.us-central1.nebius.com/v1/';

const TIERS = {
  nano: {
    model: process.env.MODEL_NANO || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    base: process.env.NEBIUS_BASE_NANO || process.env.NEBIUS_BASE_URL || DEFAULT_BASE,
  },
  super: {
    model: process.env.MODEL_SUPER || 'nvidia/nemotron-3-super-120b-a12b',
    base: process.env.NEBIUS_BASE_SUPER || process.env.NEBIUS_BASE_URL || DEFAULT_BASE,
  },
  ultra: {
    model: process.env.MODEL_ULTRA || 'nvidia/Nemotron-3-Ultra-550b-a55b',
    base: process.env.NEBIUS_BASE_ULTRA || process.env.NEBIUS_BASE_URL || DEFAULT_BASE,
  },
};

const usage = { calls: 0, byTier: { nano: 0, super: 0, ultra: 0 }, promptTokens: 0, completionTokens: 0 };

function hasKey() { return !!process.env.NEBIUS_API_KEY; }

function stripThinking(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

function extractJson(text) {
  const t = stripThinking(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  throw new Error('Model did not return valid JSON');
}

async function post(base, body) {
  const url = base.replace(/\/?$/, '/') + 'chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || 120000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Nebius ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion that returns parsed JSON.
 * @param {'nano'|'super'|'ultra'} tier
 */
async function chatJson(tier, system, user, { maxTokens = 2000, temperature = 0.6 } = {}) {
  const cfg = TIERS[tier];
  const messages = [
    { role: 'system', content: system + '\nRespond with a single JSON object only. No markdown, no commentary.' },
    { role: 'user', content: user },
  ];
  // Nemotron 3 models reason before answering. The reasoning uses output tokens, so we
  // (1) ask the chat template to skip thinking for speed, and (2) leave plenty of token budget anyway.
  let thinkingOff = process.env.NEMOTRON_ENABLE_THINKING !== '1';
  let budget = maxTokens + 4000;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: cfg.model, messages, max_tokens: budget, temperature, response_format: { type: 'json_object' } };
    if (thinkingOff) body.chat_template_kwargs = { enable_thinking: false };
    try {
      let data;
      try {
        data = await post(cfg.base, body);
      } catch (e) {
        if (e.status === 400 && thinkingOff && /chat_template|enable_thinking|kwargs/i.test(e.message)) {
          thinkingOff = false; continue; // endpoint doesn't accept the toggle: retry with thinking on
        }
        if (e.status === 404) { // model not served here: try the other public endpoint
          const alt = cfg.base === US_BASE ? DEFAULT_BASE : US_BASE;
          data = await post(alt, body);
          cfg.base = alt;
        } else throw e;
      }
      usage.calls++;
      usage.byTier[tier]++;
      if (data.usage) {
        usage.promptTokens += data.usage.prompt_tokens || 0;
        usage.completionTokens += data.usage.completion_tokens || 0;
      }
      const choice = data.choices?.[0] || {};
      const content = choice.message?.content || '';
      if (!content.trim() && choice.finish_reason === 'length') { budget *= 2; throw new Error('Ran out of tokens while reasoning'); }
      return extractJson(content);
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') break;
      if (e.status && e.status !== 400) break;
      if (!/tokens/.test(e.message)) messages.push({ role: 'user', content: 'Your previous answer was not valid JSON. Return ONLY the JSON object.' });
    }
  }
  throw lastErr;
}

module.exports = { chatJson, hasKey, TIERS, usage, extractJson };
