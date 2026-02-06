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

// ✅ Em Railway, recomendo criar um Volume e montar em /app/data.
// Se DATA_DIR não estiver setado, usa ./data local.
const DATA_BASE = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(BASE_DIR, 'data');

// Auth dentro do data (persistente com volume)
const AUTH_BASE = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(DATA_BASE, 'auth');

const BOT_IDS = ['v1', 'v2', 'v3', 'v4', 'v5'];

// ------- event logger (global) -------
const EVENTS_FILE = path.join(DATA_BASE, 'events.json');

function ensureBaseStorage() {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.mkdirSync(AUTH_BASE, { recursive: true });

    for (const botId of BOT_IDS) {
      fs.mkdirSync(path.join(DATA_BASE, botId), { recursive: true });
      fs.mkdirSync(path.join(AUTH_BASE, botId), { recursive: true });
    }

    if (!fs.existsSync(EVENTS_FILE)) {
      fs.writeFileSync(EVENTS_FILE, '[]', 'utf8');
    }
  } catch (e) {
    console.error('[BOOT] Falha ao preparar pastas de dados:', e?.message || e);
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

// ------- bots (lazy init) -------
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
const USERS_FILE = path.join(DATA_BASE, 'users.json');
function loadUsers() { return loadJSON(USERS_FILE, {}); }
function saveUsers(u) { return saveJSON(USERS_FILE, u); }

(function ensureDefaultUsers() {
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
    console.log('[BOOT] users.json criado com usuários padrão.');
  } catch (e) {
    console.error('[BOOT] Falha ao criar users.json:', e?.message || e);
  }
})();

function getUser(req) {
  const users = loadUsers();
  const u = req.session?.user;
  if (!u) return null;
  const fresh = users[u.username];
  if (!fresh) return null;
  return { username: u.username, ...fresh };
}

function requireAuth(req, res, next) {
  const u = getUser(req);
  if (!u) return res.redirect('/login');
  req.user = u;
  next();
}

function allowedBotIds(user) {
  if (user.role === 'admin') return BOT_IDS;
  return [user.botId];
}

function getSelectedBotId(reqLike) {
  // reqLike: { user, query }
  if (!reqLike?.user) return 'v1';
  if (reqLike.user.role !== 'admin') return reqLike.user.botId;
  const q = reqLike.query?.botId;
  if (q && BOT_IDS.includes(q)) return q;
  return 'v1';
}

// -------- helpers ----------
function safeJSONParse(maybeStr, fallback) {
  try {
    if (typeof maybeStr === 'string') return JSON.parse(maybeStr);
    if (typeof maybeStr === 'object' && maybeStr) return maybeStr;
    return fallback;
  } catch {
    return fallback;
  }
}

function renderPage(req, res, { title, bodyHtml, footerHtml }) {
  // layoutMobile já tem menu completo; nós só colocamos o miolo (bodyHtml)
  res.send(layoutMobile({
    title,
    user: { name: req.user.username, role: req.user.role, username: req.user.username },
    username: req.user.username,
    role: req.user.role,
    bodyHtml,
    footerHtml
  }));
}

function pickBot(req) {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const allowed = allowedBotIds(req.user);
  return { botId, allowed, bot: getBot(botId) };
}

// ---------- app ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 14 * 24 * 60 * 60 * 1000 }
}));

app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.redirect('/m'));
app.get('/app', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));

