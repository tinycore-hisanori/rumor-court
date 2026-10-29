// Tavily web search: the "detective" that collects evidence for the trial.
'use strict';

const usage = { searches: 0 };

function hasKey() { return !!process.env.TAVILY_API_KEY; }

async function search(query, { maxResults = 5, depth = 'advanced' } = {}) {
  const res = await fetch(process.env.TAVILY_API_URL || 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  usage.searches++;
  const data = await res.json();
  return (data.results || []).map((r) => ({
    url: r.url,
    title: r.title,
    content: (r.content || '').slice(0, 1200),
    score: r.score || 0,
    published: r.published_date || null,
    query,
  }));
}

/** Run several queries in parallel and merge results (dedupe by URL, keep best score). */
async function searchMany(queries, opts) {
  const lists = await Promise.allSettled(queries.map((q) => search(q, opts)));
  const byUrl = new Map();
  for (const l of lists) {
    if (l.status !== 'fulfilled') continue;
    for (const r of l.value) {
      const prev = byUrl.get(r.url);
      if (!prev || prev.score < r.score) byUrl.set(r.url, r);
    }
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

module.exports = { search, searchMany, hasKey, usage };
