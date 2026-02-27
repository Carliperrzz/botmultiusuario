require('dotenv').config();


function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

function safeRequire(candidates) {
  let lastErr = null;
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      // Solo ignorar si el módulo que falta es EXACTAMENTE el candidato probado
      if (e && e.code === 'MODULE_NOT_FOUND') {
        const msg = String(e.message || '');
        if (msg.includes(`Cannot find module '${c}'`) || msg.includes(`Cannot find module "${c}"`)) {
          lastErr = e;
          continue;
        }
      }
      throw e;
    }
  }
  throw lastErr || new Error(`Cannot load any of: ${candidates.join(', ')}`);
}

// ✅ Railway/Linux es case-sensitive: probamos variaciones comunes de nombres
const utilsMod = safeRequire(['./src/utils', './src/Utils', './src/utils/index']);
const botCoreMod = safeRequire(['./src/botCore', './src/botcore', './src/BotCore']);
const panelMod  = safeRequire(['./src/panelTemplates', './src/paneltemplates', './src/PanelTemplates']);

const { loadJSON, saveJSON, htmlEscape, applyTemplate } = utilsMod;
const { createBot } = botCoreMod;
const { qrDataUrl, layoutMobile, layoutDesktop } = panelMod;

const qrDataUrlFn = async (qr) => (qr ? qrDataUrl(qr) : null);
const BASE_DIR = __dirname;
const DATA_BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(BASE_DIR, 'data');
const AUTH_BASE = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(DATA_BASE, 'auth');

const BOT_IDS = ['v1','v2','v3','v4','v5'];

// ✅ garante estrutura de pastas/arquivos (Railway + Volume)
function ensureBaseStorage() {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.mkdirSync(AUTH_BASE, { recursive: true });
    for (const botId of BOT_IDS) {
      fs.mkdirSync(path.join(DATA_BASE, botId), { recursive: true });
      fs.mkdirSync(path.join(AUTH_BASE, botId), { recursive: true });
    }
    const eventsFile = path.join(DATA_BASE, 'events.json');
    if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, '[]', 'utf8');
    const usersFile = path.join(DATA_BASE, 'users.json');
    if (!fs.existsSync(usersFile)) {
      const seed = {
        admin: { role: 'admin', botId: '*', pass: 'admin123' },
        v1: { role: 'seller', botId: 'v1', pass: '123' },
        v2: { role: 'seller', botId: 'v2', pass: '123' },
        v3: { role: 'seller', botId: 'v3', pass: '123' },
        v4: { role: 'seller', botId: 'v4', pass: '123' },
        v5: { role: 'seller', botId: 'v5', pass: '123' },
      };
      fs.writeFileSync(usersFile, JSON.stringify(seed, null, 2), 'utf8');
      console.log('[BOOT] users.json criado (seed).');
    }
  } catch (e) {
    console.error('[BOOT] storage fail:', e?.message || e);
  }
}
ensureBaseStorage();

// ------- event logger (global) -------
const EVENTS_FILE = path.join(DATA_BASE, 'events.json');
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

// ------- bots -------
const bots = {};
for (const botId of BOT_IDS) {
  bots[botId] = createBot({
    botId,
    baseDir: BASE_DIR,
    authDir: path.join(AUTH_BASE, botId),
    eventLogger: appendEvent
  });
}

// ------- QR automático al desconectar -------
// Si querés desactivar este comportamiento, poné AUTO_NEW_QR_ON_DISCONNECT=false en .env
const AUTO_NEW_QR_ON_DISCONNECT = String(process.env.AUTO_NEW_QR_ON_DISCONNECT ?? 'true').toLowerCase() === 'true';

async function forceNewQr(botId) {
  const id = normBotId(botId);

  // cooldown para evitar rate-limit de WhatsApp (por bot)
  global.__qrResetCooldown = global.__qrResetCooldown || {};
  const now = Date.now();
  const cooldownMs = Number(process.env.RESET_COOLDOWN_MS || 15000);
  const last = global.__qrResetCooldown[id] || 0;
  if (now - last < cooldownMs) {
    console.log(`[FORCE-QR] ${id} ignorado por cooldown (${cooldownMs}ms)`);
    return;
  }
  global.__qrResetCooldown[id] = now;

  // 1) corta la conexión actual (si existe)
  try { await bots[id].disconnect(); } catch (e) {}

  // 2) espera corta para evitar carreras con saveCreds/cierre de ws
  await sleep(1200);

  // 3) borra credenciales (si no borrás esto, NO hay QR nuevo)
  const dir = path.join(AUTH_BASE, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  await sleep(200);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // 4) espera mínima y conecta de nuevo -> Baileys debe emitir QR
  await sleep(600);
  try { await bots[id].connect(); } catch (e) {
    console.error('[FORCE-QR] connect fail:', e?.message || e);
    throw e;
  }
}

// ------- users -------
const USERS_FILE = path.join(DATA_BASE, 'users.json');
function loadUsers(){ return loadJSON(USERS_FILE, {}); }
function saveUsers(u){ return saveJSON(USERS_FILE, u); }

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
  return [normBotId(user.botId)];
}

function normBotId(x){
  return String(x || '').trim().toLowerCase();
}

function getSelectedBotId(req){
  // req puede ser Express req o un objeto {user, query, body}
  const user = req?.user || {};
  const query = req?.query || {};
  const body = req?.body || {};
  if (user.role !== 'admin') return normBotId(user.botId);

  const q = normBotId(query.botId ?? body.botId);
  if (q && BOT_IDS.includes(q)) return q;

  return 'v1';
}

// Helpers
function normalizePhone(raw){
  const digits = String(raw || '').replace(/\D/g,'');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : ('55' + digits);
}
function jidToPhone(jid){
  const j = String(jid || '').trim();
  if (!j) return '';
  return j.replace('@s.whatsapp.net','').replace(/\D/g,'');
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
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId }, body: req.body });
  const st = bots[botId].getStatus();
  const qr = st.qr || null;
  const qrDataUrl = await qrDataUrlFn(qr);
  res.set('Cache-Control','no-store');
  res.json({ botId, connected: st.connected, enabled: st.enabled, queueSize: st.queueSize, qrDataUrl, lastError: st.lastError || null });
});

app.post('/api/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = bots[botId].getStatus();

  // ✅ Al "desconectar" desde el panel, forzamos un QR NUEVO automáticamente
  // (borra authDir/<botId> y reconecta).
  if (st.connected) {
    if (AUTO_NEW_QR_ON_DISCONNECT) {
      await forceNewQr(botId);
    } else {
      await bots[botId].disconnect();
    }
  } else {
    await bots[botId].connect();
  }

  res.json({ ok:true });
});

app.post('/api/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = bots[botId].getStatus();
  bots[botId].setEnabled(!st.enabled);
  res.json({ ok:true });
});

// Stats: total messages + car-year buckets based on "Regras.minYearFollowUp"
app.get('/api/stats', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId }, body: req.body });
  const rules = bots[botId].getConfig()?.rules || { minYearFollowUp: 2022 };
  const minYear = Number(rules.minYearFollowUp || 2022);

  // total auto sent from events
  const events = loadJSON(EVENTS_FILE, []);
  const totalSent = events.filter(e => e.botId === botId && e.action === 'auto_sent').length;

  // car buckets from leads (unique contacts)
  const leads = bots[botId].getLeads();
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
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.pass || cur.password || '123')
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
    input{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #1f2a44;border-radius:12px;padding:10px 12px;font-size:14px}
    button{width:100%;margin-top:12px;background:#facc15;color:#111827;border:none;border-radius:14px;padding:12px 14px;font-weight:800;font-size:14px;cursor:pointer}
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
  if (!u) return res.redirect('/login');
  const stored = (u.pass ?? u.password);
  if (stored !== password) return res.redirect('/login');
  req.session.user = { username };
  res.redirect('/m');
});

app.get('/logout', (req,res)=>{
  req.session.destroy(()=>res.redirect('/login'));
});

// ------- mobile panel -------
app.get('/m', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  const bot = bots[botId];
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');

  const status = bot.getStatus();
  const qrUrl = await qrDataUrl(status.qr);

  const body = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:800">Bot: ${htmlEscape(botId.toUpperCase())}</div>
          <div class="muted">Conectado: <b>${status.connected ? 'SIM ✅' : 'NÃO ❌'}</b> · Funil ativo: <b>${status.enabled ? 'SIM' : 'NÃO'}</b> · Fila: <b>${status.queueSize}</b></div>
        </div>
        ${req.user.role === 'admin' ? `
        <form method="GET" action="/m" style="min-width:140px">
          <label>Ver bot</label>
          <select name="botId" onchange="this.form.submit()">
            ${BOT_IDS.map(id=>`<option value="${id}" ${id===botId?'selected':''}>${id.toUpperCase()}</option>`).join('')}
          </select>
        </form>` : ``}
      </div>
      <div class="row" style="margin-top:10px">
        <form method="POST" action="/m/toggle-connect${req.user.role==='admin'?`?botId=${botId}`:''}">
          <button class="btn ${status.connected ? 'btn-danger':'btn-primary'}" type="submit">${status.connected ? 'Desconectar' : 'Conectar (gerar QR)'}</button>
        </form>
        <form method="POST" action="/m/toggle-enabled${req.user.role==='admin'?`?botId=${botId}`:''}">
          <button class="btn ${status.enabled ? 'btn-ghost':'btn-ok'}" type="submit">${status.enabled ? '⏸️ Pausar funil/envios' : '▶️ Ativar funil/envios'}</button>
        </form>
      </div>
      ${status.connected ? '' : (qrUrl ? `<div class="qr" style="margin-top:12px"><img src="${qrUrl}"/></div>
      <div class="muted" style="margin-top:8px;text-align:center">WhatsApp → Dispositivos conectados → Conectar</div>` :
      `<div class="muted" style="margin-top:12px">Clique em “Conectar” para gerar QR.</div>`)}
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Ações rápidas</div>
      <div class="muted">Use para controlar contatos sem precisar digitar comandos no WhatsApp.</div>
      <form method="POST" action="/m/action${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>
        <div class="grid2">
          <div>
            <label>Ação</label>
            <select name="action">
              <option value="pause72">Pausar 72h</option>
              <option value="remove">Sacar do funil</option>
              <option value="botOff24">Bot OFF 24h</option>
              <option value="block">Bloquear definitivo</option>
              <option value="markClient">Marcar como cliente (pós-venda)</option>
            </select>
          </div>
          <div>
            <label>Motivo (opcional)</label>
            <input name="reason" placeholder="ex: pediu para parar"/>
          </div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Executar</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Painel', user:req.user, bodyHtml: body }));
});

