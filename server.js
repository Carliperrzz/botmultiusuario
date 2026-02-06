require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const { loadJSON, saveJSON, htmlEscape } = require('./src/utils');
const { createBot } = require('./src/botCore');
const { qrDataUrl, layoutMobile, layoutDesktop } = require('./src/panelTemplates');

const qrDataUrlFn = async (qr) => (qr ? qrDataUrl(qr) : null);

// Base do projeto (Railway usa /app)
const BASE_DIR = __dirname;

const DATA_BASE = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(BASE_DIR, 'data');

const AUTH_BASE = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(DATA_BASE, 'auth');

const BOT_IDS = ['v1', 'v2', 'v3', 'v4', 'v5'];

// ------- storage -------
const EVENTS_FILE = path.join(DATA_BASE, 'events.json');
const USERS_FILE = path.join(DATA_BASE, 'users.json');
const SCHEDULES_FILE = path.join(DATA_BASE, 'schedules.json');

function ensureBaseStorage() {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.mkdirSync(AUTH_BASE, { recursive: true });

    for (const botId of BOT_IDS) {
      fs.mkdirSync(path.join(DATA_BASE, botId), { recursive: true });
      fs.mkdirSync(path.join(AUTH_BASE, botId), { recursive: true });
    }

    if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '[]', 'utf8');
    if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]', 'utf8');
  } catch (e) {
    console.error('[BOOT] Falha ao preparar pastas:', e?.message || e);
  }
}
ensureBaseStorage();

function appendEvent(evt) {
  try {
    const arr = loadJSON(EVENTS_FILE, []);
    arr.push({ ...evt, ts: evt.ts || new Date().toISOString() });
    const trimmed = arr.length > 50000 ? arr.slice(arr.length - 50000) : arr;
    saveJSON(EVENTS_FILE, trimmed);
  } catch (e) {
    console.error('[EVENTS] fail:', e?.message || e);
  }
}

// ------- bots (lazy) -------
const bots = {};
function getBot(botId) {
  const id = BOT_IDS.includes(botId) ? botId : 'v1';
  if (!bots[id]) {
    try {
      fs.mkdirSync(path.join(AUTH_BASE, id), { recursive: true });
      fs.mkdirSync(path.join(DATA_BASE, id), { recursive: true });
    } catch (_) {}
    bots[id] = createBot({
      botId: id,
      baseDir: BASE_DIR,
      authDir: path.join(AUTH_BASE, id),
      eventLogger: appendEvent
    });
  }
  return bots[id];
}

// ------- users -------
function loadUsers(){ return loadJSON(USERS_FILE, {}); }
function saveUsers(u){ return saveJSON(USERS_FILE, u); }

(function ensureDefaultUsers(){
  try {
    if (fs.existsSync(USERS_FILE)) return;
    const seed = {
      admin: { role: 'admin', botId: '*', pass: 'admin123' },
      v1: { role: 'seller', botId: 'v1', pass: '123' },
      v2: { role: 'seller', botId: 'v2', pass: '123' },
      v3: { role: 'seller', botId: 'v3', pass: '123' },
      v4: { role: 'seller', botId: 'v4', pass: '123' },
      v5: { role: 'seller', botId: 'v5', pass: '123' },
    };
    saveJSON(USERS_FILE, seed);
    console.log('[BOOT] users.json criado (seed).');
  } catch (e) {
    console.error('[BOOT] seed users fail:', e?.message || e);
  }
})();

function getUser(req){
  const users = loadUsers();
  const u = req.session?.user;
  if (!u) return null;
  const fresh = users[u.username];
  if (!fresh) return null;
  return { username: u.username, ...fresh };
}

function requireAuth(req,res,next){
  const u = getUser(req);
  if (!u) return res.redirect('/login');
  req.user = u;
  next();
}

function allowedBotIds(user){
  if (user.role === 'admin') return BOT_IDS;
  return [user.botId];
}

function getSelectedBotId(reqLike){
  if (!reqLike?.user) return 'v1';
  if (reqLike.user.role !== 'admin') return reqLike.user.botId;
  const q = reqLike.query?.botId;
  if (q && BOT_IDS.includes(q)) return q;
  return 'v1';
}

