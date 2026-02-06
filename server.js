require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const { loadJSON, saveJSON, htmlEscape, applyTemplate } = require('./src/utils');
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

const BOT_IDS = ['v1','v2','v3','v4','v5'];

// ------- event logger (global) -------
const EVENTS_FILE = path.join(DATA_BASE, 'events.json');

// ✅ garante estrutura de pastas/arquivos antes de qualquer coisa
function ensureBaseStorage() {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.mkdirSync(AUTH_BASE, { recursive: true });

    // cria subpastas por bot (para JSONs por bot, se usados)
    for (const botId of BOT_IDS) {
      fs.mkdirSync(path.join(DATA_BASE, botId), { recursive: true });
      fs.mkdirSync(path.join(AUTH_BASE, botId), { recursive: true });
    }

    // cria events.json se não existir
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
    arr.push(evt);
    // keep last 50k to avoid huge file
    const trimmed = arr.length > 50000 ? arr.slice(arr.length - 50000) : arr;
    saveJSON(EVENTS_FILE, trimmed);
  } catch (e) {
    console.error('[EVENTS] fail:', e?.message || e);
  }
}

// ------- bots (lazy init) -------
const bots = {}; // { [botId]: botInstance }

function getBot(botId) {
  const id = BOT_IDS.includes(botId) ? botId : 'v1';
  if (!bots[id]) {
    // garante pastas também no momento da criação
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
function loadUsers(){ return loadJSON(USERS_FILE, {}); }
function saveUsers(u){ return saveJSON(USERS_FILE, u); }

// cria usuários padrão se users.json não existir (não sobrescreve)
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
    console.log('[BOOT] users.json criado com usuários padrão.');
  } catch (e) {
    console.error('[BOOT] Falha ao criar users.json:', e?.message || e);
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

function getSelectedBotId(req){
  if (req.user.role !== 'admin') return req.user.botId;
  const q = req.query.botId;
  if (q && BOT_IDS.includes(q)) return q;
  // default v1
  return 'v1';
}

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

// ------- API (modo App) -------
app.get('/api/me', requireAuth, (req,res)=>{
  res.json({
    username: req.user.username,
    role: req.user.role,
    defaultBotId: (req.user.role === 'admin' ? 'v1' : req.user.botId),
    allowedBotIds: allowedBotIds(req.user)
  });
});

app.get('/api/status', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const st = getBot(botId).getStatus();
  const qr = st.qr || null;
  const qrDataUrl = await qrDataUrlFn(qr);
  res.json({ botId, connected: st.connected, enabled: st.enabled, queueSize: st.queueSize, qrDataUrl });
});

app.post('/api/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = getBot(botId).getStatus();
  if (st.connected) await getBot(botId).disconnect(); else await getBot(botId).connect();
  res.json({ ok:true });
});

app.post('/api/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = getBot(botId).getStatus();
  getBot(botId).setEnabled(!st.enabled);
  res.json({ ok:true });
});

// Stats: total messages + car-year buckets based on "Regras.minYearFollowUp"
app.get('/api/stats', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const rules = getBot(botId).getConfig()?.rules || { minYearFollowUp: 2022 };
  const minYear = Number(rules.minYearFollowUp || 2022);

  // total auto sent from events
  const events = loadJSON(EVENTS_FILE, []);
  const totalSent = events.filter(e => e.botId === botId && e.action === 'auto_sent').length;

  // car buckets from leads (unique contacts)
  const leads = getBot(botId).getLeads();
  let below = 0, atOrAbove = 0;
  for (const lead of Object.values(leads||{})) {
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
app.get('/api/users', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).json({error:'forbidden'});
  const users = loadUsers();
  res.json({ users });
});

app.post('/api/users/upsert', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).json({error:'forbidden'});
  const { username, password, botId, role } = req.body || {};
  if (!username) return res.status(400).json({error:'missing username'});
  if (role && !['admin','seller'].includes(role)) return res.status(400).json({error:'bad role'});
  if (botId && !BOT_IDS.includes(botId)) return res.status(400).json({error:'bad botId'});
  const users = loadUsers();
  const cur = users[username] || {};
  users[username] = {
    role: role || cur.role || 'seller',
    botId: (role==='admin') ? '*' : (botId || cur.botId || 'v1'),
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.password || '123')
  };
  saveUsers(users);
  res.json({ ok:true });
});

app.post('/api/users/delete', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).json({error:'forbidden'});
  const { username } = req.body || {};
  if (!username) return res.status(400).json({error:'missing username'});
  const users = loadUsers();
  delete users[username];
  saveUsers(users);
  res.json({ ok:true });
});

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
      <div class="muted">Dica: admin/admin123 · v1/123 ... (mude em data/users.json)</div>
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

// ------- panel routes (m / d) -------
app.get('/m', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const allowed = allowedBotIds(req.user);
  const st = getBot(botId).getStatus();
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const html = layoutMobile({
    // ✅ PASAMOS user COMPLETO (para evitar crash en templates)
    user: { username: req.user.username, role: req.user.role, name: req.user.username },
    username: req.user.username,
    role: req.user.role,

    botId,
    allowedBotIds: allowed,
    status: st,
    qrDataUrl: qrUrl,
    rules: getBot(botId).getConfig()?.rules || {},
    messages: getBot(botId).getConfig()?.messages || {},
    statsEndpoint: `/api/stats?botId=${encodeURIComponent(botId)}`
  });

  res.send(html);
});

app.get('/d', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId } });
  const allowed = allowedBotIds(req.user);
  const st = getBot(botId).getStatus();
  const qr = st.qr || null;
  const qrUrl = await qrDataUrlFn(qr);

  const html = layoutDesktop({
    // ✅ PASAMOS user COMPLETO (para evitar crash en templates)
    user: { username: req.user.username, role: req.user.role, name: req.user.username },
    username: req.user.username,
    role: req.user.role,

    botId,
    allowedBotIds: allowed,
    status: st,
    qrDataUrl: qrUrl,
    rules: getBot(botId).getConfig()?.rules || {},
    messages: getBot(botId).getConfig()?.messages || {},
    statsEndpoint: `/api/stats?botId=${encodeURIComponent(botId)}`
  });

  res.send(html);
});

// ------- config save (rules/messages) -------
app.post('/save', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });

  const cfg = getBot(botId).getConfig() || {};
  const rules = cfg.rules || {};
  const messages = cfg.messages || {};

  // merge rules/messages from form
  Object.assign(rules, req.body.rules || {});
  Object.assign(messages, req.body.messages || {});

  getBot(botId).setConfig({ rules, messages });

  res.redirect(req.headers.referer || '/m');
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`✅ MultiBot rodando: http://localhost:${PORT}/m`);
});