app.post('/m/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const st = bot.getStatus();
  if (st.connected) {
  if (AUTO_NEW_QR_ON_DISCONNECT) await forceNewQr(botId);
  else await bot.disconnect();
} else {
  await bot.connect();
}
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

app.post('/m/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const st = bot.getStatus();
  bot.setEnabled(!st.enabled);
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

/**
 * ✅ FIX PERMANENTE:
 * Agora aceita:
 * - req.body.phone  (como no painel principal)
 * - req.body.jid    (como no botão dentro do Lead)
 */
app.post('/m/action', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  // Pode vir phone OU jid
  const jidFromBody = (req.body.jid || '').trim();
  const phoneFromJid = normalizePhone(jidToPhone(jidFromBody));

  const phoneRaw = (req.body.phone || '').replace(/\D/g,'');
  const phoneFromPhone = normalizePhone(phoneRaw);

  const phone = phoneFromJid || phoneFromPhone;
  if (!phone) return res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);

  const jid = phone + '@s.whatsapp.net';
  const action = req.body.action;
  const reason = req.body.reason || '';

  if (action === 'pause72') bot.pauseFollowUp(jid, 72*60*60*1000);
  if (action === 'remove') bot.stopFollowUp(jid);
  if (action === 'botOff24') bot.setManualOff(jid, 24*60*60*1000);
  if (action === 'block') bot.blockFollowUp(jid, phone, reason || 'manual_panel');
  if (action === 'markClient') bot.markAsClient(jid);

  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'panel_action', panelUser:req.user.username, target: phone, kind: action, reason });
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- messages -------
app.get('/m/messages', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const m = snap.messagesConfig || {};

  const fields = ['step0','step1','step2','step3','extra','postSale30','agenda0','agenda1','agenda2','confirmTemplate'];

  const body = `
    <div class="card">
      <div style="font-weight:800">Mensagens (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Cada vendedor ajusta suas próprias mensagens.</div>
      <form method="POST" action="/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}">
        ${fields.map(k=>`
          <label>${k}</label>
          <textarea name="${k}">${htmlEscape(m[k] || '')}</textarea>
        `).join('')}
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>`;
  res.send(layoutMobile({ title:'Mensagens', user:req.user, bodyHtml: body }));
});