// ------- auth -------
app.get('/login', (req, res) => {
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
      <div class="muted">Dica: admin/admin123 · v1/123 ... (mude em data/users.json)</div>
    </form>
  </div></div></body></html>`;
  res.send(html);
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const users = loadUsers();
  const u = users[username];
  if (!u || (u.pass || u.password) !== password) return res.redirect('/login');
  req.session.user = { username };
  res.redirect('/m');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ------- API -------
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    defaultBotId: (req.user.role === 'admin' ? 'v1' : req.user.botId),
    allowedBotIds: allowedBotIds(req.user)
  });
});

app.get('/api/status', requireAuth, async (req, res) => {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const st = getBot(botId).getStatus?.() || {};
  const qr = st.qr || null;
  const qrData = await qrDataUrlFn(qr);
  res.json({ botId, connected: !!st.connected, enabled: !!st.enabled, queueSize: st.queueSize ?? 0, qrDataUrl: qrData });
});

app.post('/api/toggle-connect', requireAuth, async (req, res) => {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);
  const st = b.getStatus?.() || {};
  try {
    if (st.connected) await b.disconnect?.();
    else await b.connect?.();
  } catch (e) {
    console.error('[toggle-connect]', e?.message || e);
  }
  res.json({ ok: true });
});

app.post('/api/toggle-enabled', requireAuth, (req, res) => {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);
  const st = b.getStatus?.() || {};
  try {
    b.setEnabled?.(!st.enabled);
  } catch (e) {
    console.error('[toggle-enabled]', e?.message || e);
  }
  res.json({ ok: true });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const b = getBot(botId);

  const rules = b.getConfig?.()?.rules || { minYearFollowUp: 2022 };
  const minYear = Number(rules.minYearFollowUp || 2022);

  const events = loadJSON(EVENTS_FILE, []);
  const totalSent = events.filter(e => e.botId === botId && e.action === 'auto_sent').length;

  const leads = b.getLeads?.() || {};
  let below = 0, atOrAbove = 0;
  for (const lead of Object.values(leads || {})) {
    const y = Number(lead.year || 0);
    if (!y) continue;
    if (y < minYear) below += 1;
    else atOrAbove += 1;
  }

  res.json({
    botId,
    minYearFollowUp: minYear,
    totalMessagesSent: totalSent,
    carsBelowMinYear: below,
    carsAtOrAboveMinYear: atOrAbove
  });
});

// Users admin CRUD (admin only)
app.get('/api/users', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json({ users: loadUsers() });
});

app.post('/api/users/upsert', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { username, password, botId, role } = req.body || {};
  if (!username) return res.status(400).json({ error: 'missing username' });
  if (role && !['admin', 'seller'].includes(role)) return res.status(400).json({ error: 'bad role' });
  if (botId && !BOT_IDS.includes(botId)) return res.status(400).json({ error: 'bad botId' });

  const users = loadUsers();
  const cur = users[username] || {};
  users[username] = {
    role: role || cur.role || 'seller',
    botId: (role === 'admin') ? '*' : (botId || cur.botId || 'v1'),
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.password || '123')
  };
  saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/users/delete', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'missing username' });
  const users = loadUsers();
  delete users[username];
  saveUsers(users);
  res.json({ ok: true });
});

// ------- PAGES (todas as abas do menu) -------

// Home
app.get('/m', requireAuth, async (req, res) => {
  const { botId, allowed, bot } = pickBot(req);
  const st = bot.getStatus?.() || {};
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const options = allowed.map(id =>
    `<option value="${id}" ${id === botId ? 'selected' : ''}>${id}</option>`
  ).join('');

  const bodyHtml = `
    <div class="card">
      <div class="row" style="align-items:center;justify-content:space-between">
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

      <div class="card" style="margin-top:12px">
        <div class="muted">Estatísticas (rápido)</div>
        <div id="statsBox" class="muted" style="margin-top:8px">Carregando…</div>
      </div>
    </div>

    <script>
      async function postJSON(url, body){
        await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
      }
      async function toggleConnect(botId){
        await postJSON('/api/toggle-connect',{botId});
        location.reload();
      }
      async function toggleEnabled(botId){
        await postJSON('/api/toggle-enabled',{botId});
        location.reload();
      }
      (async ()=>{
        const r = await fetch('/api/stats?botId=${encodeURIComponent(botId)}');
        const j = await r.json();
        document.getElementById('statsBox').innerHTML =
          'Mensagens auto: <b>'+ (j.totalMessagesSent ?? 0) +'</b><br>'+
          'Ano mín: <b>'+ (j.minYearFollowUp ?? '-') +'</b><br>'+
          'Abaixo: <b>'+ (j.carsBelowMinYear ?? 0) +'</b> · OK: <b>'+ (j.carsAtOrAboveMinYear ?? 0) +'</b>';
      })();
    </script>
  `;

  renderPage(req, res, { title: `Painel (${botId})`, bodyHtml });
});

// Messages / Rules (edição JSON)
app.get('/m/messages', requireAuth, (req, res) => {
  const { botId, bot } = pickBot(req);
  const cfg = bot.getConfig?.() || {};
  const bodyHtml = `
    <div class="card">
      <h3>📝 Mensagens (${htmlEscape(botId)})</h3>
      <form method="POST" action="/save">
        <input type="hidden" name="botId" value="${htmlEscape(botId)}"/>
        <label>Messages (JSON)</label>
        <textarea name="messages">${htmlEscape(JSON.stringify(cfg.messages || {}, null, 2))}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
      <div class="muted" style="margin-top:10px">Se ficar inválido, o bot usa o último válido.</div>
    </div>
  `;
  renderPage(req, res, { title: `Mensagens (${botId})`, bodyHtml });
});

app.get('/m/rules', requireAuth, (req, res) => {
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
  renderPage(req, res, { title: `Regras (${botId})`, bodyHtml });
});

// Stats page (com endpoint)
app.get('/m/stats', requireAuth, (req, res) => {
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>📊 Estatísticas (${htmlEscape(botId)})</h3>
      <div id="statsFull" class="muted">Carregando…</div>
    </div>
    <script>
      (async ()=>{
        const r = await fetch('/api/stats?botId=${encodeURIComponent(botId)}');
        const j = await r.json();
        document.getElementById('statsFull').innerHTML =
          '<b>Mensagens auto:</b> ' + (j.totalMessagesSent ?? 0) + '<br>' +
          '<b>Ano mín follow-up:</b> ' + (j.minYearFollowUp ?? '-') + '<br>' +
          '<b>Carros abaixo:</b> ' + (j.carsBelowMinYear ?? 0) + '<br>' +
          '<b>Carros OK:</b> ' + (j.carsAtOrAboveMinYear ?? 0);
      })();
    </script>
  `;
  renderPage(req, res, { title: `Estatísticas (${botId})`, bodyHtml });
});

