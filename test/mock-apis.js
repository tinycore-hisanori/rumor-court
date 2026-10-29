// Mock Nebius (OpenAI-compatible) + Tavily endpoints for offline testing of LIVE mode.
// node test/mock-apis.js   -> port 9999
const http = require('http');
const reply = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    let out;
    if (req.url.startsWith('/search')) {
      out = { results: [1, 2, 3, 4].map((i) => ({ url: `https://example.org/${encodeURIComponent(b.query)}/${i}`, title: `Result ${i} for ${b.query}`, content: `Snippet ${i}: soda contains phosphoric acid; studies show ${i % 2 ? 'no' : 'some'} link to bone density.`, score: 1 - i / 10 })) };
    } else {
      const sys = b.messages[0].content;
      const user = b.messages[1].content;
      if (sys.includes('plan web searches')) {
        out = reply(JSON.stringify({ allowed: !user.includes('BADRUMOR'), reason: 'not allowed', claim_en: 'Soda dissolves bones', queries: ['soda bones fact check', 'phosphoric acid bone density study', '炭酸 骨 溶ける'] }));
      } else if (sys.includes('evidence clerk')) {
        out = reply('<think>thinking...</think>```json\n' + JSON.stringify({ cards: [0, 1, 2, 3, 99].map((i) => ({ index: i, title: `証拠${i}`, summary: `要約${i}`, stance: i % 2 ? 'refutes' : 'supports', reliability: 'high' })) }) + '\n```');
      } else if (sys.includes('scenario writer')) {
        const round2 = user.includes('Round 2 of 2');
        out = reply(JSON.stringify({ title: round2 ? '第二証言' : '第一証言', intro: '証言するよ', angle: round2 ? 'who' : 'mechanism', statements: [1, 2, 3].map((i) => ({ id: 'S' + i, text: round2 ? `別の角度の主張その${i}` : `発言${i}`, press: `ゆさぶり${i}` })), flaw: { statementId: 'S2', evidenceId: round2 ? 'E3' : 'E1', type: round2 ? 'some_vs_all' : 'overgeneralization', playerArgument: 'ここが矛盾！', opponentReaction: 'うっ', judgeComment: 'なるほど' } }));
      } else if (sys.includes('fair but strict judge')) {
        out = reply(JSON.stringify({ contradicts: user.includes('[E2]'), confidence: 0.9, playerArgument: '別解で崩した！', opponentRebuttal: 'その証拠は関係ないよ' }));
      } else if (sys.includes('debate-club teacher')) {
        const r = user.includes('体験談') ? 'valid' : user.includes('ちがう') ? 'weak' : 'invalid';
        out = reply(JSON.stringify({ result: r, opponentLine: '相手の反応(' + r + ')', judgeLine: '先生の講評(' + r + ')' }));
      } else if (sys.includes('final "what is actually true"')) {
        out = reply(JSON.stringify({ label: 'MOSTLY_FALSE', headline: '骨は溶けない', summary: 'まとめ', points: [{ text: 'ポイント', evidenceIds: ['E1', 'E9'] }], tip: 'ヒント' }));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out || {}));
  });
}).listen(9999, () => console.log('mock on 9999'));