app.post('/m/messages', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  bot.updateMessages(req.body || {});
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_messages', panelUser:req.user.username });
  res.redirect(`/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- agenda (confirmación + lembretes) -------
function formatPhoneKey(phoneRaw){
  const digits = String(phoneRaw || '').replace(/\D/g,'');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : ('55' + digits);
}

function listAgendasForBot(snap){
  const agendas = snap.agendas || {};
  const rows = [];
  for (const [jid, arr] of Object.entries(agendas)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    const sorted = [...arr].sort((a,b)=>a.at-b.at);
    const next = sorted[0];
    rows.push({ jid, phone, nextAt: next.at, count: sorted.length, keys: sorted.map(x=>x.key).join(', ') });
  }
  rows.sort((a,b)=>a.nextAt-b.nextAt);
  return rows;
}

function listProgramadosForBot(snap){
  const program = snap.scheduledStarts || {};
  const rows = [];
  for (const [jid, s] of Object.entries(program)) {
    if (!s || !s.at) continue;
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    rows.push({ jid, phone, at: s.at, preview: (s.text||'').slice(0,90) });
  }
  rows.sort((a,b)=>a.at-b.at);
  return rows;
}

app.get('/m/agenda', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const m = snap.messagesConfig || {};
  const agendasRows = listAgendasForBot(snap);

  const table = agendasRows.length ? `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Agendas confirmadas</div>
      <div class="muted">Lembretes ativos (7/3/1 dias) para este número.</div>
      <table style="width:100%">
        <thead><tr><th>Contato</th><th>Próximo</th><th>#</th><th>Ações</th></tr></thead>
        <tbody>
          ${agendasRows.map(r=>{
            const d = new Date(r.nextAt);
            const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            return `<tr>
              <td>${htmlEscape(r.phone)}</td>
              <td>${htmlEscape(dt)}</td>
              <td>${r.count}</td>
              <td>
                <form method="POST" action="/m/agenda/cancel${req.user.role==='admin'?`?botId=${botId}`:''}">
                  <input type="hidden" name="jid" value="${htmlEscape(r.jid)}"/>
                  <button class="btn btn-danger" type="submit">Cancelar</button>
                </form>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : `<div class="card"><div class="muted">Nenhuma agenda confirmada ainda.</div></div>`;

  const body = `
    <div class="card">
      <div style="font-weight:800">Confirmación de agenda (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Programa lembretes 7/3/1 dias e (opcional) envia confirmação agora.</div>

      <form method="POST" action="/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>

        <div class="grid2">
          <div><label>Dia</label><input name="date" type="date" required/></div>
          <div><label>Hora</label><input name="time" type="time" required/></div>
        </div>

        <label>Veículo</label><input name="vehicle" placeholder="Ex: BYD SONG PLUS"/>
        <label>Produto</label><input name="product" placeholder="Ex: Iron Glass Plus"/>
        <label>Valor total</label><input name="valor" placeholder="Ex: R$ 12.900,00"/>
        <label>Sinal recebido</label><input name="sinal" placeholder="Ex: R$ 1.075,00"/>
        <label>Forma de pagamento</label><input name="pagamento" placeholder="PIX confirmado"/>

        <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" name="sendConfirm" /> Enviar confirmação agora
        </label>

        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Programar agenda</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Mensagens de lembrete</div>
      <div class="muted">Edita os textos de agenda aqui (7/3/1 dias).</div>
      <form method="POST" action="/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>agenda0 (7 dias)</label><textarea name="agenda0">${htmlEscape(m.agenda0||'')}</textarea>
        <label>agenda1 (3 dias)</label><textarea name="agenda1">${htmlEscape(m.agenda1||'')}</textarea>
        <label>agenda2 (1 dia)</label><textarea name="agenda2">${htmlEscape(m.agenda2||'')}</textarea>
        <label>confirmTemplate</label><textarea name="confirmTemplate">${htmlEscape(m.confirmTemplate||'')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar textos de agenda</button>
      </form>
    </div>

    ${table}
  `;
  res.send(layoutMobile({ title:'Agenda', user:req.user, bodyHtml: body }));
});

app.post('/m/agenda', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  try {
    const phoneKey = formatPhoneKey(req.body.phone);
    const date = req.body.date;
    const time = req.body.time;

    if (!phoneKey || !date || !time) {
      return res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
    }

    const apptTs = new Date(`${date}T${time}:00`).getTime();
    const d = new Date(apptTs);
    const data = {
      DATA: `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`,
      HORA: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
      VEICULO: req.body.vehicle || '',
      PRODUTO: req.body.product || '',
      VALOR: req.body.valor || '',
      SINAL: req.body.sinal || '',
      PAGAMENTO: req.body.pagamento || ''
    };

    // salva/agenda
    bot.scheduleAgendaFromPanel(phoneKey, date, time, data);

    // ⚠️ não bloqueia o request HTTP (Railway pode dar timeout/502)
    if (req.body.sendConfirm) {
      Promise.resolve(bot.sendConfirmNow(phoneKey, data))
        .then((out)=>{
          if (!out || !out.ok) console.warn('[AGENDA] confirm not sent:', out);
        })
        .catch((err)=> console.error('[AGENDA] confirm send error:', err));
    }

    appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'agenda_set', panelUser:req.user.username, phoneKey });
    return res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
  } catch (e) {
    console.error('[AGENDA_POST] fail:', e?.stack || e);
    return res.status(500).send('Erro ao salvar/enviar confirmação. Veja os logs do Railway e tente novamente.');
  }
});

app.post('/m/agenda/cancel', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const jid = req.body.jid;
  if (jid) bot.cancelAgenda ? bot.cancelAgenda(jid) : null;
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'agenda_cancel', panelUser:req.user.username, jid });
  res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- programar (mensagem inicial futura) -------
app.get('/m/program', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const rows = listProgramadosForBot(snap);

  const table = rows.length ? `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Mensagens programadas</div>
      <table style="width:100%">
        <thead><tr><th>Contato</th><th>Quando</th><th>Ações</th></tr></thead>
        <tbody>
        ${rows.map(r=>{
          const d = new Date(r.at);
          const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
          return `<tr>
            <td>${htmlEscape(r.phone)}<div class="muted">${htmlEscape(r.preview)}</div></td>
            <td>${htmlEscape(dt)}</td>
            <td>
              <form method="POST" action="/m/program/cancel${req.user.role==='admin'?`?botId=${botId}`:''}">
                <input type="hidden" name="jid" value="${htmlEscape(r.jid)}"/>
                <button class="btn btn-danger" type="submit">Cancelar</button>
              </form>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>` : `<div class="card"><div class="muted">Nenhuma mensagem programada.</div></div>`;

  const body = `
    <div class="card">
      <div style="font-weight:800">Programar mensagem (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Quando o cliente diz “só posso falar semana que vem”. O bot pausa e envia no dia/hora, depois entra no funil.</div>

      <form method="POST" action="/m/program${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>
        <div class="grid2">
          <div><label>Dia</label><input name="date" type="date" required/></div>
          <div><label>Hora</label><input name="time" type="time" value="09:00"/></div>
        </div>
        <label>Mensagem</label>
        <textarea name="text" placeholder="Ex: Oi! Aqui é da Iron Glass, combinamos de falar hoje..."></textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Programar</button>
      </form>
    </div>
    ${table}
  `;
  res.send(layoutMobile({ title:'Programar', user:req.user, bodyHtml: body }));
});

app.post('/m/program', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const phoneKey = formatPhoneKey(req.body.phone);
  const date = req.body.date;
  const time = req.body.time || '09:00';
  const text = req.body.text || '';

  if (!phoneKey || !date) return res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);

  bot.programStartMessage(phoneKey, date, time, text);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'program_set', panelUser:req.user.username, phoneKey });
  res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

app.post('/m/program/cancel', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const jid = req.body.jid;
  const snap = bot.getDataSnapshot();
  if (jid && snap.scheduledStarts && snap.scheduledStarts[jid]) {
    delete snap.scheduledStarts[jid];
    // ✅ FIX: salvar no DATA_BASE (Railway Volume), não em __dirname/data
    const file = path.join(DATA_BASE, botId, 'programados.json');
    saveJSON(file, snap.scheduledStarts);
  }
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'program_cancel', panelUser:req.user.username, jid });
  res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- cotizar -------
app.get('/m/quote', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const q = snap.quotesConfig || {};
  const body = `
    <div class="card">
      <div style="font-weight:800">Enviar cotização (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Envia uma cotização manual agora e salva no histórico do lead.</div>
      <form method="POST" action="/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required />
        <label>Veículo (modelo)</label>
        <input name="vehicle" placeholder="Ex: BYD SONG PLUS" />
        <label>Ano</label>
        <input name="year" type="number" placeholder="2024" />
        <label>Produto</label>
        <select name="productKey">
          <option value="ironGlass">Iron Glass</option>
          <option value="ironGlassPlus" selected>Iron Glass Plus</option>
          <option value="defender">Defender</option>
        </select>
        <label>Valor</label>
        <input name="value" placeholder="R$ 12.900,00" />
        <label>Pagamento</label>
        <input name="payment" placeholder="12x / PIX / cartão" />
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Enviar cotização</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Templates (editáveis)</div>
      <div class="muted">Variáveis: {{VEICULO}}, {{ANO}}, {{VALOR}}, {{PAGAMENTO}}</div>
      <form method="POST" action="/m/quote/templates${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Iron Glass</label>
        <textarea name="ironGlass_template">${htmlEscape(q.ironGlass?.template || '')}</textarea>
        <label>Iron Glass Plus</label>
        <textarea name="ironGlassPlus_template">${htmlEscape(q.ironGlassPlus?.template || '')}</textarea>
        <label>Defender</label>
        <textarea name="defender_template">${htmlEscape(q.defender?.template || '')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar templates</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Cotizar', user:req.user, bodyHtml: body }));
});

app.post('/m/quote', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  try {
    const phoneKey = String(req.body.phone||'').replace(/\D/g,'');
    if (!phoneKey) return res.redirect(`/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}`);
    const pk = phoneKey.startsWith('55') ? phoneKey : ('55'+phoneKey);

    const payload = {
      productKey: req.body.productKey || 'ironGlassPlus',
      vehicle: req.body.vehicle || '',
      year: Number(req.body.year||'') || '',
      value: req.body.value || '',
      payment: req.body.payment || ''
    };

    // não bloqueia o request (evita timeout/502)
    Promise.resolve(bot.sendQuoteNow(pk, payload))
      .then((out)=>{
        if (!out || !out.ok) console.warn('[QUOTE] not sent:', out);
      })
      .catch((err)=> console.error('[QUOTE] send error:', err));

    appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'quote_sent', panelUser:req.user.username, phoneKey: pk, payload });
    return res.redirect(`/m/leads${req.user.role==='admin'?`?botId=${botId}`:''}`);
  } catch (e) {
    console.error('[QUOTE_POST] fail:', e?.stack || e);
    return res.status(500).send('Erro ao enviar cotação. Veja os logs do Railway e tente novamente.');
  }
});

app.post('/m/quote/templates', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const q = snap.quotesConfig || {};

  const next = {
    ironGlass: { ...(q.ironGlass||{}), template: req.body.ironGlass_template || (q.ironGlass?.template||'') },
    ironGlassPlus: { ...(q.ironGlassPlus||{}), template: req.body.ironGlassPlus_template || (q.ironGlassPlus?.template||'') },
    defender: { ...(q.defender||{}), template: req.body.defender_template || (q.defender?.template||'') }
  };
  bot.updateQuotes(next);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'quote_templates_update', panelUser:req.user.username });
  res.redirect(`/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- leads / pipeline -------
function stageLabel(s){
  const m = { novo:'Novo', em_negociacao:'Em negociação', cotizado:'Cotizado', agendado:'Agendado', fechado:'Fechado', perdido:'Perdido', programado:'Programado' };
  return m[s] || s || 'Novo';
}

app.get('/m/leads', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const leads = Object.values(snap.leads || {});
  const q = String(req.query.q||'').trim();
  const stage = String(req.query.stage||'').trim();

  let filtered = leads;
  if (q) filtered = filtered.filter(l => (l.phoneKey||'').includes(q) || (l.model||'').toLowerCase().includes(q.toLowerCase()));
  if (stage) filtered = filtered.filter(l => (l.stage||'novo') === stage);

  filtered.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));

  const rows = filtered.slice(0, 200).map(l=>{
    const phone = String(l.phoneKey||'').replace(/^55/,'');
    const st = l.stage || 'novo';
    const last = l.lastInboundAt ? new Date(l.lastInboundAt).toLocaleString() : '-';
    return `<a class="row" href="/m/lead?jid=${encodeURIComponent(l.jid)}${req.user.role==='admin'?`&botId=${botId}`:''}">
      <div style="font-weight:800">${htmlEscape(phone)} <span class="pill">${htmlEscape(stageLabel(st))}</span></div>
      <div class="muted">${htmlEscape((l.model||'') + (l.year?(' • '+l.year):''))}</div>
      <div class="muted">Último inbound: ${htmlEscape(last)}</div>
    </a>`;
  }).join('');

  const body = `
    <div class="card">
      <div style="font-weight:800">Leads (${htmlEscape(botId.toUpperCase())})</div>
      <form method="GET" action="/m/leads" style="margin-top:10px">
        ${req.user.role==='admin'?`<input type="hidden" name="botId" value="${htmlEscape(botId)}"/>`:''}
        <label>Buscar (telefone ou modelo)</label>
        <input name="q" value="${htmlEscape(q)}" placeholder="119999... / song / compass" />
        <label>Stage</label>
        <select name="stage">
          <option value="">Todos</option>
          <option value="novo">Novo</option>
          <option value="em_negociacao">Em negociação</option>
          <option value="cotizado">Cotizado</option>
          <option value="agendado">Agendado</option>
          <option value="fechado">Fechado</option>
          <option value="perdido">Perdido</option>
          <option value="programado">Programado</option>
        </select>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Filtrar</button>
      </form>
    </div>

    <div class="card">
      <div class="muted">Mostrando até 200 leads (ordenado por atualização).</div>
      ${rows || '<div class="muted">Nenhum lead ainda.</div>'}
    </div>
  `;
  res.send(layoutMobile({ title:'Leads', user:req.user, bodyHtml: body }));
});

app.get('/m/lead', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const jid = String(req.query.jid||'');
  const lead = snap.leads?.[jid] || null;
  if (!lead) return res.redirect(`/m/leads${req.user.role==='admin'?`?botId=${botId}`:''}`);
  const phone = String(lead.phoneKey||'').replace(/^55/,'');
  const st = lead.stage || 'novo';

  const body = `
    <div class="card">
      <div style="font-weight:800">Lead ${htmlEscape(phone)} (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">${htmlEscape((lead.model||'') + (lead.year?(' • '+lead.year):''))}</div>
      <form method="POST" action="/m/lead${req.user.role==='admin'?`?botId=${botId}`:''}">
        <input type="hidden" name="jid" value="${htmlEscape(jid)}"/>
        <label>Nome</label>
        <input name="name" value="${htmlEscape(lead.name||'')}" placeholder="Nome do cliente" />
        <label>Tags (separadas por vírgula)</label>
        <input name="tags" value="${htmlEscape((lead.tags||[]).join(', '))}" placeholder="ex: shopping, indicação" />
        <label>Stage</label>
        <select name="stage">
          ${['novo','em_negociacao','cotizado','agendado','fechado','perdido','programado'].map(s=>`<option value="${s}" ${s===st?'selected':''}>${stageLabel(s)}</option>`).join('')}
        </select>
        <label>Notas</label>
        <textarea name="notes" placeholder="Observações do vendedor">${htmlEscape(lead.notes||'')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar lead</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Ações rápidas</div>
      <form method="POST" action="/m/action${req.user.role==='admin'?`?botId=${botId}`:''}">
        <input type="hidden" name="jid" value="${htmlEscape(jid)}"/>
        <select name="action" style="width:100%;margin-bottom:10px">
          <option value="markClient">Marcar como cliente (pós-venda)</option>
          <option value="pause72">Pausar 72h</option>
          <option value="remove">Sacar do funil</option>
          <option value="botOff24">Bot OFF 24h</option>
          <option value="block">Bloquear definitivo</option>
        </select>
        <input name="reason" placeholder="Motivo (opcional)" style="width:100%;margin-bottom:10px" />
        <button class="btn btn-primary" type="submit" style="width:100%">Executar ação</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Lead', user:req.user, bodyHtml: body }));
});

app.post('/m/lead', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const jid = req.body.jid;
  const tags = String(req.body.tags||'').split(',').map(s=>s.trim()).filter(Boolean);
  const stage = req.body.stage || 'novo';
  const patch = { name: req.body.name || '', tags, stage, notes: req.body.notes || '' };
  bot.updateLead(jid, patch);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'lead_update', panelUser:req.user.username, jid, patch });
  res.redirect(`/m/lead?jid=${encodeURIComponent(jid)}${req.user.role==='admin'?`&botId=${botId}`:''}`);
});

// ------- dashboard -------
app.get('/m/dashboard', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const leads = Object.values(snap.leads || {});
  const byStage = {};
  for (const l of leads) {
    const s = l.stage || 'novo';
    byStage[s] = (byStage[s]||0) + 1;
  }

  const stages = ['novo','em_negociacao','cotizado','agendado','fechado','perdido','programado'];
  const cards = stages.map(s=>`
    <div class="card">
      <div style="font-weight:900;font-size:1.1rem">${byStage[s]||0}</div>
      <div class="muted">${htmlEscape(stageLabel(s))}</div>
    </div>`).join('');

  // simple conversion metrics
  const total = leads.length || 0;
  const ag = byStage['agendado']||0;
  const fe = byStage['fechado']||0;
  const ct = byStage['cotizado']||0;

  const body = `
    <div class="card">
      <div style="font-weight:800">Dashboard (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Resumo por stage (pipeline). Próximo passo: comparar vendedores e meses.</div>
    </div>
    <div class="grid2">${cards}</div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Conversão (base atual de leads)</div>
      <div class="muted">Total leads: ${total}</div>
      <div class="muted">Cotizados: ${ct} (${total?Math.round((ct/total)*100):0}%)</div>
      <div class="muted">Agendados: ${ag} (${total?Math.round((ag/total)*100):0}%)</div>
      <div class="muted">Fechados: ${fe} (${total?Math.round((fe/total)*100):0}%)</div>
    </div>
  `;
  res.send(layoutMobile({ title:'Dashboard', user:req.user, bodyHtml: body }));
});

// ------- commands -------
app.get('/m/commands', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const c = snap.config?.commands || {};

  const body = `
    <div class="card">
      <div style="font-weight:800">Comandos (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Editável. Use no WhatsApp (mensagem enviada por você) para acionar ações.</div>
      <form method="POST" action="/m/commands${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>STOP (bloquear definitivo)</label><input name="stop" value="${htmlEscape(c.stop||'')}" />
        <label>PAUSE (pausar 72h)</label><input name="pause" value="${htmlEscape(c.pause||'')}" />
        <label>CLIENTE (pós-venda)</label><input name="client" value="${htmlEscape(c.client||'')}" />
        <label>REMOVE (sacar do funil sem bloquear)</label><input name="remove" value="${htmlEscape(c.remove||'')}" />
        <label>BOT OFF 24h</label><input name="botOff" value="${htmlEscape(c.botOff||'')}" />
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar comandos</button>
      </form>
    </div>`;
  res.send(layoutMobile({ title:'Comandos', user:req.user, bodyHtml: body }));
});

app.post('/m/commands', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  bot.setCommands(req.body || {});
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_commands', panelUser:req.user.username });
  res.redirect(`/m/commands${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- rules -------
app.get('/m/rules', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const rules = snap.config?.rules || {};
  const window = snap.config?.window || {};
  const limits = snap.config?.limits || {};

  const body = `
    <div class="card">
      <div style="font-weight:800">Regras (${htmlEscape(botId.toUpperCase())})</div>
      <form method="POST" action="/m/rules${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Ano mínimo para fazer funil</label>
        <input name="minYearFollowUp" type="number" value="${htmlEscape(rules.minYearFollowUp ?? 2022)}"/>
        <div class="grid2">
          <div>
            <label>Janela início (hora)</label>
            <input name="startHour" type="number" value="${htmlEscape(window.startHour ?? 9)}"/>
          </div>
          <div>
            <label>Janela fim (hora)</label>
            <input name="endHour" type="number" value="${htmlEscape(window.endHour ?? 22)}"/>
          </div>
        </div>
        <div class="grid2">
          <div><label>Limite por minuto</label><input name="perMinute" type="number" value="${htmlEscape(limits.perMinute ?? 8)}"/></div>
          <div><label>Limite por hora</label><input name="perHour" type="number" value="${htmlEscape(limits.perHour ?? 120)}"/></div>
          <div><label>Limite por dia</label><input name="perDay" type="number" value="${htmlEscape(limits.perDay ?? 400)}"/></div>
          <div><label>Por contato/dia</label><input name="perContactPerDay" type="number" value="${htmlEscape(limits.perContactPerDay ?? 2)}"/></div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar regras</button>
      </form>
      <div class="muted" style="margin-top:10px">Se ano detectado &lt; mínimo: não entra no funil, mas registra estatística em events.json.</div>
    </div>`;
  res.send(layoutMobile({ title:'Regras', user:req.user, bodyHtml: body }));
});

app.post('/m/rules', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const minYearFollowUp = Number(req.body.minYearFollowUp || 2022);
  const startHour = Number(req.body.startHour || 9);
  const endHour = Number(req.body.endHour || 22);

  bot.updateConfig({
    rules: { minYearFollowUp },
    window: { startHour, endHour },
    limits: {
      perMinute: Number(req.body.perMinute || 8),
      perHour: Number(req.body.perHour || 120),
      perDay: Number(req.body.perDay || 400),
      perContactPerDay: Number(req.body.perContactPerDay || 2),
    }
  });

  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_rules', panelUser:req.user.username });
  res.redirect(`/m/rules${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- stats -------
function inRange(ts, fromTs, toTs) {
  if (fromTs && ts < fromTs) return false;
  if (toTs && ts > toTs) return false;
  return true;
}
app.get('/m/stats', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId) && req.user.role !== 'admin') return res.status(403).send('forbidden');

  const from = req.query.from || '';
  const to = req.query.to || '';
  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : null;
  const toTs = to ? new Date(to + 'T23:59:59').getTime() : null;

  const events = loadJSON(EVENTS_FILE, []);
  const rows = events
    .filter(e => e.action === 'inbound_message')
    .filter(e => req.user.role === 'admin' ? (botId ? e.botId === botId : true) : e.botId === botId)
    .filter(e => inRange(Number(e.ts||0), fromTs, toTs));

  const rulesK = bots[botId].getConfig()?.rules || { minYearFollowUp: 2022 };
  const minYearK = Number(rulesK.minYearFollowUp || 2022);
  const leadsK = bots[botId].getLeads();
  let belowK=0, aboveK=0;
  for (const lead of Object.values(leadsK||{})) {
    const y = Number(lead.year||0);
    if (!y) continue;
    if (y < minYearK) belowK++; else aboveK++;
  }
  const eventsK = loadJSON(EVENTS_FILE, []);
  const sentK = eventsK.filter(e=>e.botId=== botId && e.action==='auto_sent').length;

  const byYear = {};
  const byModel = {};
  for (const e of rows) {
    const y = e.year || 'SEM_ANO';
    byYear[y] = (byYear[y] || 0) + 1;
    const m = e.model || 'SEM_MODELO';
    byModel[m] = (byModel[m] || 0) + 1;
  }

  const yearTable = Object.entries(byYear).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))).map(([k,v])=>`<tr><td>${htmlEscape(k)}</td><td>${v}</td></tr>`).join('');
  const modelTable = Object.entries(byModel).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([k,v])=>`<tr><td>${htmlEscape(k)}</td><td>${v}</td></tr>`).join('');

  const body = `
    <div class="card">
      <div style="font-weight:800">Estatísticas (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Filtra por período e mostra quantos clientes escreveram por ano/modelo (quando detectado).</div>
      <form method="GET" action="/m/stats">
        ${req.user.role==='admin' ? `
        <label>Bot</label>
        <select name="botId">
          ${BOT_IDS.map(id=>`<option value="${id}" ${id===botId?'selected':''}>${id.toUpperCase()}</option>`).join('')}
        </select>` : ``}
        <div class="grid2">
          <div><label>De</label><input name="from" type="date" value="${htmlEscape(from)}"/></div>
          <div><label>Até</label><input name="to" type="date" value="${htmlEscape(to)}"/></div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Aplicar</button>
      </form>

      <div class="card" style="border:1px solid rgba(250,204,21,.25)">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div><div class="muted">Mensagens (auto, total)</div><div style="font-size:22px;font-weight:900">${sentK}</div></div>
          <div><div class="muted">Carros &lt; ${minYearK}</div><div style="font-size:22px;font-weight:900">${belowK}</div></div>
          <div><div class="muted">Carros ≥ ${minYearK}</div><div style="font-size:22px;font-weight:900">${aboveK}</div></div>
        </div>
        <div class="muted" style="margin-top:6px">Ano mínimo vem de <b>Regras</b> (mude lá e isso atualiza automaticamente).</div>
      </div>

      <div class="muted" style="margin-top:10px">Total mensagens inbound no período: <b>${rows.length}</b></div>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Por ano</div>
      <table style="width:100%"><thead><tr><th>Ano</th><th>Qtd</th></tr></thead><tbody>${yearTable || '<tr><td colspan="2" class="muted">Sem dados</td></tr>'}</tbody></table>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Top modelos (30)</div>
      <table style="width:100%"><thead><tr><th>Modelo</th><th>Qtd</th></tr></thead><tbody>${modelTable || '<tr><td colspan="2" class="muted">Sem dados</td></tr>'}</tbody></table>
    </div>
  `;
  res.send(layoutMobile({ title:'Estatísticas', user:req.user, bodyHtml: body }));
});

app.get('/m/users', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const users = loadUsers();
  const rows = Object.entries(users).map(([u,v])=>{
    return `<tr>
      <td><b>${htmlEscape(u)}</b></td>
      <td>${htmlEscape(v.role||'seller')}</td>
      <td>${htmlEscape((v.botId||'').toUpperCase())}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <form method="POST" action="/m/users/delete" onsubmit="return confirm('Excluir usuário?')">
          <input type="hidden" name="username" value="${htmlEscape(u)}"/>
          <button class="btn" type="submit" style="background:#ef4444">Excluir</button>
        </form>
      </td>
    </tr>`;
  }).join('');
  const body = `
    <div class="card">
      <div style="font-weight:900">Usuários</div>
      <div class="muted">Admin pode criar/editar vendedores. Cada vendedor vê apenas o seu bot.</div>
    </div>

    <div class="card">
      <div style="font-weight:900;margin-bottom:8px">Criar / Atualizar</div>
      <form method="POST" action="/m/users/upsert">
        <label>Usuário</label><input name="username" placeholder="ex: vendedor1" required/>
        <label>Senha</label><input name="password" placeholder="deixe vazio para manter" />
        <label>Bot</label>
        <select name="botId">
          ${BOT_IDS.map(id=>`<option value="${id}">${id.toUpperCase()}</option>`).join('')}
        </select>
        <label>Role</label>
        <select name="role">
          <option value="seller">seller</option>
          <option value="admin">admin</option>
        </select>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:900;margin-bottom:6px">Lista</div>
      <table style="width:100%"><thead><tr><th>Usuário</th><th>Role</th><th>Bot</th><th>Ação</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Sem usuários</td></tr>'}</tbody></table>
    </div>
  `;
  res.send(layoutMobile({ title:'Usuários', user:req.user, bodyHtml: body }));
});

app.post('/m/users/upsert', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const { username, password, botId, role } = req.body || {};
  if (!username) return res.redirect('/m/users');
  if (role && !['admin','seller'].includes(role)) return res.redirect('/m/users');
  if (botId && !BOT_IDS.includes(botId)) return res.redirect('/m/users');
  const users = loadUsers();
  const cur = users[username] || {};
  users[username] = {
    role: role || cur.role || 'seller',
    botId: (role==='admin') ? '*' : (botId || cur.botId || 'v1'),
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.pass || cur.password || '123')
  };
  saveUsers(users);
  res.redirect('/m/users');
});

app.post('/m/users/delete', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const username = req.body.username;
  const users = loadUsers();
  delete users[username];
  saveUsers(users);
  res.redirect('/m/users');
});

// ------- desktop admin (overview) -------
app.get('/admin', requireAuth, async (req,res)=>{
  if (req.user.role !== 'admin') return res.redirect('/m');
  const rows = [];
  for (const id of BOT_IDS) {
    const st = bots[id].getStatus();
    const qrUrl = await qrDataUrl(st.qr);
    rows.push(`
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:18px;font-weight:800">${id.toUpperCase()}</div>
            <div class="muted">Conectado: <b>${st.connected?'SIM':'NÃO'}</b> · Funil: <b>${st.enabled?'ON':'OFF'}</b> · Fila: <b>${st.queueSize}</b></div>
          </div>
          <div class="row">
            <form method="POST" action="/admin/toggle-connect?botId=${id}"><button class="btn ${st.connected?'btn-danger':'btn-primary'}" type="submit">${st.connected?'Desconectar':'Conectar'}</button></form>
            <form method="POST" action="/admin/toggle-enabled?botId=${id}"><button class="btn btn-ghost" type="submit">${st.enabled?'Pausar':'Ativar'}</button></form>
            <a class="btn btn-ghost" style="text-decoration:none" href="/m?botId=${id}">Abrir no mobile</a>
          </div>
        </div>
        ${st.connected ? '' : (qrUrl ? `<div style="margin-top:10px"><img src="${qrUrl}" style="width:220px;border-radius:12px;background:#fff"/></div>` : '')}
      </div>
    `);
  }

  const html = layoutDesktop({
    title: 'Admin · MultiBot',
    bodyHtml: `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:22px;font-weight:900">Admin · MultiBot</div>
            <div class="muted">Gerencia os 5 números. Use volume persistente no Railway para manter sessões.</div>
          </div>
          <div class="row"><a class="btn btn-primary" style="text-decoration:none" href="/m">Ir para mobile</a><a class="btn btn-ghost" style="text-decoration:none" href="/logout">Sair</a></div>
        </div>
      </div>
      ${rows.join('')}
    `
  });
  res.send(html);
});

app.post('/admin/toggle-connect', requireAuth, async (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const botId = req.query.botId;
  if (!BOT_IDS.includes(botId)) return res.redirect('/admin');
  const st = bots[botId].getStatus();
  if (st.connected) {
  if (AUTO_NEW_QR_ON_DISCONNECT) await forceNewQr(botId);
  else await bots[botId].disconnect();
} else {
  await bots[botId].connect();
}
  res.redirect('/admin');
});

app.post('/admin/toggle-enabled', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const botId = req.query.botId;
  if (!BOT_IDS.includes(botId)) return res.redirect('/admin');
  const st = bots[botId].getStatus();
  bots[botId].setEnabled(!st.enabled);
  res.redirect('/admin');
});

// ------- start -------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=>console.log(`✅ MultiBot rodando: http://localhost:${PORT}/m`));

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

function safeRequire(candidates) {
  let lastErr = null;
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      // Solo ignorar si el módulo que falta es EXACTAMENTE el candidato probado
      if (e && e.code === 'MODULE_NOT_FOUND') {
        const msg = String(e.message || '');
        if (msg.includes(`Cannot find module '${c}'`) || msg.includes(`Cannot find module "${c}"`)) {
          lastErr = e;
          continue;
        }
      }
      throw e;
    }
  }
  throw lastErr || new Error(`Cannot load any of: ${candidates.join(', ')}`);
}

// ✅ Railway/Linux es case-sensitive: probamos variaciones comunes de nombres
const utilsMod = safeRequire(['./src/utils', './src/Utils', './src/utils/index']);
const botCoreMod = safeRequire(['./src/botCore', './src/botcore', './src/BotCore']);
const panelMod  = safeRequire(['./src/panelTemplates', './src/paneltemplates', './src/PanelTemplates']);

const { loadJSON, saveJSON, htmlEscape, applyTemplate } = utilsMod;
const { createBot } = botCoreMod;
const { qrDataUrl, layoutMobile, layoutDesktop } = panelMod;

const qrDataUrlFn = async (qr) => (qr ? qrDataUrl(qr) : null);
const BASE_DIR = __dirname;
const DATA_BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(BASE_DIR, 'data');
const AUTH_BASE = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(DATA_BASE, 'auth');

const BOT_IDS = ['v1','v2','v3','v4','v5'];

// ✅ garante estrutura de pastas/arquivos (Railway + Volume)
function ensureBaseStorage() {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.mkdirSync(AUTH_BASE, { recursive: true });
    for (const botId of BOT_IDS) {
      fs.mkdirSync(path.join(DATA_BASE, botId), { recursive: true });
      fs.mkdirSync(path.join(AUTH_BASE, botId), { recursive: true });
    }
    const eventsFile = path.join(DATA_BASE, 'events.json');
    if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, '[]', 'utf8');
    const usersFile = path.join(DATA_BASE, 'users.json');
    if (!fs.existsSync(usersFile)) {
      const seed = {
        admin: { role: 'admin', botId: '*', pass: 'admin123' },
        v1: { role: 'seller', botId: 'v1', pass: '123' },
        v2: { role: 'seller', botId: 'v2', pass: '123' },
        v3: { role: 'seller', botId: 'v3', pass: '123' },
        v4: { role: 'seller', botId: 'v4', pass: '123' },
        v5: { role: 'seller', botId: 'v5', pass: '123' },
      };
      fs.writeFileSync(usersFile, JSON.stringify(seed, null, 2), 'utf8');
      console.log('[BOOT] users.json criado (seed).');
    }
  } catch (e) {
    console.error('[BOOT] storage fail:', e?.message || e);
  }
}
ensureBaseStorage();

// ------- event logger (global) -------
const EVENTS_FILE = path.join(DATA_BASE, 'events.json');
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

// ------- bots -------
const bots = {};
for (const botId of BOT_IDS) {
  bots[botId] = createBot({
    botId,
    baseDir: BASE_DIR,
    authDir: path.join(AUTH_BASE, botId),
    eventLogger: appendEvent
  });
}

// ------- QR automático al desconectar -------
// Si querés desactivar este comportamiento, poné AUTO_NEW_QR_ON_DISCONNECT=false en .env
const AUTO_NEW_QR_ON_DISCONNECT = String(process.env.AUTO_NEW_QR_ON_DISCONNECT ?? 'true').toLowerCase() === 'true';

async function forceNewQr(botId) {
  // 1) Corta conexión actual (si existe)
  try { await bots[botId].disconnect(); } catch (e) {}

  // 2) Borra credenciales: esto es lo que fuerza a WhatsApp/Baileys a emitir un QR NUEVO
  const dir = path.join(AUTH_BASE, botId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // 3) Reconecta: al no haber credenciales, debería aparecer QR
  await bots[botId].connect();
}

// ------- users -------
const USERS_FILE = path.join(DATA_BASE, 'users.json');
function loadUsers(){ return loadJSON(USERS_FILE, {}); }
function saveUsers(u){ return saveJSON(USERS_FILE, u); }

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
  return [normBotId(user.botId)];
}

function normBotId(x){
  return String(x || '').trim().toLowerCase();
}

function getSelectedBotId(req){
  // req puede ser Express req o un objeto {user, query, body}
  const user = req?.user || {};
  const query = req?.query || {};
  const body = req?.body || {};
  if (user.role !== 'admin') return normBotId(user.botId);

  const q = normBotId(query.botId ?? body.botId);
  if (q && BOT_IDS.includes(q)) return q;

  return 'v1';
}

// Helpers
function normalizePhone(raw){
  const digits = String(raw || '').replace(/\D/g,'');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : ('55' + digits);
}
function jidToPhone(jid){
  const j = String(jid || '').trim();
  if (!j) return '';
  return j.replace('@s.whatsapp.net','').replace(/\D/g,'');
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
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId }, body: req.body });
  const st = bots[botId].getStatus();
  const qr = st.qr || null;
  const qrDataUrl = await qrDataUrlFn(qr);
  res.set('Cache-Control','no-store');
  res.json({ botId, connected: st.connected, enabled: st.enabled, queueSize: st.queueSize, qrDataUrl, lastError: st.lastError || null });
});

