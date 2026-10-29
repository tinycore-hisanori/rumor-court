# Rumor Court (うわさ裁判)

**English** | [日本語](README.ja.md)

**Put internet rumors on trial — with evidence.**

Rumor Court is a courtroom debate game for students. You bring a rumor you saw online ("Eating carrots gives you night vision", "Goldfish have a 3-second memory", or anything you type). An AI agent investigates it on the live web, turns real sources into **evidence cards**, and an AI opponent testifies. Your job is to cross-examine the testimony and **present the evidence card that breaks the false statement**. At the end, the game shows **what is actually true**, with links to every source.

It turns fact-checking — a boring chore — into a game of spotting overstatements, misread sources and "some vs. all" tricks.

- **Live demo: https://rumor.kitakuarcade.com**
- Track: **Best Apps and Agents**
- Built with: **NVIDIA Nemotron 3 (Nano / Super / Ultra) on Nebius Token Factory**, **Tavily Search API**
- Languages: Japanese / English

---

## How it works

```
 rumor ──► Nemotron Nano: safety check + search planning (3-4 queries, EN + native language)
             │
             ▼
        Tavily Search (advanced depth, parallel queries, deduped)
             │  real URLs + snippets
             ▼
        Nemotron Super: evidence clerk — picks 5-7 reliable results and writes evidence cards
             │  (supports / refutes / context, reliability). Cards are only created from real
             │  Tavily results — any URL the model invents is dropped server-side.
             ▼
        Nemotron Ultra: writes the opponent's testimony (3 statements, exactly ONE flaw that
             │  a specific evidence card contradicts) + "press" answers + objection lines
             ▼
 player presents a card ──► exact match? → instant ruling
                            otherwise   → Nemotron Nano judges whether the card still truly
                                          contradicts the statement (alternative answers accepted)
             ▼
        Nemotron Ultra: final "What's actually true" card — verdict label, summary,
                        key points each linked to evidence, and a media-literacy tip
```

### Model routing on Nebius Token Factory

| Step | Model | Why |
|---|---|---|
| Safety check + search planning | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | fast & cheap, runs on every new rumor |
| Evidence extraction from search results | `nvidia/nemotron-3-super-120b-a12b` | long context, faithful structured output |
| Opponent testimony (with a hidden flaw) | `nvidia/Nemotron-3-Ultra-550b-a55b` | needs real reasoning to plant a fair, non-obvious contradiction |
| Objection ruling (non-exact answers) | Nemotron 3 Nano | many quick yes/no judgments during play |
| **Argue** — judging the player's own free-text reasoning | Nemotron 3 Super | classifies the argument as valid / weak / invalid (overgeneralization, anecdote ≠ proof, correlation ≠ causation…) and replies in character |
| Final verdict card | Nemotron 3 Ultra | careful, evidence-only conclusion |

### Where Nebius Token Factory accelerated the work

- **One client, three model sizes.** Token Factory's OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1/`) let a ~100-line, dependency-free client (`server/llm.js`) call Nemotron 3 Nano, Super and Ultra just by switching the model name — no GPU provisioning, no model hosting.
- **Right-sizing per task.** Because all sizes sit behind the same API, each step uses the smallest model that does the job well (Nano for many quick decisions, Ultra only where careful reasoning is needed), which keeps latency and cost low enough to run a public demo.
- **Structured output.** `response_format: json_object` plus `chat_template_kwargs: {enable_thinking: false}` gives fast, parseable JSON for game logic; the client automatically retries with a larger budget if reasoning ever consumes the token limit.
- **Serverless pay-per-token** means the demo runs on a small VPS (Node.js + nginx) with hard daily/monthly caps instead of a GPU server.

All calls use Token Factory's OpenAI-compatible Chat Completions API with `response_format: json_object`, plus server-side validation and one automatic retry.

### Tavily

Tavily is the game's detective: every live case runs 3-4 parallel `search_depth: "advanced"` queries (a fact-check query, an official/scientific evidence query, a rumor-origin query, and one in the rumor's own language). Results are deduplicated by URL and ranked by Tavily's relevance score before Nemotron Super reads them. Every evidence card keeps its source URL, so players can open the original page from the Court Record and from the final verdict.