// Leads (lista simples, não quebra se bot não tiver)
app.get('/m/leads', requireAuth, (req, res) => {
  const { botId, bot } = pickBot(req);
  const leads = bot.getLeads?.() || {};
  const rows = Object.entries(leads).slice(0, 300).map(([id, l]) => {
    const name = l.name || l.nome || '';
    const phone = l.phone || l.telefone || id;
    const year = l.year || l.ano || '';
    const score = l.score ?? l.leadScore ?? '';
    const stage = l.stage || l.funil || l.status || '';
    return `<tr>
      <td>${htmlEscape(phone)}</td>
      <td>${htmlEscape(name)}</td>
      <td>${htmlEscape(year)}</td>
      <td>${htmlEscape(stage)}</td>
      <td>${htmlEscape(score)}</td>
    </tr>`;
  }).join('');

  const bodyHtml = `
    <div class="card">
      <h3>👥 Leads (${htmlEscape(botId)})</h3>
      <div class="muted">Mostrando até 300 (para não travar).</div>
      <div style="overflow:auto;margin-top:10px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:#94a3b8;font-size:12px;text-align:left">
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Telefone</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Nome</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Ano</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Etapa</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Score</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="5" class="muted" style="padding:10px">Sem leads ou função getLeads não disponível.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: `Leads (${botId})`, bodyHtml });
});

// Agenda / Program / Commands / Dashboard / Quote (placeholders seguros)
app.get('/m/agenda', requireAuth, (req, res) => {
  const { botId, bot } = pickBot(req);
  const agenda = bot.getAgenda?.() || bot.getSchedule?.() || null;
  const bodyHtml = `
    <div class="card">
      <h3>🗓️ Agenda (${htmlEscape(botId)})</h3>
      <div class="muted">Se sua botCore tiver getAgenda/getSchedule, aparece aqui.</div>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid #1f2a44;border-radius:12px;padding:10px">${htmlEscape(JSON.stringify(agenda || {}, null, 2))}</pre>
    </div>
  `;
  renderPage(req, res, { title: `Agenda (${botId})`, bodyHtml });
});

app.get('/m/program', requireAuth, (req, res) => {
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>⏱️ Programar (${htmlEscape(botId)})</h3>
      <div class="muted">Aqui você pode colocar a UI de programação (se já tinha antes, a gente reintroduz).</div>
      <div class="muted">Me diga qual era a função exata aqui (ex: agendar follow-up, mudar status, etc.) e eu recrio igual.</div>
    </div>
  `;
  renderPage(req, res, { title: `Programar (${botId})`, bodyHtml });
});