app.post('/api/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = bots[botId].getStatus();

  // ✅ Al "desconectar" desde el panel, forzamos un QR NUEVO automáticamente
  // (borra authDir/<botId> y reconecta).
  if (st.connected) {
    if (AUTO_NEW_QR_ON_DISCONNECT) {
      await forceNewQr(botId);
    } else {
      await bots[botId].disconnect();
    }
  } else {
    await bots[botId].connect();
  }

  res.json({ ok:true });
});

app.post('/api/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.body.botId } });
  const st = bots[botId].getStatus();
  bots[botId].setEnabled(!st.enabled);
  res.json({ ok:true });
});

// Stats: total messages + car-year buckets based on "Regras.minYearFollowUp"
app.get('/api/stats', requireAuth, (req,res)=>{
  const botId = getSelectedBotId({ user: req.user, query: { botId: req.query.botId }, body: req.body });
  const rules = bots[botId].getConfig()?.rules || { minYearFollowUp: 2022 };
  const minYear = Number(rules.minYearFollowUp || 2022);

  // total auto sent from events
  const events = loadJSON(EVENTS_FILE, []);
  const totalSent = events.filter(e => e.botId === botId && e.action === 'auto_sent').length;

  // car buckets from leads (unique contacts)
  const leads = bots[botId].getLeads();
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
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.pass || cur.password || '123')
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
    input{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #1f2a44;border-radius:12px;padding:10px 12px;font-size:14px}
    button{width:100%;margin-top:12px;background:#facc15;color:#111827;border:none;border-radius:14px;padding:12px 14px;font-weight:800;font-size:14px;cursor:pointer}
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
  if (!u) return res.redirect('/login');
  const stored = (u.pass ?? u.password);
  if (stored !== password) return res.redirect('/login');
  req.session.user = { username };
  res.redirect('/m');
});

app.get('/logout', (req,res)=>{
  req.session.destroy(()=>res.redirect('/login'));
});

// ------- mobile panel -------
app.get('/m', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  const bot = bots[botId];
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');

  const status = bot.getStatus();
  const qrUrl = await qrDataUrl(status.qr);

  const body = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:16px;font-weight:800">Bot: ${htmlEscape(botId.toUpperCase())}</div>
          <div class="muted">Conectado: <b>${status.connected ? 'SIM ✅' : 'NÃO ❌'}</b> · Funil ativo: <b>${status.enabled ? 'SIM' : 'NÃO'}</b> · Fila: <b>${status.queueSize}</b></div>
        </div>
        ${req.user.role === 'admin' ? `
        <form method="GET" action="/m" style="min-width:140px">
          <label>Ver bot</label>
          <select name="botId" onchange="this.form.submit()">
            ${BOT_IDS.map(id=>`<option value="${id}" ${id===botId?'selected':''}>${id.toUpperCase()}</option>`).join('')}
          </select>
        </form>` : ``}
      </div>
      <div class="row" style="margin-top:10px">
        <form method="POST" action="/m/toggle-connect${req.user.role==='admin'?`?botId=${botId}`:''}">
          <button class="btn ${status.connected ? 'btn-danger':'btn-primary'}" type="submit">${status.connected ? 'Desconectar' : 'Conectar (gerar QR)'}</button>
        </form>
        <form method="POST" action="/m/toggle-enabled${req.user.role==='admin'?`?botId=${botId}`:''}">
          <button class="btn ${status.enabled ? 'btn-ghost':'btn-ok'}" type="submit">${status.enabled ? '⏸️ Pausar funil/envios' : '▶️ Ativar funil/envios'}</button>
        </form>
      </div>
      ${status.connected ? '' : (qrUrl ? `<div class="qr" style="margin-top:12px"><img src="${qrUrl}"/></div>
      <div class="muted" style="margin-top:8px;text-align:center">WhatsApp → Dispositivos conectados → Conectar</div>` :
      `<div class="muted" style="margin-top:12px">Clique em “Conectar” para gerar QR.</div>`)}
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Ações rápidas</div>
      <div class="muted">Use para controlar contatos sem precisar digitar comandos no WhatsApp.</div>
      <form method="POST" action="/m/action${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>
        <div class="grid2">
          <div>
            <label>Ação</label>
            <select name="action">
              <option value="pause72">Pausar 72h</option>
              <option value="remove">Sacar do funil</option>
              <option value="botOff24">Bot OFF 24h</option>
              <option value="block">Bloquear definitivo</option>
              <option value="markClient">Marcar como cliente (pós-venda)</option>
            </select>
          </div>
          <div>
            <label>Motivo (opcional)</label>
            <input name="reason" placeholder="ex: pediu para parar"/>
          </div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Executar</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Painel', user:req.user, bodyHtml: body }));
});