### Cost & abuse controls

- Disk + memory cache: the same rumor/testimony/ruling is never generated twice.
- Verdict and next testimony are **prefetched** while the player reads dialogue, so waits are short.
- Hard cost guard for new live cases: per-IP rate limit plus daily and monthly caps (`LIVE_CASES_PER_IP_PER_HOUR`=3, `LIVE_CASES_PER_DAY`=10, `LIVE_CASES_PER_MONTH`=100 by default). Counters persist across restarts.
- Rumors that target private individuals, sexual content, self-harm, hate or dangerous instructions are rejected by the Nano safety check.

---

## Run it

Requirements: Node.js 18+ (no npm dependencies).

```bash
git clone https://github.com/tinycore-hisanori/rumor-court
cd rumor-court
cp .env.example .env      # add NEBIUS_API_KEY and TAVILY_API_KEY
npm start                 # http://localhost:8787
```

- **LIVE mode** (both keys set): type any rumor; the game investigates it on the spot.
- **DEMO mode** (no keys): two bundled cases with real, linked sources are playable offline.
  The bundled preset rumors are also served from these files in LIVE mode, so the demo never fails (set `LIVE_PRESETS=1` to run them live too).

### Your own rumor list (`rumors.txt`)

Edit `rumors.txt` to choose which rumors appear in the picker — one per line, optionally `日本語 | English`.
The file is re-read on every request (no restart needed). These rumors are investigated live when selected.
Set `HIDE_BUNDLED_CASES=1` to show only your list in LIVE mode.

### Docker / Nebius Serverless Endpoints

```bash
docker build -t rumor-court .
docker run -p 8080:8080 -e NEBIUS_API_KEY=... -e TAVILY_API_KEY=... rumor-court
```

The container listens on `$PORT` (default 8080 in Docker), so it can be deployed as a Nebius Serverless Endpoint or on any container host.

### Controls

**Argue** (A, LIVE mode): no evidence? Type your own reasoning — Nemotron judges whether your logic really breaks the statement. Miss twice and Ms. Amano gives a hint.

Click / Enter: advance · ◀ ▶ / arrow keys: move between statements · **Press** (P): ask for details · **Present** (E): show evidence · **Court Record**: read all evidence and open sources · **M**: sound on/off.

---

## Project structure

```
server/server.js     HTTP server, API routes, cache, rate limits, demo fixtures
server/game.js       prompts + validation: case file, testimony, objection ruling, verdict
server/llm.js        Nebius Token Factory client with Nano / Super / Ultra routing
server/tavily.js     Tavily search client (parallel queries, dedupe, ranking)
server/fixtures/     bundled demo cases (real sources, JA/EN)
public/              game client (vanilla JS + DOM, WebAudio sound effects, looping BGM)
test/                Playwright playthrough + mock Nebius/Tavily server
```

### Tests

```bash
npm start &                                   # demo mode
NODE_PATH=$(npm root -g) node test/playthrough.js carrots defense ja
# LIVE-mode logic without spending credits:
node test/mock-apis.js &
NEBIUS_API_KEY=x TAVILY_API_KEY=y NEBIUS_BASE_URL=http://localhost:9999/v1/ TAVILY_API_URL=http://localhost:9999/search PORT=8788 npm start
```

---

## License

- Source code: **MIT** (see `LICENSE`)
- Character artwork, music and voice: **CC BY-NC 4.0** (see `public/assets/LICENSE-ASSETS.md`; music and voice are reused from the author's earlier game *ぼくらの放課後裁判*)
- English "Wait!" voices: **VOICEVOX:白上虎太郎**, **VOICEVOX:冥鳴ひまり** (made with [VOICEVOX](https://voicevox.hiroshiba.jp/), used under each character's terms)
- `public/vendor/budoux-ja.js`: Japanese phrase segmentation model/parser from [BudouX](https://github.com/google/budoux) (Apache-2.0, © Google LLC), used for natural Japanese line breaks