app.get('/m/commands', requireAuth, (req, res) => {
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>⌨️ Comandos (${htmlEscape(botId)})</h3>
      <div class="muted">Exemplos (ajuste conforme sua botCore):</div>
      <pre style="white-space:pre-wrap;background:#0b1220;border:1px solid #1f2a44;border-radius:12px;padding:10px">
#okok  -> marcar como ok
#stop  -> parar automação
#follow -> voltar para funil
      </pre>
    </div>
  `;
  renderPage(req, res, { title: `Comandos (${botId})`, bodyHtml });
});

app.get('/m/dashboard', requireAuth, (req, res) => {
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>📈 Dashboard (${htmlEscape(botId)})</h3>
      <div class="muted">Se você já tinha gráficos aqui, eu consigo recolocar – mas preciso do seu server antigo ou print.</div>
      <div class="muted">Por enquanto, use “Estatísticas”.</div>
    </div>
  `;
  renderPage(req, res, { title: `Dashboard (${botId})`, bodyHtml });
});

app.get('/m/quote', requireAuth, (req, res) => {
  const { botId } = pickBot(req);
  const bodyHtml = `
    <div class="card">
      <h3>💰 Cotizar (${htmlEscape(botId)})</h3>
      <div class="muted">Se você tinha gerador de cotação aqui, manda um print/descrição e eu recrio idêntico.</div>
    </div>
  `;
  renderPage(req, res, { title: `Cotizar (${botId})`, bodyHtml });
});

// Users (admin)
app.get('/m/users', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/m');

  const users = loadUsers();
  const rows = Object.entries(users).map(([uname, u]) => `
    <tr>
      <td>${htmlEscape(uname)}</td>
      <td>${htmlEscape(u.role || '')}</td>
      <td>${htmlEscape(u.botId || '')}</td>
    </tr>
  `).join('');

  const bodyHtml = `
    <div class="card">
      <h3>👤 Usuários</h3>
      <div class="muted">CRUD completo continua via /api/users (se você quiser eu monto a tela aqui também).</div>
      <div style="overflow:auto;margin-top:10px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="color:#94a3b8;font-size:12px;text-align:left">
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Usuário</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Role</th>
              <th style="border-bottom:1px solid #1f2a44;padding:8px">Bot</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
  renderPage(req, res, { title: 'Usuários', bodyHtml });
});

// Desktop alias
app.get('/admin', requireAuth, (req, res) => res.redirect('/d'));

// Desktop (mantém)
app.get('/d', requireAuth, async (req, res) => {
  const { botId, allowed, bot } = pickBot(req);
  const st = bot.getStatus?.() || {};
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const bodyHtml = `
    <div class="card">
      <h2 style="margin:0 0 10px 0">🖥️ Desktop (${htmlEscape(botId)})</h2>
      <div class="muted">Conexão: <b>${st.connected ? 'Conectado' : 'Desconectado'}</b> · Bot: <b>${st.enabled ? 'Ativo' : 'Pausado'}</b> · Fila: <b>${st.queueSize ?? 0}</b></div>
      <div style="margin-top:12px">${qrUrl ? `<img src="${qrUrl}" style="width:260px;border-radius:14px;background:#fff;padding:8px"/>` : `<div class="muted">Sem QR</div>`}</div>
      <div class="row" style="margin-top:12px">
        <a class="btn btn-ghost" href="/m">Ir para Mobile</a>
        <a class="btn btn-ghost" href="/logout">Sair</a>
      </div>
    </div>
  `;
  res.send(layoutDesktop({ title: `Desktop (${botId})`, bodyHtml }));
});

// ------- save config (rules/messages) -------
// ✅ AGORA aceita textarea string (JSON) sem quebrar
app.post('/save', requireAuth, (req, res) => {
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const b = getBot(botId);

  const cfg = b.getConfig?.() || {};
  const rulesOld = cfg.rules || {};
  const messagesOld = cfg.messages || {};

  const rulesNew = safeJSONParse(req.body.rules, rulesOld);
  const messagesNew = safeJSONParse(req.body.messages, messagesOld);

  try {
    b.setConfig?.({ rules: rulesNew, messages: messagesNew });
  } catch (e) {
    console.error('[save]', e?.message || e);
  }

  res.redirect(req.headers.referer || '/m');
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ MultiBot rodando: http://localhost:${PORT}/m`);
});