app.post('/m/toggle-connect', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const st = bot.getStatus();
  if (st.connected) {
  if (AUTO_NEW_QR_ON_DISCONNECT) await forceNewQr(botId);
  else await bot.disconnect();
} else {
  await bot.connect();
}
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

app.post('/m/toggle-enabled', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const st = bot.getStatus();
  bot.setEnabled(!st.enabled);
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

/**
 * ✅ FIX PERMANENTE:
 * Agora aceita:
 * - req.body.phone  (como no painel principal)
 * - req.body.jid    (como no botão dentro do Lead)
 */
app.post('/m/action', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  // Pode vir phone OU jid
  const jidFromBody = (req.body.jid || '').trim();
  const phoneFromJid = normalizePhone(jidToPhone(jidFromBody));

  const phoneRaw = (req.body.phone || '').replace(/\D/g,'');
  const phoneFromPhone = normalizePhone(phoneRaw);

  const phone = phoneFromJid || phoneFromPhone;
  if (!phone) return res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);

  const jid = phone + '@s.whatsapp.net';
  const action = req.body.action;
  const reason = req.body.reason || '';

  if (action === 'pause72') bot.pauseFollowUp(jid, 72*60*60*1000);
  if (action === 'remove') bot.stopFollowUp(jid);
  if (action === 'botOff24') bot.setManualOff(jid, 24*60*60*1000);
  if (action === 'block') bot.blockFollowUp(jid, phone, reason || 'manual_panel');
  if (action === 'markClient') bot.markAsClient(jid);

  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'panel_action', panelUser:req.user.username, target: phone, kind: action, reason });
  res.redirect(`/m${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- messages -------
app.get('/m/messages', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const m = snap.messagesConfig || {};

  const fields = ['step0','step1','step2','step3','extra','postSale30','agenda0','agenda1','agenda2','confirmTemplate'];

  const body = `
    <div class="card">
      <div style="font-weight:800">Mensagens (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Cada vendedor ajusta suas próprias mensagens.</div>
      <form method="POST" action="/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}">
        ${fields.map(k=>`
          <label>${k}</label>
          <textarea name="${k}">${htmlEscape(m[k] || '')}</textarea>
        `).join('')}
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>`;
  res.send(layoutMobile({ title:'Mensagens', user:req.user, bodyHtml: body }));
});

app.post('/m/messages', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  bot.updateMessages(req.body || {});
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_messages', panelUser:req.user.username });
  res.redirect(`/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- agenda (confirmación + lembretes) -------
function formatPhoneKey(phoneRaw){
  const digits = String(phoneRaw || '').replace(/\D/g,'');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : ('55' + digits);
}

function listAgendasForBot(snap){
  const agendas = snap.agendas || {};
  const rows = [];
  for (const [jid, arr] of Object.entries(agendas)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    const sorted = [...arr].sort((a,b)=>a.at-b.at);
    const next = sorted[0];
    rows.push({ jid, phone, nextAt: next.at, count: sorted.length, keys: sorted.map(x=>x.key).join(', ') });
  }
  rows.sort((a,b)=>a.nextAt-b.nextAt);
  return rows;
}

function listProgramadosForBot(snap){
  const program = snap.scheduledStarts || {};
  const rows = [];
  for (const [jid, s] of Object.entries(program)) {
    if (!s || !s.at) continue;
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    rows.push({ jid, phone, at: s.at, preview: (s.text||'').slice(0,90) });
  }
  rows.sort((a,b)=>a.at-b.at);
  return rows;
}

app.get('/m/agenda', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const m = snap.messagesConfig || {};
  const agendasRows = listAgendasForBot(snap);

  const table = agendasRows.length ? `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Agendas confirmadas</div>
      <div class="muted">Lembretes ativos (7/3/1 dias) para este número.</div>
      <table style="width:100%">
        <thead><tr><th>Contato</th><th>Próximo</th><th>#</th><th>Ações</th></tr></thead>
        <tbody>
          ${agendasRows.map(r=>{
            const d = new Date(r.nextAt);
            const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            return `<tr>
              <td>${htmlEscape(r.phone)}</td>
              <td>${htmlEscape(dt)}</td>
              <td>${r.count}</td>
              <td>
                <form method="POST" action="/m/agenda/cancel${req.user.role==='admin'?`?botId=${botId}`:''}">
                  <input type="hidden" name="jid" value="${htmlEscape(r.jid)}"/>
                  <button class="btn btn-danger" type="submit">Cancelar</button>
                </form>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : `<div class="card"><div class="muted">Nenhuma agenda confirmada ainda.</div></div>`;

  const body = `
    <div class="card">
      <div style="font-weight:800">Confirmación de agenda (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Programa lembretes 7/3/1 dias e (opcional) envia confirmação agora.</div>

      <form method="POST" action="/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>

        <div class="grid2">
          <div><label>Dia</label><input name="date" type="date" required/></div>
          <div><label>Hora</label><input name="time" type="time" required/></div>
        </div>

        <label>Veículo</label><input name="vehicle" placeholder="Ex: BYD SONG PLUS"/>
        <label>Produto</label><input name="product" placeholder="Ex: Iron Glass Plus"/>
        <label>Valor total</label><input name="valor" placeholder="Ex: R$ 12.900,00"/>
        <label>Sinal recebido</label><input name="sinal" placeholder="Ex: R$ 1.075,00"/>
        <label>Forma de pagamento</label><input name="pagamento" placeholder="PIX confirmado"/>

        <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" name="sendConfirm" /> Enviar confirmação agora
        </label>

        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Programar agenda</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Mensagens de lembrete</div>
      <div class="muted">Edita os textos de agenda aqui (7/3/1 dias).</div>
      <form method="POST" action="/m/messages${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>agenda0 (7 dias)</label><textarea name="agenda0">${htmlEscape(m.agenda0||'')}</textarea>
        <label>agenda1 (3 dias)</label><textarea name="agenda1">${htmlEscape(m.agenda1||'')}</textarea>
        <label>agenda2 (1 dia)</label><textarea name="agenda2">${htmlEscape(m.agenda2||'')}</textarea>
        <label>confirmTemplate</label><textarea name="confirmTemplate">${htmlEscape(m.confirmTemplate||'')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar textos de agenda</button>
      </form>
    </div>

    ${table}
  `;
  res.send(layoutMobile({ title:'Agenda', user:req.user, bodyHtml: body }));
});

app.post('/m/agenda', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  try {
    const phoneKey = formatPhoneKey(req.body.phone);
    const date = req.body.date;
    const time = req.body.time;

    if (!phoneKey || !date || !time) {
      return res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
    }

    const apptTs = new Date(`${date}T${time}:00`).getTime();
    const d = new Date(apptTs);
    const data = {
      DATA: `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`,
      HORA: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
      VEICULO: req.body.vehicle || '',
      PRODUTO: req.body.product || '',
      VALOR: req.body.valor || '',
      SINAL: req.body.sinal || '',
      PAGAMENTO: req.body.pagamento || ''
    };

    // salva/agenda
    bot.scheduleAgendaFromPanel(phoneKey, date, time, data);

    // ⚠️ não bloqueia o request HTTP (Railway pode dar timeout/502)
    if (req.body.sendConfirm) {
      Promise.resolve(bot.sendConfirmNow(phoneKey, data))
        .then((out)=>{
          if (!out || !out.ok) console.warn('[AGENDA] confirm not sent:', out);
        })
        .catch((err)=> console.error('[AGENDA] confirm send error:', err));
    }

    appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'agenda_set', panelUser:req.user.username, phoneKey });
    return res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
  } catch (e) {
    console.error('[AGENDA_POST] fail:', e?.stack || e);
    return res.status(500).send('Erro ao salvar/enviar confirmação. Veja os logs do Railway e tente novamente.');
  }
});