function pickBot(req){
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const allowed = allowedBotIds(req.user);
  return { botId, allowed, bot: getBot(botId) };
}

// ------- scheduler (persistente) -------
function loadSchedules() { return loadJSON(SCHEDULES_FILE, []); }
function saveSchedules(arr) { return saveJSON(SCHEDULES_FILE, arr); }

function newId() {
  return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
}

function brPhoneToJid(phone) {
  // acepta: 5511999999999 / 11 99999-9999 / +55...
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  // Si no tiene 55, asumimos Brasil
  const full = digits.startsWith('55') ? digits : ('55' + digits);
  return full + '@s.whatsapp.net';
}

// 🔥 Intento de envío: auto-detect de métodos del botCore
async function sendTextWithBot(bot, toJid, text) {
  if (!bot || !toJid || !text) throw new Error('missing params');

  // posibles nombres (depende tu botCore)
  const candidates = [
    'sendText',
    'sendMessage',
    'send',
    'enqueueMessage',
    'queueMessage',
    'sendOut',
  ];

  for (const fn of candidates) {
    if (typeof bot[fn] === 'function') {
      // casos más comunes:
      // - sendText(jid, text)
      // - sendMessage(jid, {text})
      // - enqueueMessage({to, text})
      try {
        if (fn === 'sendMessage') return await bot[fn](toJid, { text });
        if (fn === 'enqueueMessage' || fn === 'queueMessage') return await bot[fn]({ to: toJid, text });
        return await bot[fn](toJid, text);
      } catch (e) {
        // probamos siguiente
      }
    }
  }

  // último intento: si bot tiene sock (Baileys)
  if (bot.sock && typeof bot.sock.sendMessage === 'function') {
    return await bot.sock.sendMessage(toJid, { text });
  }

  throw new Error('BotCore sem método de envio detectado (sendText/sendMessage/enqueueMessage)');
}

// corre cada 10s
async function schedulerTick() {
  const now = Date.now();
  const arr = loadSchedules();
  let changed = false;

  for (const job of arr) {
    if (job.status !== 'pending') continue;
    if (!job.runAt) continue;
    if (Number(job.runAt) > now) continue;

    // ejecutar
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    changed = true;
    saveSchedules(arr);

    try {
      const bot = getBot(job.botId || 'v1');
      const st = bot.getStatus?.() || {};
      if (!st.connected) throw new Error('bot desconectado');
      if (!st.enabled) throw new Error('bot pausado');

      const jid = brPhoneToJid(job.phone);
      if (!jid) throw new Error('telefone inválido');

      await sendTextWithBot(bot, jid, job.text);

      job.status = 'done';
      job.doneAt = new Date().toISOString();
      appendEvent({ botId: job.botId, action: 'scheduled_sent', phone: job.phone, jobId: job.id });
    } catch (e) {
      job.status = 'error';
      job.error = String(e?.message || e);
      job.failedAt = new Date().toISOString();
      appendEvent({ botId: job.botId, action: 'scheduled_error', phone: job.phone, jobId: job.id, error: job.error });
    } finally {
      changed = true;
      saveSchedules(arr);
    }
  }

  if (changed) saveSchedules(arr);
}

setInterval(() => {
  schedulerTick().catch((e) => console.error('[schedulerTick]', e?.message || e));
}, 10000);

// ---------- app ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 14 * 24 * 60 * 60 * 1000 }
}));

app.get('/health', (req,res)=>res.status(200).send('ok'));
app.get('/', (req,res)=>res.redirect('/m'));
app.get('/app', requireAuth, (req,res)=>res.sendFile(path.join(__dirname,'public','app','index.html')));

