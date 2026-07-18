/*
 * 六课斥候请假小助手 · AI 后端代理
 * 零依赖，原生 Node.js（需 Node 18+，自带 fetch）
 *
 * 作用：
 *  1. 托管前端静态文件 (public/)
 *  2. /api/generate 代理调用大模型（OpenAI 兼容 / 阿里云 DashScope）
 *  3. API Key 只存在服务端环境变量，绝不返回给前端
 *  4. 在服务端执行"检查机制"：真实目的铁律过滤、JSON 容错解析、类型校验
 *
 * 运行：
 *  本地：  AI_API_KEY=sk-xxx node server.js
 *  或 .env：在同级目录放 .env 文件写入 AI_API_KEY=sk-xxx，再 node server.js
 *  云端：  设置环境变量 AI_API_KEY / AI_ENDPOINT / AI_MODEL / PORT 即可
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ---------- 配置（环境变量优先，支持 .env）----------
loadDotEnv();
const PORT = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
const API_KEY = process.env.AI_API_KEY || '';
const ENDPOINT = process.env.AI_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = process.env.AI_MODEL || 'qwen-plus';

const TYPE_ICON = { '病假': '🤒', '事假': '🪪', '家庭': '👨‍⚕️', '突发': '🚨' };
const VALID_TYPES = ['病假', '事假', '家庭', '突发'];

// ---------- 极简 .env 解析（零依赖）----------
function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === '/' ) p = '/index.html';
  const fp = path.join(__dirname, 'public', p);
  if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => { let s = ''; req.on('data', c => s += c); req.on('end', () => resolve(s)); });
}

// ---------- 大模型 Prompt ----------
function buildMessages(opts) {
  const sys = `你是"六课斥候请假小助手"，为搭档（用户）编造合理、可信、不易被拆穿的请假理由。语气幽默随性，一本正经地胡说八道。

【铁律】用户提供的"真实目的"（如旅游、看演唱会、漫展、爬山、度假、出国）的任何字眼，绝不能出现在生成的理由中，必须另编完全无关的借口。

【约束】
1. 理由必须合理可信，贴近日常生活，不夸张不荒诞。
2. 严禁伪造病历、证件等违法理由。
3. 根据请假天数调整理由分量：半天/1天用轻量理由，多天长假用更站得住脚、不易被追问的理由。
4. 理由类型限定为：病假 / 事假 / 家庭 / 突发 四选一。
5. 理由内容要含具体可信的细节（时间、症状、对象、地点等），但不要过度编造可被验证的硬信息。

【输出格式】严格输出以下 JSON，不要输出任何其他文字、不要 markdown 代码块、不要解释：
{"recommended":{"type":"类型","content":"理由内容（口语化，可直接发给领导）","cred":85,"doc":"是否需要证明材料及建议","boss":"应对领导追问的话术","prep":"需提前准备什么"},"alternatives":[{"type":"类型","content":"理由内容"},{"type":"类型","content":"理由内容"}]}

cred 为 0-100 整数可信度。alternatives 给 2-3 条，类型尽量与推荐不同。`;

  const user = `请假需求：
- 请假天数：${opts.days} 天
- 紧急程度：${opts.urgency === 'random' ? '不限' : opts.urgency}
- 倾向类型：${opts.typePref === 'random' ? '斥候自选最佳' : opts.typePref}
- 真实目的（铁律：绝不能出现在理由中）：${opts.realPurpose || '未提供'}
- 特殊要求：${opts.extra || '无'}

请按指定 JSON 格式输出。`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// ---------- 检查机制：解析 + 真实目的过滤 + 校验 ----------
function parseResult(content, opts) {
  let txt = (content || '').trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i0 = txt.indexOf('{'), i1 = txt.lastIndexOf('}');
  if (i0 >= 0 && i1 > i0) txt = txt.slice(i0, i1 + 1);
  let obj;
  try { obj = JSON.parse(txt); } catch (e) { return { error: 'AI 返回 JSON 解析失败' }; }
  if (!obj.recommended || !obj.recommended.content) return { error: 'AI 返回结构不完整' };

  // 检查机制1：真实目的铁律过滤
  const rp = (opts.realPurpose || '').trim();
  if (rp) {
    const all = (obj.recommended.content + ' ' + (obj.alternatives || []).map(a => a.content || '').join(' ')).toLowerCase();
    const leaked = rp.split(/[\s,，、]+/).filter(k => k.length >= 2).some(k => all.includes(k.toLowerCase()));
    if (leaked) return { error: 'AI 理由泄漏了真实目的，已拦截（铁律）。请点"换一批"重试' };
  }
  // 检查机制2：类型校验 + 字段补齐
  const recType = VALID_TYPES.includes(obj.recommended.type) ? obj.recommended.type : '事假';
  const rec = {
    type: recType, icon: TYPE_ICON[recType],
    content: String(obj.recommended.content).slice(0, 300),
    cred: Math.max(50, Math.min(99, parseInt(obj.recommended.cred) || 80)),
    doc: obj.recommended.doc || '一般无需证明，按公司流程申请即可',
    boss: obj.recommended.boss || '如实、简洁地说明情况即可',
    prep: obj.recommended.prep || '注意言行一致，当天避免在社交媒体暴露行踪',
  };
  const alts = (obj.alternatives || []).slice(0, 3).map(a => {
    const t = VALID_TYPES.includes(a.type) ? a.type : '事假';
    return { type: t, icon: TYPE_ICON[t], content: String(a.content || '').slice(0, 200) };
  }).filter(a => a.content);
  return { recommended: rec, alts, source: 'ai' };
}

// ---------- 处理 /api/generate ----------
async function handleGenerate(req, res) {
  if (!API_KEY) return json(res, 500, { error: '服务端未配置 AI_API_KEY，请联系部署者' });
  const raw = await readBody(req);
  let opts;
  try { opts = JSON.parse(raw); } catch (e) { return json(res, 400, { error: '请求格式错误' }); }
  if (!opts || !opts.days) return json(res, 400, { error: '缺少请假天数' });

  const body = { model: MODEL, messages: buildMessages(opts), temperature: 0.85 };
  try { body.response_format = { type: 'json_object' }; } catch (e) {}

  try {
    const ctrl = { aborted: false };
    const timer = setTimeout(() => { ctrl.aborted = true; }, 40000);
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    if (ctrl.aborted) return json(res, 504, { error: '大模型响应超时(40s)' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.error?.message || data.message || ('HTTP ' + r.status);
      return json(res, 502, { error: '大模型返回错误：' + String(msg).slice(0, 150) });
    }
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) return json(res, 502, { error: '大模型返回内容为空' });
    const parsed = parseResult(content, opts);
    return json(res, 200, parsed); // parsed 可能含 error（检查机制拦截）
  } catch (e) {
    return json(res, 502, { error: '大模型调用失败：' + (e.message || e) });
  }
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  // CORS（若前后端分域名部署也允许）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const p = url.parse(req.url).pathname;
  if (p === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);
  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL, endpoint: ENDPOINT.replace(/\/[^/]*$/, '/***') });
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('六课斥候请假小助手 · AI 后端已启动');
  console.log('  本地访问: http://localhost:' + PORT);
  console.log('  模型: ' + MODEL + ' | Key 已配置: ' + (API_KEY ? '是' : '否（请设置 AI_API_KEY）'));
});