app.post('/m/agenda/cancel', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const jid = req.body.jid;
  if (jid) bot.cancelAgenda ? bot.cancelAgenda(jid) : null;
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'agenda_cancel', panelUser:req.user.username, jid });
  res.redirect(`/m/agenda${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- programar (mensagem inicial futura) -------
app.get('/m/program', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const rows = listProgramadosForBot(snap);

  const table = rows.length ? `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Mensagens programadas</div>
      <table style="width:100%">
        <thead><tr><th>Contato</th><th>Quando</th><th>Ações</th></tr></thead>
        <tbody>
        ${rows.map(r=>{
          const d = new Date(r.at);
          const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
          return `<tr>
            <td>${htmlEscape(r.phone)}<div class="muted">${htmlEscape(r.preview)}</div></td>
            <td>${htmlEscape(dt)}</td>
            <td>
              <form method="POST" action="/m/program/cancel${req.user.role==='admin'?`?botId=${botId}`:''}">
                <input type="hidden" name="jid" value="${htmlEscape(r.jid)}"/>
                <button class="btn btn-danger" type="submit">Cancelar</button>
              </form>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>` : `<div class="card"><div class="muted">Nenhuma mensagem programada.</div></div>`;

  const body = `
    <div class="card">
      <div style="font-weight:800">Programar mensagem (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Quando o cliente diz “só posso falar semana que vem”. O bot pausa e envia no dia/hora, depois entra no funil.</div>

      <form method="POST" action="/m/program${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required/>
        <div class="grid2">
          <div><label>Dia</label><input name="date" type="date" required/></div>
          <div><label>Hora</label><input name="time" type="time" value="09:00"/></div>
        </div>
        <label>Mensagem</label>
        <textarea name="text" placeholder="Ex: Oi! Aqui é da Iron Glass, combinamos de falar hoje..."></textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Programar</button>
      </form>
    </div>
    ${table}
  `;
  res.send(layoutMobile({ title:'Programar', user:req.user, bodyHtml: body }));
});

app.post('/m/program', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const phoneKey = formatPhoneKey(req.body.phone);
  const date = req.body.date;
  const time = req.body.time || '09:00';
  const text = req.body.text || '';

  if (!phoneKey || !date) return res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);

  bot.programStartMessage(phoneKey, date, time, text);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'program_set', panelUser:req.user.username, phoneKey });
  res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

app.post('/m/program/cancel', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const jid = req.body.jid;
  const snap = bot.getDataSnapshot();
  if (jid && snap.scheduledStarts && snap.scheduledStarts[jid]) {
    delete snap.scheduledStarts[jid];
    // ✅ FIX: salvar no DATA_BASE (Railway Volume), não em __dirname/data
    const file = path.join(DATA_BASE, botId, 'programados.json');
    saveJSON(file, snap.scheduledStarts);
  }
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'program_cancel', panelUser:req.user.username, jid });
  res.redirect(`/m/program${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- cotizar -------
app.get('/m/quote', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const q = snap.quotesConfig || {};
  const body = `
    <div class="card">
      <div style="font-weight:800">Enviar cotização (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Envia uma cotização manual agora e salva no histórico do lead.</div>
      <form method="POST" action="/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Número do cliente</label>
        <input name="phone" placeholder="5511999999999" required />
        <label>Veículo (modelo)</label>
        <input name="vehicle" placeholder="Ex: BYD SONG PLUS" />
        <label>Ano</label>
        <input name="year" type="number" placeholder="2024" />
        <label>Produto</label>
        <select name="productKey">
          <option value="ironGlass">Iron Glass</option>
          <option value="ironGlassPlus" selected>Iron Glass Plus</option>
          <option value="defender">Defender</option>
        </select>
        <label>Valor</label>
        <input name="value" placeholder="R$ 12.900,00" />
        <label>Pagamento</label>
        <input name="payment" placeholder="12x / PIX / cartão" />
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Enviar cotização</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Templates (editáveis)</div>
      <div class="muted">Variáveis: {{VEICULO}}, {{ANO}}, {{VALOR}}, {{PAGAMENTO}}</div>
      <form method="POST" action="/m/quote/templates${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Iron Glass</label>
        <textarea name="ironGlass_template">${htmlEscape(q.ironGlass?.template || '')}</textarea>
        <label>Iron Glass Plus</label>
        <textarea name="ironGlassPlus_template">${htmlEscape(q.ironGlassPlus?.template || '')}</textarea>
        <label>Defender</label>
        <textarea name="defender_template">${htmlEscape(q.defender?.template || '')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar templates</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Cotizar', user:req.user, bodyHtml: body }));
});

app.post('/m/quote', requireAuth, async (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  try {
    const phoneKey = String(req.body.phone||'').replace(/\D/g,'');
    if (!phoneKey) return res.redirect(`/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}`);
    const pk = phoneKey.startsWith('55') ? phoneKey : ('55'+phoneKey);

    const payload = {
      productKey: req.body.productKey || 'ironGlassPlus',
      vehicle: req.body.vehicle || '',
      year: Number(req.body.year||'') || '',
      value: req.body.value || '',
      payment: req.body.payment || ''
    };

    // não bloqueia o request (evita timeout/502)
    Promise.resolve(bot.sendQuoteNow(pk, payload))
      .then((out)=>{
        if (!out || !out.ok) console.warn('[QUOTE] not sent:', out);
      })
      .catch((err)=> console.error('[QUOTE] send error:', err));

    appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'quote_sent', panelUser:req.user.username, phoneKey: pk, payload });
    return res.redirect(`/m/leads${req.user.role==='admin'?`?botId=${botId}`:''}`);
  } catch (e) {
    console.error('[QUOTE_POST] fail:', e?.stack || e);
    return res.status(500).send('Erro ao enviar cotação. Veja os logs do Railway e tente novamente.');
  }
});