// ------- auth -------
app.get('/login', (req,res)=>{
  const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Login</title>
  <style>
    body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
    .wrap{max-width:420px;margin:0 auto;padding:26px 14px}
    .card{background:#0f172a;border:1px solid #1f2a44;border-radius:16px;padding:16px}
    h1{margin:0 0 10px 0;font-size:18px}
    label{display:block;margin:10px 0 6px;color:#94a3b8;font-size:12px}
    input{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #1f2a44;border-radius:12px;padding:12px}
    button{width:100%;margin-top:12px;background:#facc15;color:#111827;border:none;border-radius:14px;padding:12px 14px;font-weight:700}
    .muted{color:#94a3b8;font-size:12px;margin-top:10px}
  </style></head><body>
  <div class="wrap"><div class="card">
    <h1>🔐 Login · Iron Glass MultiBot</h1>
    <form method="POST" action="/login">
      <label>Usuário</label><input name="username" placeholder="admin / v1 / v2 ..." required/>
      <label>Senha</label><input name="password" type="password" required/>
      <button type="submit">Entrar</button>
      <div class="muted">Dica: admin/admin123 · v1/123 ...</div>
    </form>
  </div></div></body></html>`;
  res.send(html);
});

app.post('/login', (req,res)=>{
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const users = loadUsers();
  const u = users[username];
  if (!u || (u.pass || u.password) !== password) return res.redirect('/login');
  req.session.user = { username };
  res.redirect('/m');
});

app.get('/logout', (req,res)=>{
  req.session.destroy(()=>res.redirect('/login'));
});

// ------- API base -------
app.get('/api/status', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const st = getBot(botId).getStatus?.() || {};
  const qr = st.qr || null;
  const qrData = await qrDataUrlFn(qr);
  res.json({ botId, connected: !!st.connected, enabled: !!st.enabled, queueSize: st.queueSize ?? 0, qrDataUrl: qrData });
});

app.post('/api/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);
  const st = b.getStatus?.() || {};
  try {
    if (st.connected) await b.disconnect?.();
    else await b.connect?.();
  } catch (e) {
    console.error('[toggle-connect]', e?.message || e);
  }
  res.json({ ok:true });
});

app.post('/api/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);
  const st = b.getStatus?.() || {};
  try { b.setEnabled?.(!st.enabled); } catch(e) {}
  res.json({ ok:true });
});

// ------- SCHEDULER API -------
app.get('/api/schedules', requireAuth, (req,res)=>{
  const arr = loadSchedules();
  // admin ve todo; seller ve su bot
  const allowed = allowedBotIds(req.user);
  const out = (req.user.role === 'admin')
    ? arr
    : arr.filter(j => allowed.includes(j.botId));
  res.json({ jobs: out.sort((a,b)=>Number(b.runAt||0)-Number(a.runAt||0)) });
});

app.post('/api/schedules/add', requireAuth, (req,res)=>{
  const { botId, phone, text, runAt } = req.body || {};
  const selected = getSelectedBotId({ user: req.user, query: { botId } });
  const allowed = allowedBotIds(req.user);
  if (req.user.role !== 'admin' && !allowed.includes(selected)) return res.status(403).json({ error:'forbidden' });

  const ts = Number(runAt);
  if (!ts || !phone || !text) return res.status(400).json({ error:'missing fields' });

  const arr = loadSchedules();
  const job = {
    id: newId(),
    type: 'send_text',
    botId: selected,
    phone: String(phone),
    text: String(text),
    runAt: ts,
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy: req.user.username
  };
  arr.push(job);
  saveSchedules(arr);
  appendEvent({ botId: selected, action: 'scheduled_created', phone: job.phone, jobId: job.id });
  res.json({ ok:true, job });
});

app.post('/api/schedules/delete', requireAuth, (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error:'missing id' });

  const arr = loadSchedules();
  const job = arr.find(j => j.id === id);
  if (!job) return res.json({ ok:true });

  const allowed = allowedBotIds(req.user);
  if (req.user.role !== 'admin' && !allowed.includes(job.botId)) return res.status(403).json({ error:'forbidden' });

  const next = arr.filter(j => j.id !== id);
  saveSchedules(next);
  appendEvent({ botId: job.botId, action: 'scheduled_deleted', phone: job.phone, jobId: job.id });
  res.json({ ok:true });
});

// ------- PAGES -------
function renderPage(req,res,{ title, bodyHtml, footerHtml }){
  res.send(layoutMobile({
    title,
    user: { name: req.user.username, role: req.user.role, username: req.user.username },
    username: req.user.username,
    role: req.user.role,
    bodyHtml,
    footerHtml
  }));
}

// Home /m
app.get('/m', requireAuth, async (req,res)=>{
  const { botId, allowed, bot } = pickBot(req);
  const st = bot.getStatus?.() || {};
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const options = allowed.map(id =>
    `<option value="${id}" ${id===botId?'selected':''}>${id}</option>`
  ).join('');

  const bodyHtml = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div class="row" style="align-items:center">
          <div class="muted">Bot</div>
          <select onchange="location.href='/m?botId='+this.value">${options}</select>
        </div>
        <div class="row">
          <button class="btn btn-ghost" onclick="toggleConnect('${botId}')">Conectar/Desconectar</button>
          <button class="btn btn-primary" onclick="toggleEnabled('${botId}')">Ativar/Pausar</button>
        </div>
      </div>

      <div class="muted" style="margin-top:10px">
        Conexão: <b>${st.connected ? 'Conectado' : 'Desconectado'}</b> ·
        Bot: <b>${st.enabled ? 'Ativo' : 'Pausado'}</b> ·
        Fila: <b>${st.queueSize ?? 0}</b>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="muted">QR Code</div>
        <div class="qr" style="margin-top:10px">
          ${qrUrl ? `<img src="${qrUrl}" alt="QR"/>` : `<div class="muted">Sem QR agora.</div>`}
        </div>
      </div>
    </div>

    <script>
      async function postJSON(url, body){
        await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
      }
      async function toggleConnect(botId){ await postJSON('/api/toggle-connect',{botId}); location.reload(); }
      async function toggleEnabled(botId){ await postJSON('/api/toggle-enabled',{botId}); location.reload(); }
    </script>
  `;
  renderPage(req,res,{ title:`Painel (${botId})`, bodyHtml });
});

// ✅ Programar mensagem (UI REAL)
app.get('/m/program', requireAuth, (req,res)=>{
  const { botId, allowed } = pickBot(req);
  const botOptions = allowed.map(id => `<option value="${id}" ${id===botId?'selected':''}>${id}</option>`).join('');

  const bodyHtml = `
  <div class="card">
    <h3>⏱️ Programar Mensagem</h3>
    <div class="muted">Agenda um envio automático (fica salvo no data/schedules.json).</div>

    <label>Bot</label>
    <select id="botIdSel">${botOptions}</select>

    <label>Telefone (com DDD)</label>
    <input id="phone" placeholder="11 99999-9999" />

    <label>Data e hora (Brasil)</label>
    <input id="when" type="datetime-local"/>

    <label>Mensagem</label>
    <textarea id="text" placeholder="Oi! ..."></textarea>

    <div class="row" style="margin-top:10px">
      <button class="btn btn-primary" onclick="addJob()">Agendar</button>
      <button class="btn btn-ghost" onclick="loadJobs()">Atualizar lista</button>
    </div>
  </div>

  <div class="card">
    <h3>📋 Programados</h3>
    <div id="jobs" class="muted">Carregando…</div>
  </div>

  <script>
    function toTs(dtLocal){
      // dtLocal "YYYY-MM-DDTHH:MM"
      if(!dtLocal) return null;
      const d = new Date(dtLocal);
      const ts = d.getTime();
      return Number.isFinite(ts) ? ts : null;
    }

    async function postJSON(url, body){
      const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
      return r.json().catch(()=>({}));
    }

    async function loadJobs(){
      const r = await fetch('/api/schedules');
      const j = await r.json();
      const rows = (j.jobs||[]).slice(0,200).map(x=>{
        const dt = x.runAt ? new Date(Number(x.runAt)).toLocaleString('pt-BR') : '-';
        const st = x.status || '-';
        const err = x.error ? (' · erro: ' + x.error) : '';
        return \`
          <div style="border-top:1px solid #1f2a44;padding:10px 0">
            <div><b>\${dt}</b> · <span class="muted">bot</span> <b>\${x.botId}</b> · <span class="muted">fone</span> <b>\${x.phone}</b></div>
            <div class="muted">status: <b>\${st}</b>\${err}</div>
            <div style="margin-top:6px;white-space:pre-wrap">\${(x.text||'').replace(/</g,'&lt;')}</div>
            <div style="margin-top:8px">
              <button class="btn btn-danger" onclick="delJob('\${x.id}')">Apagar</button>
            </div>
          </div>
        \`;
      }).join('');
      document.getElementById('jobs').innerHTML = rows || '<div class="muted">Nenhum agendamento.</div>';
    }

    async function addJob(){
      const botId = document.getElementById('botIdSel').value;
      const phone = document.getElementById('phone').value;
      const text = document.getElementById('text').value;
      const when = document.getElementById('when').value;
      const runAt = toTs(when);
      const out = await postJSON('/api/schedules/add',{ botId, phone, text, runAt });
      if(out && out.error) alert(out.error);
      document.getElementById('text').value = '';
      await loadJobs();
    }

    async function delJob(id){
      await postJSON('/api/schedules/delete',{ id });
      await loadJobs();
    }

    loadJobs();
  </script>
  `;

  renderPage(req,res,{ title:`Programar (${botId})`, bodyHtml });
});

// ✅ Agenda = vista del scheduler (misma lista, otra pestaña)
app.get('/m/agenda', requireAuth, (req,res)=>{
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>🗓️ Agenda</h3>
      <div class="muted">Aqui você vê tudo que está pendente / executando / concluído.</div>
      <div style="margin-top:10px">
        <a class="btn btn-primary" href="/m/program">Ir para Programar Mensagem</a>
      </div>
    </div>
    <div class="card">
      <h3>📋 Lista</h3>
      <div id="jobs" class="muted">Carregando…</div>
    </div>
    <script>
      async function postJSON(url, body){
        const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
        return r.json().catch(()=>({}));
      }
      async function loadJobs(){
        const r = await fetch('/api/schedules');
        const j = await r.json();
        const rows = (j.jobs||[]).slice(0,300).map(x=>{
          const dt = x.runAt ? new Date(Number(x.runAt)).toLocaleString('pt-BR') : '-';
          const st = x.status || '-';
          const err = x.error ? (' · erro: ' + x.error) : '';
          return \`
            <div style="border-top:1px solid #1f2a44;padding:10px 0">
              <div><b>\${dt}</b> · <span class="muted">bot</span> <b>\${x.botId}</b> · <span class="muted">fone</span> <b>\${x.phone}</b></div>
              <div class="muted">status: <b>\${st}</b>\${err}</div>
              <div style="margin-top:6px;white-space:pre-wrap">\${(x.text||'').replace(/</g,'&lt;')}</div>
              <div style="margin-top:8px">
                <button class="btn btn-danger" onclick="delJob('\${x.id}')">Apagar</button>
              </div>
            </div>
          \`;
        }).join('');
        document.getElementById('jobs').innerHTML = rows || '<div class="muted">Nenhum agendamento.</div>';
      }
      async function delJob(id){
        await postJSON('/api/schedules/delete',{ id });
        await loadJobs();
      }
      loadJobs();
      setInterval(loadJobs, 15000);
    </script>
  `;
  renderPage(req,res,{ title:`Agenda (${botId})`, bodyHtml });
});

// Mantengo otras páginas como estaban (para que no rompa)
app.get('/m/messages', requireAuth, (req,res)=>{
  const { botId, bot } = pickBot(req);
  const cfg = bot.getConfig?.() || {};
  const bodyHtml = `
    <div class="card">
      <h3>📝 Mensagens (${htmlEscape(botId)})</h3>
      <div class="muted">Aqui continua a edição JSON (seu botCore usa isso).</div>
      <form method="POST" action="/save">
        <input type="hidden" name="botId" value="${htmlEscape(botId)}"/>
        <label>Messages (JSON)</label>
        <textarea name="messages">${htmlEscape(JSON.stringify(cfg.messages || {}, null, 2))}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>
  `;
  renderPage(req,res,{ title:`Mensagens (${botId})`, bodyHtml });
});

app.get('/m/leads', requireAuth, (req,res)=>{
  const { botId, bot } = pickBot(req);
  const leads = bot.getLeads?.() || {};
  const rows = Object.entries(leads).slice(0,300).map(([id,l])=>{
    const name = l.name || l.nome || '';
    const phone = l.phone || l.telefone || id;
    const year = l.year || l.ano || '';
    const stage = l.stage || l.funil || l.status || '';
    return `<tr>
      <td style="border-bottom:1px solid #1f2a44;padding:8px">${htmlEscape(phone)}</td>
      <td style="border-bottom:1px solid #1f2a44;padding:8px">${htmlEscape(name)}</td>
      <td style="border-bottom:1px solid #1f2a44;padding:8px">${htmlEscape(year)}</td>
      <td style="border-bottom:1px solid #1f2a44;padding:8px">${htmlEscape(stage)}</td>
    </tr>`;
  }).join('');
  const bodyHtml = `
    <div class="card">
      <h3>👥 Leads (${htmlEscape(botId)})</h3>
      <div style="overflow:auto;margin-top:10px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:#94a3b8;font-size:12px;text-align:left">
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Telefone</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Nome</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Ano</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Etapa</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="4" class="muted" style="padding:10px">Sem leads (ou getLeads não existe).</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
  renderPage(req,res,{ title:`Leads (${botId})`, bodyHtml });
});

app.get('/m/rules', requireAuth, (req,res)=>{
  const { botId, bot } = pickBot(req);
  const cfg = bot.getConfig?.() || {};
  const bodyHtml = `
    <div class="card">
      <h3>⚙️ Regras (${htmlEscape(botId)})</h3>
      <form method="POST" action="/save">
        <input type="hidden" name="botId" value="${htmlEscape(botId)}"/>
        <label>Rules (JSON)</label>
        <textarea name="rules">${htmlEscape(JSON.stringify(cfg.rules || {}, null, 2))}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>
  `;
  renderPage(req,res,{ title:`Regras (${botId})`, bodyHtml });
});

function safeJSONParse(maybeStr, fallback){
  try{
    if (typeof maybeStr === 'string') return JSON.parse(maybeStr);
    if (typeof maybeStr === 'object' && maybeStr) return maybeStr;
    return fallback;
  }catch{ return fallback; }
}

app.post('/save', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);

  const cfg = b.getConfig?.() || {};
  const rulesOld = cfg.rules || {};
  const messagesOld = cfg.messages || {};

  const rulesNew = safeJSONParse(req.body.rules, rulesOld);
  const messagesNew = safeJSONParse(req.body.messages, messagesOld);

  try { b.setConfig?.({ rules: rulesNew, messages: messagesNew }); } catch(e) {}

  res.redirect(req.headers.referer || '/m');
});

// Desktop
app.get('/d', requireAuth, async (req,res)=>{
  const { botId, bot } = pickBot(req);
  const st = bot.getStatus?.() || {};
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const bodyHtml = `
    <div class="card">
      <h2 style="margin:0 0 10px 0">🖥️ Desktop (${htmlEscape(botId)})</h2>
      <div class="muted">Conexão: <b>${st.connected ? 'Conectado' : 'Desconectado'}</b> · Bot: <b>${st.enabled ? 'Ativo' : 'Pausado'}</b></div>
      <div style="margin-top:12px">${qrUrl ? `<img src="${qrUrl}" style="width:260px;border-radius:14px;background:#fff;padding:8px"/>` : `<div class="muted">Sem QR</div>`}</div>
      <div class="row" style="margin-top:12px">
        <a class="btn btn-ghost" href="/m">Ir para Mobile</a>
        <a class="btn btn-ghost" href="/logout">Sair</a>
      </div>
    </div>
  `;
  res.send(layoutDesktop({ title:`Desktop (${botId})`, bodyHtml }));
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`✅ MultiBot rodando: http://localhost:${PORT}/m`);
});
