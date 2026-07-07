'use strict';
/*
 * Subagent Job Notifier - server
 * Claude Code のサブエージェント / Codex CLI セッションのログを読み取り専用で監視し、
 * ダッシュボード(public/index.html)にジョブ一覧を提供する。依存パッケージなし。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
function argNum(name, def) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) || def : def;
}
function argStr(name, def) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
}

const PORT = argNum('port', 45680);
const HOST = argStr('host', '127.0.0.1');
const WINDOW_MS = argNum('hours', 24) * 3600 * 1000;
const STALL_MS = argNum('stall-min', 5) * 60 * 1000;
const SCAN_INTERVAL_MS = argNum('scan-sec', 15) * 1000;
const TOAST = argStr('toast', 'on') !== 'off';
const TOAST_STALLED = args.includes('--toast-stalled');

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_TASKS = path.join(HOME, '.claude', 'tasks');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const JOBS_DIR = path.join(__dirname, 'jobs');

// ---------- utils ----------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}
function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}
function modelKeyOf(modelId) {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  for (const k of ['sonnet', 'opus', 'haiku', 'fable', 'codex']) {
    if (m.includes(k)) return k;
  }
  if (m.startsWith('gpt')) return 'gpt';
  return 'other';
}
function truncate(s, n) {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------- Claude: 親セッション transcript の増分スキャン(tool_result 検出) ----------

// parentPath -> { offset, rem, found: Map(toolUseId -> completedAtISO), cwd }
const parentState = new Map();

function scanParent(parentPath) {
  let st = parentState.get(parentPath);
  if (!st) {
    st = { offset: 0, rem: '', found: new Map(), cwd: null };
    parentState.set(parentPath, st);
  }
  const stat = safeStat(parentPath);
  if (!stat || stat.size <= st.offset) return st;
  let text;
  try {
    const fd = fs.openSync(parentPath, 'r');
    const buf = Buffer.alloc(stat.size - st.offset);
    fs.readSync(fd, buf, 0, buf.length, st.offset);
    fs.closeSync(fd);
    st.offset = stat.size;
    text = st.rem + buf.toString('utf8');
  } catch {
    return st;
  }
  const lastNl = text.lastIndexOf('\n');
  const body = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  st.rem = lastNl >= 0 ? text.slice(lastNl + 1) : text;

  for (const line of body.split('\n')) {
    if (!line) continue;
    if (!st.cwd) {
      const mc = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (mc) { try { st.cwd = JSON.parse(`"${mc[1]}"`); } catch {} }
    }
    if (!line.includes('"type":"tool_result"')) continue;
    const ts = (line.match(/"timestamp":"([^"]+)"/) || [])[1] || null;
    // run_in_background のエージェントは起動直後に「Async agent launched」の tool_result が
    // 返るため、これは完了の証拠にならない
    const isAsync = line.includes('Async agent launched');
    const re = /"tool_use_id":"(toolu_[A-Za-z0-9]+)"/g;
    let m;
    while ((m = re.exec(line))) st.found.set(m[1], { ts, async: isAsync });
  }
  return st;
}

// ---------- Claude: サブエージェント transcript の解析(サイズが変わった時だけ読む) ----------

const agentCache = new Map(); // jsonlPath -> { size, data }

function parseAgentLog(jsonlPath, stat) {
  const cached = agentCache.get(jsonlPath);
  if (cached && cached.size === stat.size) return cached.data;
  let content;
  try { content = fs.readFileSync(jsonlPath, 'utf8'); } catch { return cached ? cached.data : null; }
  const lines = content.split('\n').filter(Boolean);

  let model = null;
  const mre = /"model":"(claude-[^"]+)"/g;
  let mm;
  while ((mm = mre.exec(content))) model = mm[1];

  let firstTs = null;
  if (lines.length) {
    const t = (lines[0].match(/"timestamp":"([^"]+)"/) || [])[1];
    if (t) firstTs = t;
  }

  // 最終行の種別: 'text'(報告で終わっている=完了らしい) / 'tool'(ツール実行途中) / 'other'
  let lastKind = 'other';
  const lastObj = lines.length ? tryParse(lines[lines.length - 1]) : null;
  if (lastObj) {
    const lm = lastObj.message;
    if (lm && lm.role === 'assistant' && Array.isArray(lm.content)) {
      lastKind = lm.content.some((c) => c && c.type === 'tool_use') ? 'tool' : 'text';
    } else if (lastObj.type === 'user') {
      lastKind = 'tool';
    }
  }

  let lastMessage = '';
  for (let i = lines.length - 1; i >= 0 && !lastMessage; i--) {
    const obj = tryParse(lines[i]);
    const msg = obj && obj.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (item.type === 'text' && item.text) lastMessage = truncate(item.text, 120);
      else if (item.type === 'tool_use') lastMessage = `[${item.name}] ${truncate(JSON.stringify(item.input || {}), 80)}`;
    }
  }

  const data = { lineCount: lines.length, model, firstTs, lastMessage, lastKind };
  agentCache.set(jsonlPath, { size: stat.size, data });
  return data;
}

function taskProgress(sessionId) {
  const dir = path.join(CLAUDE_TASKS, sessionId);
  let done = 0, total = 0;
  for (const e of safeReaddir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const t = safeReadJson(path.join(dir, e.name));
    if (!t || !t.status) continue;
    total++;
    if (t.status === 'completed') done++;
  }
  return total ? { tasksDone: done, tasksTotal: total } : null;
}

function scanClaude(now) {
  const jobs = [];
  for (const proj of safeReaddir(CLAUDE_PROJECTS)) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(CLAUDE_PROJECTS, proj.name);
    for (const sess of safeReaddir(projPath)) {
      if (!sess.isDirectory()) continue;
      const subDir = path.join(projPath, sess.name, 'subagents');
      const entries = safeReaddir(subDir);
      if (!entries.length) continue;

      const parentPath = path.join(projPath, `${sess.name}.jsonl`);
      let parent = null; // 必要になった時だけスキャン
      let tasks;

      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.meta.json')) continue;
        const metaPath = path.join(subDir, e.name);
        const jsonlPath = metaPath.replace(/\.meta\.json$/, '.jsonl');
        const jstat = safeStat(jsonlPath);
        const mstat = safeStat(metaPath);
        const lastMtime = Math.max(jstat ? jstat.mtimeMs : 0, mstat ? mstat.mtimeMs : 0);
        if (!lastMtime || now - lastMtime > WINDOW_MS) continue;

        const meta = safeReadJson(metaPath) || {};
        if (!parent) parent = scanParent(parentPath);
        if (tasks === undefined) tasks = taskProgress(sess.name);

        const log = jstat ? parseAgentLog(jsonlPath, jstat) : null;
        const startedAt = (log && log.firstTs) ? Date.parse(log.firstTs) : (mstat ? mstat.mtimeMs : lastMtime);
        const found = meta.toolUseId ? parent.found.get(meta.toolUseId) : undefined;

        let status, completedAt = null;
        if (found && !found.async) {
          // 通常(フォアグラウンド)起動: 親に tool_result が出たら確定で完了
          status = 'complete';
          completedAt = found.ts ? Date.parse(found.ts) : (jstat ? jstat.mtimeMs : lastMtime);
        } else if (now - lastMtime <= STALL_MS) {
          status = 'running';
        } else if (log && log.lastKind === 'text') {
          // バックグラウンド起動などで完了マーカーがない場合:
          // ログがテキスト報告で終わったまま静止していれば完了とみなす
          status = 'complete';
          completedAt = jstat ? jstat.mtimeMs : lastMtime;
        } else {
          status = 'stalled';
        }

        jobs.push({
          id: `claude:${sess.name}:${e.name.replace(/\.meta\.json$/, '')}`,
          source: 'claude',
          name: meta.description || e.name,
          agentType: meta.agentType || 'agent',
          model: log ? log.model : null,
          modelKey: modelKeyOf(log && log.model),
          status,
          startedAt,
          completedAt,
          lastActivityAt: jstat ? jstat.mtimeMs : lastMtime,
          elapsedSec: Math.max(0, Math.round(((completedAt || now) - startedAt) / 1000)),
          progress: { lines: log ? log.lineCount : 0, ...(tasks || {}) },
          lastMessage: log ? log.lastMessage : '',
          project: parent.cwd || proj.name,
        });
      }
    }
  }
  return jobs;
}

// ---------- Codex: rollout ファイルの解析 ----------

const codexCache = new Map(); // path -> { size, data }

function parseCodexRollout(p, stat) {
  const cached = codexCache.get(p);
  if (cached && cached.size === stat.size) return cached.data;
  let content;
  try { content = fs.readFileSync(p, 'utf8'); } catch { return cached ? cached.data : null; }
  const lines = content.split('\n').filter(Boolean);

  let cwd = null, sessionTs = null, model = null, userText = null;
  let lastStarted = null, lastComplete = null, lastAgentMessage = '';

  for (const line of lines) {
    if (line.includes('"type":"session_meta"')) {
      const obj = tryParse(line);
      const pl = obj && obj.payload;
      if (pl) { cwd = pl.cwd || null; sessionTs = pl.timestamp || obj.timestamp || null; }
    } else if (line.includes('"type":"turn_context"')) {
      const m = line.match(/"model":"([^"]+)"/);
      if (m) model = m[1];
    } else if (line.includes('"task_started"')) {
      const t = (line.match(/"timestamp":"([^"]+)"/) || [])[1];
      lastStarted = t ? Date.parse(t) : stat.mtimeMs;
    } else if (line.includes('"task_complete"')) {
      const obj = tryParse(line);
      lastComplete = obj && obj.timestamp ? Date.parse(obj.timestamp) : stat.mtimeMs;
      const msg = obj && obj.payload && obj.payload.last_agent_message;
      if (msg) lastAgentMessage = truncate(msg, 120);
    } else if (!userText && line.includes('"role":"user"')) {
      const obj = tryParse(line);
      const pl = obj && obj.payload;
      if (pl && pl.role === 'user' && Array.isArray(pl.content)) {
        for (const c of pl.content) {
          const t = c && c.text;
          if (t && !t.startsWith('<')) { userText = truncate(t, 80); break; }
        }
      }
    }
  }

  const data = { cwd, sessionTs, model, userText, lastStarted, lastComplete, lastAgentMessage, lineCount: lines.length };
  codexCache.set(p, { size: stat.size, data });
  return data;
}

function scanCodex(now) {
  const jobs = [];
  const walk = (dir, depth) => {
    for (const e of safeReaddir(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(full, depth + 1); continue; }
      if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
      const stat = safeStat(full);
      if (!stat || now - stat.mtimeMs > WINDOW_MS) continue;
      const d = parseCodexRollout(full, stat);
      if (!d) continue;

      let status, completedAt = null;
      const pending = d.lastStarted && (!d.lastComplete || d.lastComplete < d.lastStarted);
      if (pending) {
        status = now - stat.mtimeMs <= STALL_MS ? 'running' : 'stalled';
      } else if (d.lastComplete) {
        status = 'complete';
        completedAt = d.lastComplete;
      } else {
        status = now - stat.mtimeMs <= STALL_MS ? 'running' : 'stalled';
      }

      // 対話セッションは数日続くことがあるので、直近タスクの開始時刻をジョブ開始とみなす
      const startedAt = d.lastStarted || (d.sessionTs ? Date.parse(d.sessionTs) : stat.birthtimeMs || stat.mtimeMs);
      const shortId = e.name.slice(-11, -6);
      jobs.push({
        id: `codex:${e.name}`,
        source: 'codex',
        name: d.userText || `codex session ${shortId}`,
        agentType: 'codex CLI',
        model: d.model || 'codex',
        modelKey: 'codex',
        status,
        startedAt,
        completedAt,
        lastActivityAt: stat.mtimeMs,
        elapsedSec: Math.max(0, Math.round(((completedAt || stat.mtimeMs) - startedAt) / 1000)),
        progress: { lines: d.lineCount },
        lastMessage: d.lastAgentMessage,
        project: d.cwd || '',
      });
    }
  };
  walk(CODEX_SESSIONS, 0);
  return jobs;
}

// ---------- external: jobs/ ディレクトリ(POST /api/jobs または直接ファイル書き込みで登録) ----------

function scanExternal(now) {
  const jobs = [];
  for (const e of safeReaddir(JOBS_DIR)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const p = path.join(JOBS_DIR, e.name);
    const stat = safeStat(p);
    if (!stat || now - stat.mtimeMs > WINDOW_MS) continue;
    const j = safeReadJson(p);
    if (!j) continue;

    const updatedAt = j.updatedAt || stat.mtimeMs;
    const startedAt = j.startedAt || stat.birthtimeMs || updatedAt;
    let status = (j.status === 'complete' || j.status === 'error') ? j.status : 'running';
    let completedAt = null;
    if (status === 'complete' || status === 'error') {
      completedAt = j.completedAt || updatedAt;
    } else if (now - updatedAt > STALL_MS) {
      status = 'stalled';
    }

    const prog = j.progress || {};
    jobs.push({
      id: `external:${j.id || e.name.replace(/\.json$/, '')}`,
      source: 'external',
      name: j.name || j.id || e.name,
      agentType: j.agentType || 'script',
      model: j.model || null,
      modelKey: modelKeyOf(j.model) || 'script',
      status,
      startedAt,
      completedAt,
      lastActivityAt: updatedAt,
      elapsedSec: Math.max(0, Math.round(((completedAt || now) - startedAt) / 1000)),
      progress: {
        ...(Number.isFinite(prog.done) && Number.isFinite(prog.total)
          ? { done: prog.done, total: prog.total, unit: prog.unit || '' } : {}),
      },
      lastMessage: truncate(j.message || j.lastMessage || '', 120),
      project: j.project || '',
    });
  }
  return jobs;
}

// ---------- Windows トースト通知 ----------

// 固定スクリプト + データは環境変数渡し(インジェクション回避・実行ポリシー非依存)
const TOAST_COMMAND = `
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime];
function Esc([string]$s) { ($s -replace '&', '&amp;') -replace '<', '&lt;' -replace '>', '&gt;' };
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;
$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$(Esc $env:TOAST_TITLE)</text><text>$(Esc $env:TOAST_BODY)</text></binding></visual></toast>");
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
$toast = New-Object Windows.UI.Notifications.ToastNotification($xml);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast);
`.replace(/\r?\n/g, ' ');

function fmtElapsedJp(sec) {
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`;
}

function notifyToast(job) {
  const icon = job.status === 'error' ? '❌' : job.status === 'stalled' ? '⚠️' : '✅';
  const title = truncate(`${icon} ${job.name}`, 80);
  const body = truncate(
    `${job.agentType} (${job.modelKey || ''}) · ${job.status} · ${fmtElapsedJp(job.elapsedSec)}` +
    (job.lastMessage ? `\n${job.lastMessage}` : ''), 180);
  execFile('powershell.exe', ['-NoProfile', '-Command', TOAST_COMMAND], {
    windowsHide: true,
    env: { ...process.env, TOAST_TITLE: title, TOAST_BODY: body },
  }, (err) => {
    if (err) console.error('[toast error]', err.message);
  });
}

// ---------- スキャンループ ----------

let snapshot = { scannedAt: 0, jobs: [] };
let prevStatuses = null; // 初回スキャンでは通知しない

function scan() {
  const now = Date.now();
  try {
    const jobs = [...scanClaude(now), ...scanCodex(now), ...scanExternal(now)];
    const order = { running: 0, stalled: 1, error: 2, complete: 3 };
    jobs.sort((a, b) => (order[a.status] - order[b.status]) || (b.lastActivityAt - a.lastActivityAt));

    if (TOAST && prevStatuses) {
      for (const j of jobs) {
        const prev = prevStatuses.get(j.id);
        const wasActive = prev === 'running' || prev === 'stalled';
        const finished = j.status === 'complete' || j.status === 'error';
        if ((wasActive && finished) || (TOAST_STALLED && prev === 'running' && j.status === 'stalled')) {
          notifyToast(j);
        }
      }
    }
    prevStatuses = new Map(jobs.map((j) => [j.id, j.status]));
    snapshot = { scannedAt: now, jobs };
  } catch (err) {
    console.error('[scan error]', err);
  }
}

scan();
setInterval(scan, SCAN_INTERVAL_MS);

// ---------- HTTP ----------

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function handleJobPost(req, res) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 16384) { json(res, 413, { error: 'body too large' }); req.destroy(); }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let j;
    try { j = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return json(res, 400, { error: 'body must be an object' });

    const rawId = j.id || `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const id = String(rawId).replace(/[^\w.-]/g, '_').slice(0, 100);
    const p = path.join(JOBS_DIR, `${id}.json`);
    const prev = safeReadJson(p) || {};
    const now = Date.now();
    const merged = { ...prev, ...j, id, updatedAt: now, startedAt: prev.startedAt || j.startedAt || now };
    if ((j.status === 'complete' || j.status === 'error') && !merged.completedAt) merged.completedAt = now;
    try {
      fs.mkdirSync(JOBS_DIR, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(merged, null, 2));
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
    // 反映を早める(連続 POST では 2 秒までスキャンを間引く)
    if (now - snapshot.scannedAt > 2000) scan();
    json(res, 200, { ok: true, id });
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/jobs' && req.method === 'POST') {
    handleJobPost(req, res);
  } else if (url === '/api/jobs') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot));
  } else if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('index.html not found');
    }
  } else {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Subagent Job Notifier: http://localhost:${PORT}`);
  console.log(`  window=${WINDOW_MS / 3600000}h stall=${STALL_MS / 60000}min scan=${SCAN_INTERVAL_MS / 1000}s toast=${TOAST ? 'on' : 'off'}`);
  console.log(`  watching: ${CLAUDE_PROJECTS}`);
  console.log(`  watching: ${CODEX_SESSIONS}`);
  console.log(`  watching: ${JOBS_DIR}`);
});