app.post('/m/quote/templates', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const q = snap.quotesConfig || {};

  const next = {
    ironGlass: { ...(q.ironGlass||{}), template: req.body.ironGlass_template || (q.ironGlass?.template||'') },
    ironGlassPlus: { ...(q.ironGlassPlus||{}), template: req.body.ironGlassPlus_template || (q.ironGlassPlus?.template||'') },
    defender: { ...(q.defender||{}), template: req.body.defender_template || (q.defender?.template||'') }
  };
  bot.updateQuotes(next);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'quote_templates_update', panelUser:req.user.username });
  res.redirect(`/m/quote${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- leads / pipeline -------
function stageLabel(s){
  const m = { novo:'Novo', em_negociacao:'Em negociação', cotizado:'Cotizado', agendado:'Agendado', fechado:'Fechado', perdido:'Perdido', programado:'Programado' };
  return m[s] || s || 'Novo';
}

app.get('/m/leads', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const leads = Object.values(snap.leads || {});
  const q = String(req.query.q||'').trim();
  const stage = String(req.query.stage||'').trim();

  let filtered = leads;
  if (q) filtered = filtered.filter(l => (l.phoneKey||'').includes(q) || (l.model||'').toLowerCase().includes(q.toLowerCase()));
  if (stage) filtered = filtered.filter(l => (l.stage||'novo') === stage);

  filtered.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));

  const rows = filtered.slice(0, 200).map(l=>{
    const phone = String(l.phoneKey||'').replace(/^55/,'');
    const st = l.stage || 'novo';
    const last = l.lastInboundAt ? new Date(l.lastInboundAt).toLocaleString() : '-';
    return `<a class="row" href="/m/lead?jid=${encodeURIComponent(l.jid)}${req.user.role==='admin'?`&botId=${botId}`:''}">
      <div style="font-weight:800">${htmlEscape(phone)} <span class="pill">${htmlEscape(stageLabel(st))}</span></div>
      <div class="muted">${htmlEscape((l.model||'') + (l.year?(' • '+l.year):''))}</div>
      <div class="muted">Último inbound: ${htmlEscape(last)}</div>
    </a>`;
  }).join('');

  const body = `
    <div class="card">
      <div style="font-weight:800">Leads (${htmlEscape(botId.toUpperCase())})</div>
      <form method="GET" action="/m/leads" style="margin-top:10px">
        ${req.user.role==='admin'?`<input type="hidden" name="botId" value="${htmlEscape(botId)}"/>`:''}
        <label>Buscar (telefone ou modelo)</label>
        <input name="q" value="${htmlEscape(q)}" placeholder="119999... / song / compass" />
        <label>Stage</label>
        <select name="stage">
          <option value="">Todos</option>
          <option value="novo">Novo</option>
          <option value="em_negociacao">Em negociação</option>
          <option value="cotizado">Cotizado</option>
          <option value="agendado">Agendado</option>
          <option value="fechado">Fechado</option>
          <option value="perdido">Perdido</option>
          <option value="programado">Programado</option>
        </select>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Filtrar</button>
      </form>
    </div>

    <div class="card">
      <div class="muted">Mostrando até 200 leads (ordenado por atualização).</div>
      ${rows || '<div class="muted">Nenhum lead ainda.</div>'}
    </div>
  `;
  res.send(layoutMobile({ title:'Leads', user:req.user, bodyHtml: body }));
});

app.get('/m/lead', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const jid = String(req.query.jid||'');
  const lead = snap.leads?.[jid] || null;
  if (!lead) return res.redirect(`/m/leads${req.user.role==='admin'?`?botId=${botId}`:''}`);
  const phone = String(lead.phoneKey||'').replace(/^55/,'');
  const st = lead.stage || 'novo';

  const body = `
    <div class="card">
      <div style="font-weight:800">Lead ${htmlEscape(phone)} (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">${htmlEscape((lead.model||'') + (lead.year?(' • '+lead.year):''))}</div>
      <form method="POST" action="/m/lead${req.user.role==='admin'?`?botId=${botId}`:''}">
        <input type="hidden" name="jid" value="${htmlEscape(jid)}"/>
        <label>Nome</label>
        <input name="name" value="${htmlEscape(lead.name||'')}" placeholder="Nome do cliente" />
        <label>Tags (separadas por vírgula)</label>
        <input name="tags" value="${htmlEscape((lead.tags||[]).join(', '))}" placeholder="ex: shopping, indicação" />
        <label>Stage</label>
        <select name="stage">
          ${['novo','em_negociacao','cotizado','agendado','fechado','perdido','programado'].map(s=>`<option value="${s}" ${s===st?'selected':''}>${stageLabel(s)}</option>`).join('')}
        </select>
        <label>Notas</label>
        <textarea name="notes" placeholder="Observações do vendedor">${htmlEscape(lead.notes||'')}</textarea>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar lead</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Ações rápidas</div>
      <form method="POST" action="/m/action${req.user.role==='admin'?`?botId=${botId}`:''}">
        <input type="hidden" name="jid" value="${htmlEscape(jid)}"/>
        <select name="action" style="width:100%;margin-bottom:10px">
          <option value="markClient">Marcar como cliente (pós-venda)</option>
          <option value="pause72">Pausar 72h</option>
          <option value="remove">Sacar do funil</option>
          <option value="botOff24">Bot OFF 24h</option>
          <option value="block">Bloquear definitivo</option>
        </select>
        <input name="reason" placeholder="Motivo (opcional)" style="width:100%;margin-bottom:10px" />
        <button class="btn btn-primary" type="submit" style="width:100%">Executar ação</button>
      </form>
    </div>
  `;
  res.send(layoutMobile({ title:'Lead', user:req.user, bodyHtml: body }));
});

app.post('/m/lead', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const jid = req.body.jid;
  const tags = String(req.body.tags||'').split(',').map(s=>s.trim()).filter(Boolean);
  const stage = req.body.stage || 'novo';
  const patch = { name: req.body.name || '', tags, stage, notes: req.body.notes || '' };
  bot.updateLead(jid, patch);
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'lead_update', panelUser:req.user.username, jid, patch });
  res.redirect(`/m/lead?jid=${encodeURIComponent(jid)}${req.user.role==='admin'?`&botId=${botId}`:''}`);
});

// ------- dashboard -------
app.get('/m/dashboard', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const leads = Object.values(snap.leads || {});
  const byStage = {};
  for (const l of leads) {
    const s = l.stage || 'novo';
    byStage[s] = (byStage[s]||0) + 1;
  }

  const stages = ['novo','em_negociacao','cotizado','agendado','fechado','perdido','programado'];
  const cards = stages.map(s=>`
    <div class="card">
      <div style="font-weight:900;font-size:1.1rem">${byStage[s]||0}</div>
      <div class="muted">${htmlEscape(stageLabel(s))}</div>
    </div>`).join('');

  // simple conversion metrics
  const total = leads.length || 0;
  const ag = byStage['agendado']||0;
  const fe = byStage['fechado']||0;
  const ct = byStage['cotizado']||0;

  const body = `
    <div class="card">
      <div style="font-weight:800">Dashboard (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Resumo por stage (pipeline). Próximo passo: comparar vendedores e meses.</div>
    </div>
    <div class="grid2">${cards}</div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Conversão (base atual de leads)</div>
      <div class="muted">Total leads: ${total}</div>
      <div class="muted">Cotizados: ${ct} (${total?Math.round((ct/total)*100):0}%)</div>
      <div class="muted">Agendados: ${ag} (${total?Math.round((ag/total)*100):0}%)</div>
      <div class="muted">Fechados: ${fe} (${total?Math.round((fe/total)*100):0}%)</div>
    </div>
  `;
  res.send(layoutMobile({ title:'Dashboard', user:req.user, bodyHtml: body }));
});

// ------- commands -------
app.get('/m/commands', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const c = snap.config?.commands || {};

  const body = `
    <div class="card">
      <div style="font-weight:800">Comandos (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Editável. Use no WhatsApp (mensagem enviada por você) para acionar ações.</div>
      <form method="POST" action="/m/commands${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>STOP (bloquear definitivo)</label><input name="stop" value="${htmlEscape(c.stop||'')}" />
        <label>PAUSE (pausar 72h)</label><input name="pause" value="${htmlEscape(c.pause||'')}" />
        <label>CLIENTE (pós-venda)</label><input name="client" value="${htmlEscape(c.client||'')}" />
        <label>REMOVE (sacar do funil sem bloquear)</label><input name="remove" value="${htmlEscape(c.remove||'')}" />
        <label>BOT OFF 24h</label><input name="botOff" value="${htmlEscape(c.botOff||'')}" />
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar comandos</button>
      </form>
    </div>`;
  res.send(layoutMobile({ title:'Comandos', user:req.user, bodyHtml: body }));
});

app.post('/m/commands', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  bot.setCommands(req.body || {});
  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_commands', panelUser:req.user.username });
  res.redirect(`/m/commands${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- rules -------
app.get('/m/rules', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];
  const snap = bot.getDataSnapshot();
  const rules = snap.config?.rules || {};
  const window = snap.config?.window || {};
  const limits = snap.config?.limits || {};

  const body = `
    <div class="card">
      <div style="font-weight:800">Regras (${htmlEscape(botId.toUpperCase())})</div>
      <form method="POST" action="/m/rules${req.user.role==='admin'?`?botId=${botId}`:''}">
        <label>Ano mínimo para fazer funil</label>
        <input name="minYearFollowUp" type="number" value="${htmlEscape(rules.minYearFollowUp ?? 2022)}"/>
        <div class="grid2">
          <div>
            <label>Janela início (hora)</label>
            <input name="startHour" type="number" value="${htmlEscape(window.startHour ?? 9)}"/>
          </div>
          <div>
            <label>Janela fim (hora)</label>
            <input name="endHour" type="number" value="${htmlEscape(window.endHour ?? 22)}"/>
          </div>
        </div>
        <div class="grid2">
          <div><label>Limite por minuto</label><input name="perMinute" type="number" value="${htmlEscape(limits.perMinute ?? 8)}"/></div>
          <div><label>Limite por hora</label><input name="perHour" type="number" value="${htmlEscape(limits.perHour ?? 120)}"/></div>
          <div><label>Limite por dia</label><input name="perDay" type="number" value="${htmlEscape(limits.perDay ?? 400)}"/></div>
          <div><label>Por contato/dia</label><input name="perContactPerDay" type="number" value="${htmlEscape(limits.perContactPerDay ?? 2)}"/></div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar regras</button>
      </form>
      <div class="muted" style="margin-top:10px">Se ano detectado &lt; mínimo: não entra no funil, mas registra estatística em events.json.</div>
    </div>`;
  res.send(layoutMobile({ title:'Regras', user:req.user, bodyHtml: body }));
});

app.post('/m/rules', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId)) return res.status(403).send('forbidden');
  const bot = bots[botId];

  const minYearFollowUp = Number(req.body.minYearFollowUp || 2022);
  const startHour = Number(req.body.startHour || 9);
  const endHour = Number(req.body.endHour || 22);

  bot.updateConfig({
    rules: { minYearFollowUp },
    window: { startHour, endHour },
    limits: {
      perMinute: Number(req.body.perMinute || 8),
      perHour: Number(req.body.perHour || 120),
      perDay: Number(req.body.perDay || 400),
      perContactPerDay: Number(req.body.perContactPerDay || 2),
    }
  });

  appendEvent({ botId, ts: Date.now(), iso: new Date().toISOString(), action:'update_rules', panelUser:req.user.username });
  res.redirect(`/m/rules${req.user.role==='admin'?`?botId=${botId}`:''}`);
});

// ------- stats -------
function inRange(ts, fromTs, toTs) {
  if (fromTs && ts < fromTs) return false;
  if (toTs && ts > toTs) return false;
  return true;
}
app.get('/m/stats', requireAuth, (req,res)=>{
  const botId = getSelectedBotId(req);
  if (!allowedBotIds(req.user).includes(botId) && req.user.role !== 'admin') return res.status(403).send('forbidden');

  const from = req.query.from || '';
  const to = req.query.to || '';
  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : null;
  const toTs = to ? new Date(to + 'T23:59:59').getTime() : null;

  const events = loadJSON(EVENTS_FILE, []);
  const rows = events
    .filter(e => e.action === 'inbound_message')
    .filter(e => req.user.role === 'admin' ? (botId ? e.botId === botId : true) : e.botId === botId)
    .filter(e => inRange(Number(e.ts||0), fromTs, toTs));

  const rulesK = bots[botId].getConfig()?.rules || { minYearFollowUp: 2022 };
  const minYearK = Number(rulesK.minYearFollowUp || 2022);
  const leadsK = bots[botId].getLeads();
  let belowK=0, aboveK=0;
  for (const lead of Object.values(leadsK||{})) {
    const y = Number(lead.year||0);
    if (!y) continue;
    if (y < minYearK) belowK++; else aboveK++;
  }
  const eventsK = loadJSON(EVENTS_FILE, []);
  const sentK = eventsK.filter(e=>e.botId=== botId && e.action==='auto_sent').length;

  const byYear = {};
  const byModel = {};
  for (const e of rows) {
    const y = e.year || 'SEM_ANO';
    byYear[y] = (byYear[y] || 0) + 1;
    const m = e.model || 'SEM_MODELO';
    byModel[m] = (byModel[m] || 0) + 1;
  }

  const yearTable = Object.entries(byYear).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))).map(([k,v])=>`<tr><td>${htmlEscape(k)}</td><td>${v}</td></tr>`).join('');
  const modelTable = Object.entries(byModel).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([k,v])=>`<tr><td>${htmlEscape(k)}</td><td>${v}</td></tr>`).join('');

  const body = `
    <div class="card">
      <div style="font-weight:800">Estatísticas (${htmlEscape(botId.toUpperCase())})</div>
      <div class="muted">Filtra por período e mostra quantos clientes escreveram por ano/modelo (quando detectado).</div>
      <form method="GET" action="/m/stats">
        ${req.user.role==='admin' ? `
        <label>Bot</label>
        <select name="botId">
          ${BOT_IDS.map(id=>`<option value="${id}" ${id===botId?'selected':''}>${id.toUpperCase()}</option>`).join('')}
        </select>` : ``}
        <div class="grid2">
          <div><label>De</label><input name="from" type="date" value="${htmlEscape(from)}"/></div>
          <div><label>Até</label><input name="to" type="date" value="${htmlEscape(to)}"/></div>
        </div>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Aplicar</button>
      </form>

      <div class="card" style="border:1px solid rgba(250,204,21,.25)">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div><div class="muted">Mensagens (auto, total)</div><div style="font-size:22px;font-weight:900">${sentK}</div></div>
          <div><div class="muted">Carros &lt; ${minYearK}</div><div style="font-size:22px;font-weight:900">${belowK}</div></div>
          <div><div class="muted">Carros ≥ ${minYearK}</div><div style="font-size:22px;font-weight:900">${aboveK}</div></div>
        </div>
        <div class="muted" style="margin-top:6px">Ano mínimo vem de <b>Regras</b> (mude lá e isso atualiza automaticamente).</div>
      </div>

      <div class="muted" style="margin-top:10px">Total mensagens inbound no período: <b>${rows.length}</b></div>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Por ano</div>
      <table style="width:100%"><thead><tr><th>Ano</th><th>Qtd</th></tr></thead><tbody>${yearTable || '<tr><td colspan="2" class="muted">Sem dados</td></tr>'}</tbody></table>
    </div>

    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Top modelos (30)</div>
      <table style="width:100%"><thead><tr><th>Modelo</th><th>Qtd</th></tr></thead><tbody>${modelTable || '<tr><td colspan="2" class="muted">Sem dados</td></tr>'}</tbody></table>
    </div>
  `;
  res.send(layoutMobile({ title:'Estatísticas', user:req.user, bodyHtml: body }));
});

app.get('/m/users', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const users = loadUsers();
  const rows = Object.entries(users).map(([u,v])=>{
    return `<tr>
      <td><b>${htmlEscape(u)}</b></td>
      <td>${htmlEscape(v.role||'seller')}</td>
      <td>${htmlEscape((v.botId||'').toUpperCase())}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <form method="POST" action="/m/users/delete" onsubmit="return confirm('Excluir usuário?')">
          <input type="hidden" name="username" value="${htmlEscape(u)}"/>
          <button class="btn" type="submit" style="background:#ef4444">Excluir</button>
        </form>
      </td>
    </tr>`;
  }).join('');
  const body = `
    <div class="card">
      <div style="font-weight:900">Usuários</div>
      <div class="muted">Admin pode criar/editar vendedores. Cada vendedor vê apenas o seu bot.</div>
    </div>

    <div class="card">
      <div style="font-weight:900;margin-bottom:8px">Criar / Atualizar</div>
      <form method="POST" action="/m/users/upsert">
        <label>Usuário</label><input name="username" placeholder="ex: vendedor1" required/>
        <label>Senha</label><input name="password" placeholder="deixe vazio para manter" />
        <label>Bot</label>
        <select name="botId">
          ${BOT_IDS.map(id=>`<option value="${id}">${id.toUpperCase()}</option>`).join('')}
        </select>
        <label>Role</label>
        <select name="role">
          <option value="seller">seller</option>
          <option value="admin">admin</option>
        </select>
        <button class="btn btn-primary" type="submit" style="margin-top:10px;width:100%">Salvar</button>
      </form>
    </div>

    <div class="card">
      <div style="font-weight:900;margin-bottom:6px">Lista</div>
      <table style="width:100%"><thead><tr><th>Usuário</th><th>Role</th><th>Bot</th><th>Ação</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Sem usuários</td></tr>'}</tbody></table>
    </div>
  `;
  res.send(layoutMobile({ title:'Usuários', user:req.user, bodyHtml: body }));
});

app.post('/m/users/upsert', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const { username, password, botId, role } = req.body || {};
  if (!username) return res.redirect('/m/users');
  if (role && !['admin','seller'].includes(role)) return res.redirect('/m/users');
  if (botId && !BOT_IDS.includes(botId)) return res.redirect('/m/users');
  const users = loadUsers();
  const cur = users[username] || {};
  users[username] = {
    role: role || cur.role || 'seller',
    botId: (role==='admin') ? '*' : (botId || cur.botId || 'v1'),
    pass: (password && String(password).trim()) ? String(password).trim() : (cur.pass || cur.pass || cur.password || '123')
  };
  saveUsers(users);
  res.redirect('/m/users');
});

app.post('/m/users/delete', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const username = req.body.username;
  const users = loadUsers();
  delete users[username];
  saveUsers(users);
  res.redirect('/m/users');
});

// ------- desktop admin (overview) -------
app.get('/admin', requireAuth, async (req,res)=>{
  if (req.user.role !== 'admin') return res.redirect('/m');
  const rows = [];
  for (const id of BOT_IDS) {
    const st = bots[id].getStatus();
    const qrUrl = await qrDataUrl(st.qr);
    rows.push(`
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:18px;font-weight:800">${id.toUpperCase()}</div>
            <div class="muted">Conectado: <b>${st.connected?'SIM':'NÃO'}</b> · Funil: <b>${st.enabled?'ON':'OFF'}</b> · Fila: <b>${st.queueSize}</b></div>
          </div>
          <div class="row">
            <form method="POST" action="/admin/toggle-connect?botId=${id}"><button class="btn ${st.connected?'btn-danger':'btn-primary'}" type="submit">${st.connected?'Desconectar':'Conectar'}</button></form>
            <form method="POST" action="/admin/toggle-enabled?botId=${id}"><button class="btn btn-ghost" type="submit">${st.enabled?'Pausar':'Ativar'}</button></form>
            <a class="btn btn-ghost" style="text-decoration:none" href="/m?botId=${id}">Abrir no mobile</a>
          </div>
        </div>
        ${st.connected ? '' : (qrUrl ? `<div style="margin-top:10px"><img src="${qrUrl}" style="width:220px;border-radius:12px;background:#fff"/></div>` : '')}
      </div>
    `);
  }

  const html = layoutDesktop({
    title: 'Admin · MultiBot',
    bodyHtml: `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:22px;font-weight:900">Admin · MultiBot</div>
            <div class="muted">Gerencia os 5 números. Use volume persistente no Railway para manter sessões.</div>
          </div>
          <div class="row"><a class="btn btn-primary" style="text-decoration:none" href="/m">Ir para mobile</a><a class="btn btn-ghost" style="text-decoration:none" href="/logout">Sair</a></div>
        </div>
      </div>
      ${rows.join('')}
    `
  });
  res.send(html);
});

app.post('/admin/toggle-connect', requireAuth, async (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const botId = req.query.botId;
  if (!BOT_IDS.includes(botId)) return res.redirect('/admin');
  const st = bots[botId].getStatus();
  if (st.connected) {
  if (AUTO_NEW_QR_ON_DISCONNECT) await forceNewQr(botId);
  else await bots[botId].disconnect();
} else {
  await bots[botId].connect();
}
  res.redirect('/admin');
});

app.post('/admin/toggle-enabled', requireAuth, (req,res)=>{
  if (req.user.role !== 'admin') return res.status(403).send('forbidden');
  const botId = req.query.botId;
  if (!BOT_IDS.includes(botId)) return res.redirect('/admin');
  const st = bots[botId].getStatus();
  bots[botId].setEnabled(!st.enabled);
  res.redirect('/admin');
});

// ------- start -------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=>console.log(`✅ MultiBot rodando: http://localhost:${PORT}/m`));

