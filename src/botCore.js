// src/botCore.js — Iron Glass MultiBot (BLINDADO)
// Compatible con tu server.js: createBot({ botId, baseDir, authDir, eventLogger })
// Mantiene API usada por el panel (getStatus, connect, disconnect, etc.)
// Agrega:
// - cooldown real por contacto (PER_CONTACT_GAP_MS)
// - gap global entre envíos (GLOBAL_GAP_MS)
// - rate limit real (perMinute/perHour/perDay/perContactPerDay) con espera (no ráfagas)
// - dedupe inbound (evita doble procesamiento por reconexión)
// - scheduler sin solaparse (no ticks paralelos)
// - limita envíos de agenda: 1 por contacto por tick

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function nowTs(){ return Date.now(); }
function randomInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }

function ensureDir(d){ try{ fs.mkdirSync(d,{recursive:true}); }catch(_){} }

function safeJSONParse(str, fallback){
  try{ return JSON.parse(str); }catch(_){ return fallback; }
}

function loadJSON(file, fallback){
  try{
    if(!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file,'utf8');
    return safeJSONParse(raw, fallback);
  }catch(_){ return fallback; }
}
function saveJSON(file, obj){
  try{
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(obj,null,2),'utf8');
    return true;
  }catch(_){ return false; }
}

// --- simples templating ---
function applyTemplate(tpl, vars){
  return String(tpl||'').replace(/\{\{(\w+)\}\}/g, (_,k)=> String((vars||{})[k] ?? ''));
}

function jidToPhoneKey(jid){
  return String(jid||'').replace('@s.whatsapp.net','').replace(/\D/g,'');
}
function phoneKeyToJid(phoneKey){
  const digits = String(phoneKey||'').replace(/\D/g,'');
  if(!digits) return '';
  const pk = digits.startsWith('55') ? digits : ('55'+digits);
  return pk + '@s.whatsapp.net';
}

// ====== Time window helpers ======
function parseHHMM(s, fallback){
  const m = String(s||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return fallback;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return {hh,mm};
}
function isWithinWindow(windowCfg){
  // soporta tu formato viejo window: {startHour,endHour} y el nuevo {start,end}
  const d = new Date();
  const mins = d.getHours()*60 + d.getMinutes();

  if(windowCfg && typeof windowCfg.startHour === 'number' && typeof windowCfg.endHour === 'number'){
    const s = Math.max(0, Math.min(23, Number(windowCfg.startHour))) * 60;
    const e = Math.max(0, Math.min(23, Number(windowCfg.endHour))) * 60 + 59;
    if (s <= e) return mins >= s && mins <= e;
    return mins >= s || mins <= e;
  }

  const start = parseHHMM(windowCfg?.start, {hh:8,mm:0});
  const end   = parseHHMM(windowCfg?.end,   {hh:20,mm:0});
  const sM = start.hh*60+start.mm;
  const eM = end.hh*60+end.mm;
  if (sM <= eM) return mins >= sM && mins <= eM;
  return mins >= sM || mins <= eM;
}

// ====== Stats keys (LOCAL time) ======
function keyMinute(ts=Date.now()){
  const d=new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}
function keyHour(ts=Date.now()){
  const d=new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}-${d.getHours()}`;
}
function keyDay(ts=Date.now()){
  const d=new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

function defaultConfig(){
  return {
    enabled: true,
    window: { startHour: 9, endHour: 22 },
    limits: { perMinute: 8, perHour: 120, perDay: 400, perContactPerDay: 2 },
    rules: { minYearFollowUp: 2022 },
    commands: { stop:'STOP', pause:'PAUSE', client:'CLIENTE', remove:'REMOVE', botOff:'BOT OFF' },
  };
}

function defaultData(){
  return {
    config: defaultConfig(),
    messagesConfig: {
      step0: 'Olá! 😊',
      step1: 'Tudo bem?',
      agenda0: 'Lembrete: seu agendamento está chegando.',
      agenda1: 'Lembrete (3 dias).',
      agenda2: 'Lembrete (1 dia).',
      confirmTemplate: 'Confirmado: {{DATA}} às {{HORA}}. {{VEICULO}} · {{PRODUTO}}',
    },
    leads: {},
    blocked: {},
    agendas: {},
    scheduledStarts: {},
    counters: { byMinute:{}, byHour:{}, byDay:{}, byContactDay:{} },
    quotesConfig: {
      ironGlass: { template: '🛡️ *Cotização Iron Glass*\\n🚗 {{VEICULO}} {{ANO}}\\n💰 {{VALOR}}\\n💳 {{PAGAMENTO}}' },
      ironGlassPlus: { template: '🛡️ *Cotização Iron Glass Plus*\\n🚗 {{VEICULO}} {{ANO}}\\n💰 {{VALOR}}\\n💳 {{PAGAMENTO}}' },
      defender: { template: '🛡️ *Cotização Defender*\\n🚗 {{VEICULO}} {{ANO}}\\n💰 {{VALOR}}\\n💳 {{PAGAMENTO}}' },
    }
  };
}

// =========================
// createBot (compatible)
// =========================
function createBot({ botId, baseDir, authDir, eventLogger } = {}) {
  const DATA_BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(baseDir || process.cwd(), 'data');
  const BOT_DIR = path.join(DATA_BASE, String(botId||'v1'));
  ensureDir(BOT_DIR);
  ensureDir(authDir || path.join(DATA_BASE,'auth',String(botId||'v1')));

  const FILES = {
    config: path.join(BOT_DIR, 'config.json'),
    messages: path.join(BOT_DIR, 'messages.json'),
    leads: path.join(BOT_DIR, 'leads.json'),
    blocked: path.join(BOT_DIR, 'blocked.json'),
    agendas: path.join(BOT_DIR, 'agendas.json'),
    scheduled: path.join(BOT_DIR, 'programados.json'),
    counters: path.join(BOT_DIR, 'counters.json'),
    quotes: path.join(BOT_DIR, 'quotes.json'),
  };

  const data = defaultData();
  data.config = loadJSON(FILES.config, data.config);
  data.messagesConfig = loadJSON(FILES.messages, data.messagesConfig);
  data.leads = loadJSON(FILES.leads, data.leads);
  data.blocked = loadJSON(FILES.blocked, data.blocked);
  data.agendas = loadJSON(FILES.agendas, data.agendas);
  data.scheduledStarts = loadJSON(FILES.scheduled, data.scheduledStarts);
  data.counters = loadJSON(FILES.counters, data.counters);
  data.quotesConfig = loadJSON(FILES.quotes, data.quotesConfig);

  function saveConfig(){ saveJSON(FILES.config, data.config); }
  function saveMessages(){ saveJSON(FILES.messages, data.messagesConfig); }
  function saveLeads(){ saveJSON(FILES.leads, data.leads); }
  function saveBlocked(){ saveJSON(FILES.blocked, data.blocked); }
  function saveAgendas(){ saveJSON(FILES.agendas, data.agendas); }
  function saveScheduled(){ saveJSON(FILES.scheduled, data.scheduledStarts); }
  function saveCounters(){ saveJSON(FILES.counters, data.counters); }
  function saveQuotes(){ saveJSON(FILES.quotes, data.quotesConfig); }

  function ev(action, payload){
    const evt = { botId, ts: Date.now(), iso: new Date().toISOString(), action, ...(payload||{}) };
    try { eventLogger && eventLogger(evt); } catch(_) {}
  }

  // ====== state ======
  const state = { enabled: !!data.config.enabled, connected:false, qr:null, queueSize:0, lastError:null, lastSendAt:0 };
  function setState(p){ Object.assign(state, p||{}); }

  // ====== lead helpers ======
  function getLead(jid){
    if (!jid) return null;
    if (!data.leads[jid]) {
      data.leads[jid] = {
        jid,
        phoneKey: jidToPhoneKey(jid),
        createdAt: nowTs(),
        updatedAt: nowTs(),
        lastInboundAt: 0,
        lastOutboundAt: 0,
        stepIndex: 0,
        nextAt: null,
        blocked: false,
        pausedUntil: null,
        manualOffUntil: null,
        isClient: false,
        stage: 'novo',
        year: null,
        model: '',
        name: '',
        tags: [],
        notes: ''
      };
      saveLeads();
    }
    return data.leads[jid];
  }

  // ====== queue + blindage ======
  const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 1500);
  const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 3000);
  const PER_CONTACT_GAP_MS = Number(process.env.PER_CONTACT_GAP_MS || 60000);
  const GLOBAL_GAP_MS = Number(process.env.GLOBAL_GAP_MS || 2500);
  const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 10*60*1000);
  const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 5000);

  // cola global
  let q = Promise.resolve();
  let qCount = 0;

  // cooldown per contact
  const nextContactAt = new Map();

  // dedupe inbound
  const recentMsg = new Map();

  function enqueue(task){
    qCount += 1;
    setState({ queueSize: qCount });

    q = q.then(async ()=>{
      try { return await task(); }
      finally {
        qCount = Math.max(0, qCount-1);
        setState({ queueSize: qCount });
      }
    }).catch(e=>{
      setState({ lastError: String(e?.message || e) });
      ev('queue_error', { error: String(e?.message||e) });
    });

    return q;
  }

  function pruneCounters(){
    const now = Date.now();
    const keepM = new Set([keyMinute(now), keyMinute(now-60000), keyMinute(now-120000), keyMinute(now-180000)]);
    for (const k of Object.keys(data.counters.byMinute||{})) if(!keepM.has(k)) delete data.counters.byMinute[k];

    const keepH = new Set([keyHour(now), keyHour(now-3600000), keyHour(now-7200000)]);
    for (const k of Object.keys(data.counters.byHour||{})) if(!keepH.has(k)) delete data.counters.byHour[k];

    const keepD = new Set([keyDay(now), keyDay(now-86400000), keyDay(now-2*86400000)]);
    for (const k of Object.keys(data.counters.byDay||{})) if(!keepD.has(k)) delete data.counters.byDay[k];

    for (const k of Object.keys(data.counters.byContactDay||{})) {
      const day = k.split('|')[0];
      if (!keepD.has(day)) delete data.counters.byContactDay[k];
    }
  }

  function canSendNow(jid){
    pruneCounters();

    if (!state.enabled) return { ok:false, reason:'disabled' };
    if (!isWithinWindow(data.config.window || {})) return { ok:false, reason:'outside_window' };

    const limits = data.config.limits || {};
    const ts = Date.now();
    const km = keyMinute(ts), kh=keyHour(ts), kd=keyDay(ts);
    const kcd = `${kd}|${jid}`;

    const perMinute = data.counters.byMinute[km] || 0;
    const perHour = data.counters.byHour[kh] || 0;
    const perDay = data.counters.byDay[kd] || 0;
    const perContactDay = data.counters.byContactDay[kcd] || 0;

    if (perMinute >= Number(limits.perMinute || 8)) return { ok:false, reason:'limit_minute' };
    if (perHour >= Number(limits.perHour || 120)) return { ok:false, reason:'limit_hour' };
    if (perDay >= Number(limits.perDay || 400)) return { ok:false, reason:'limit_day' };
    if (perContactDay >= Number(limits.perContactPerDay || 2)) return { ok:false, reason:'limit_contact_day' };

    return { ok:true };
  }

  function markSendCounter(jid){
    const ts = Date.now();
    const km = keyMinute(ts), kh=keyHour(ts), kd=keyDay(ts);
    const kcd = `${kd}|${jid}`;
    data.counters.byMinute[km] = (data.counters.byMinute[km]||0)+1;
    data.counters.byHour[kh] = (data.counters.byHour[kh]||0)+1;
    data.counters.byDay[kd] = (data.counters.byDay[kd]||0)+1;
    data.counters.byContactDay[kcd] = (data.counters.byContactDay[kcd]||0)+1;
    saveCounters();
  }

  async function waitForLimits(jid){
    while(true){
      const c = canSendNow(jid);
      if (c.ok) return;
      if (c.reason === 'disabled') { await sleep(15000); continue; }
      if (c.reason === 'outside_window') { await sleep(60000); continue; }
      if (c.reason === 'limit_minute') { await sleep(30000); continue; }
      if (c.reason === 'limit_hour') { await sleep(5*60*1000); continue; }
      if (c.reason === 'limit_day' || c.reason === 'limit_contact_day') { await sleep(30*60*1000); continue; }
      await sleep(10000);
    }
  }

  // ====== WhatsApp socket ======
  let sock = null;
  let connecting = false;
  let manualDisconnect = false;

  function dedupeSeen(msgId){
    if(!msgId) return false;
    const now = Date.now();
    for (const [k,ts] of recentMsg.entries()){
      if (now - ts > DEDUPE_TTL_MS) recentMsg.delete(k);
    }
    if (recentMsg.has(msgId)) return true;
    recentMsg.set(msgId, now);
    return false;
  }

  async function sendTextSafe(jid, text, meta={}){
    if (!sock || !state.connected) return { ok:false, error:'not_connected' };
    if (!jid) return { ok:false, error:'no_jid' };

    const lead = getLead(jid);
    if (lead?.blocked) return { ok:false, error:'blocked' };
    if (lead?.isClient && meta?.followup) return { ok:false, error:'is_client' };
    if (lead?.pausedUntil && Date.now() < Number(lead.pausedUntil)) return { ok:false, error:'paused' };
    if (lead?.manualOffUntil && Date.now() < Number(lead.manualOffUntil)) return { ok:false, error:'manual_off' };

    return enqueue(async ()=>{
      await waitForLimits(jid);

      // cooldown por contacto
      const nc = nextContactAt.get(jid) || 0;
      const waitC = Math.max(0, nc - Date.now());
      if (waitC > 0) await sleep(waitC);

      // gap global
      const waitG = Math.max(0, (state.lastSendAt + GLOBAL_GAP_MS) - Date.now());
      if (waitG > 0) await sleep(waitG);

      // delay humano
      await sleep(randomInt(MIN_DELAY_MS, MAX_DELAY_MS));

      try{
        await sock.sendMessage(jid, { text: String(text||'') });

        // contadores SOLO al enviar de verdad
        markSendCounter(jid);

        state.lastSendAt = Date.now();
        nextContactAt.set(jid, Date.now() + PER_CONTACT_GAP_MS);

        lead.lastOutboundAt = nowTs();
        lead.updatedAt = nowTs();
        data.leads[jid] = lead;
        saveLeads();

        ev('auto_sent', { jid, phoneKey: lead.phoneKey, meta, len: String(text||'').length });
        return { ok:true };
      }catch(e){
        const msg = String(e?.message || e);
        setState({ lastError: msg });
        ev('send_error', { jid, error: msg, meta });
        return { ok:false, error: msg };
      }
    });
  }

  // ====== Scheduler (no overlap) ======
  let schedulerHandle = null;
  let schedulerRunning = false;

  function stepKeys(){
    const keys = Object.keys(data.messagesConfig||{}).filter(k => /^step\d+$/i.test(k));
    keys.sort((a,b)=> Number(a.replace(/\D/g,'')) - Number(b.replace(/\D/g,'')));
    return keys;
  }

  async function processScheduledStarts(now){
    const entries = Object.entries(data.scheduledStarts||{});
    for (const [jid, obj] of entries){
      if (!obj?.at) continue;
      if (now < Number(obj.at)) continue;

      const lead = getLead(jid);
      if (!lead) continue;

      const txt = String(obj.text || '').trim();
      if (txt) await sendTextSafe(jid, txt, { step:'programado', program:true });

      lead.stage = 'novo';
      lead.stepIndex = 0;
      lead.nextAt = now + 5*60*1000;
      lead.updatedAt = nowTs();
      data.leads[jid]=lead;

      delete data.scheduledStarts[jid];
      saveScheduled();
      saveLeads();
      ev('program_start_sent', { jid, phoneKey: lead.phoneKey });
    }
  }

  async function processAgendas(now){
    for (const [jid, arr] of Object.entries(data.agendas||{})){
      if (!Array.isArray(arr) || !arr.length) continue;

      let sentOne = false;
      for (const ag of arr){
        if (!ag?.at || ag.sent) continue;
        if (!sentOne && now >= Number(ag.at)){
          const key = ag.key || 'agenda0';
          const tpl = data.messagesConfig[key] || data.messagesConfig.agenda0 || '';
          const text = applyTemplate(tpl, ag.data || {});
          const out = await sendTextSafe(jid, text, { step:key, agenda:true });
          if (out.ok){
            ag.sent = true;
            ag.sentAt = nowTs();
            sentOne = true;
            ev('agenda_sent', { jid, key });
          }
        }
      }

      data.agendas[jid] = arr.filter(x => !x.sent || (Date.now() - Number(x.at||0) < 7*24*60*60*1000));
    }
    saveAgendas();
  }

  async function processFollowUps(now){
    const keys = stepKeys();
    if (!keys.length) return;

    for (const lead of Object.values(data.leads||{})){
      if (!lead?.jid) continue;
      if (lead.blocked) continue;
      if (lead.isClient) continue;
      if (lead.pausedUntil && now < Number(lead.pausedUntil)) continue;
      if (lead.manualOffUntil && now < Number(lead.manualOffUntil)) continue;
      if (!lead.nextAt || now < Number(lead.nextAt)) continue;

      const minYear = Number(data.config.rules?.minYearFollowUp || 2022);
      if (lead.year && Number(lead.year) < minYear) continue;

      const idx = Number(lead.stepIndex||0);
      const key = keys[idx];
      if (!key) continue;

      const tpl = data.messagesConfig[key] || '';
      const text = applyTemplate(tpl, lead);

      const out = await sendTextSafe(lead.jid, text, { step:key, followup:true });
      if (out.ok){
        lead.stepIndex = idx+1;
        lead.updatedAt = nowTs();

        const cadence = (data.config.cadenceDays || [3,5,7,15,30]);
        const days = Number(cadence[Math.min(idx, cadence.length-1)] || 3);
        lead.nextAt = Date.now() + days*24*60*60*1000;

        data.leads[lead.jid]=lead;
        saveLeads();
      }
    }
  }

  async function schedulerTick(){
    if (schedulerRunning) return;
    schedulerRunning = true;
    try{
      const now = Date.now();
      await processScheduledStarts(now);
      await processAgendas(now);
      await processFollowUps(now);
    }finally{
      schedulerRunning = false;
    }
  }

  function startScheduler(){
    if (schedulerHandle) clearInterval(schedulerHandle);
    schedulerHandle = setInterval(()=>{ schedulerTick().catch(()=>{}); }, SCHEDULER_TICK_MS);
  }

  // ====== connect/disconnect ======
  async function connect(){
    if (connecting) return;
    if (sock && state.connected) return;

    connecting = true;
    manualDisconnect = false;

    try{
      const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        auth: authState,
        browser: ['Iron Glass', 'Chrome', '1.0.0'],
        markOnlineOnConnect: String(process.env.MARK_ONLINE_ON_CONNECT||'false') === 'true'
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (u)=>{
        const { connection, qr, lastDisconnect } = u || {};
        if (qr) setState({ qr, connected:false });
        if (connection === 'open'){
          setState({ connected:true, qr:null, lastError:null });
          ev('wa_open', {});
        }
        if (connection === 'close'){
          setState({ connected:false });
          const code = lastDisconnect?.error?.output?.statusCode;
          ev('wa_close', { code });

          if (!manualDisconnect && code !== DisconnectReason.loggedOut){
            setTimeout(()=>connect().catch(()=>{}), 2500);
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type })=>{
        if (type !== 'notify') return;

        for (const msg of (messages||[])){
          const jid = msg?.key?.remoteJid;
          if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;

          const msgId = msg?.key?.id;
          if (dedupeSeen(msgId)) continue;

          const fromMe = !!msg?.key?.fromMe;

          const text =
            msg?.message?.conversation ||
            msg?.message?.extendedTextMessage?.text ||
            msg?.message?.imageMessage?.caption ||
            msg?.message?.videoMessage?.caption ||
            '';

          if (!text) continue;

          const lead = getLead(jid);
          if (!lead) continue;

          if (!fromMe) {
            lead.lastInboundAt = nowTs();
            lead.updatedAt = nowTs();
            data.leads[jid]=lead;
            saveLeads();

            ev('inbound_message', {
              jid,
              phoneKey: lead.phoneKey,
              text: String(text).slice(0,180),
              model: lead.model || '',
              year: lead.year || ''
            });

            const c = data.config.commands || {};
            const txt = String(text||'').trim().toUpperCase();
            if (c.stop && txt === String(c.stop).trim().toUpperCase()) {
              blockFollowUp(jid, lead.phoneKey, 'cmd_stop');
            } else if (c.pause && txt === String(c.pause).trim().toUpperCase()) {
              pauseFollowUp(jid, 72*60*60*1000);
            } else if (c.client && txt === String(c.client).trim().toUpperCase()) {
              markAsClient(jid);
            } else if (c.remove && txt === String(c.remove).trim().toUpperCase()) {
              stopFollowUp(jid);
            } else if (c.botOff && txt === String(c.botOff).trim().toUpperCase()) {
              setManualOff(jid, 24*60*60*1000);
            }
          }
        }
      });

      startScheduler();
    } catch(e){
      setState({ lastError: String(e?.message||e), connected:false });
      ev('connect_error', { error: String(e?.message||e) });
    } finally {
      connecting = false;
    }
  }

  async function disconnect(){
    manualDisconnect = true;
    try { sock?.end?.(new Error('manual_disconnect')); } catch(_) {}
    try { sock?.ws?.close?.(); } catch(_) {}
    sock = null;
    setState({ connected:false });
  }

  // ====== API methods used by server.js ======
  function getStatus(){ return { ...state, botId }; }
  function setEnabled(v){ setState({ enabled: !!v }); data.config.enabled = !!v; saveConfig(); }
  function getConfig(){ return JSON.parse(JSON.stringify(data.config)); }
  function getLeads(){ return data.leads || {}; }

  function getDataSnapshot(){
    return {
      config: data.config,
      messagesConfig: data.messagesConfig,
      leads: data.leads,
      blocked: data.blocked,
      scheduledStarts: data.scheduledStarts,
      agendas: data.agendas,
      quotesConfig: data.quotesConfig,
    };
  }

  function updateMessages(patch={}){
    data.messagesConfig = { ...(data.messagesConfig||{}), ...(patch||{}) };
    saveMessages();
    ev('update_messages', {});
    return true;
  }

  function updateConfig(patch={}){
    data.config = {
      ...(data.config||{}),
      ...(patch||{}),
      window: { ...(data.config.window||{}), ...((patch||{}).window||{}) },
      limits: { ...(data.config.limits||{}), ...((patch||{}).limits||{}) },
      rules: { ...(data.config.rules||{}), ...((patch||{}).rules||{}) },
      commands: { ...(data.config.commands||{}), ...((patch||{}).commands||{}) },
    };
    saveConfig();
    ev('update_config', {});
    return true;
  }

  function setCommands(cmds={}){
    data.config.commands = { ...(data.config.commands||{}), ...(cmds||{}) };
    saveConfig();
    ev('update_commands', {});
    return true;
  }

  function updateQuotes(nextQuotes={}){
    data.quotesConfig = { ...(data.quotesConfig||{}), ...(nextQuotes||{}) };
    saveQuotes();
    ev('update_quotes', {});
    return true;
  }

  function updateLead(jid, patch={}){
    if(!jid) return false;
    const lead = getLead(jid);
    data.leads[jid] = { ...(lead||{}), ...(patch||{}), updatedAt: nowTs() };
    saveLeads();
    ev('lead_update', { jid });
    return true;
  }

  function pauseFollowUp(jid, ms){
    const lead = getLead(jid);
    lead.pausedUntil = Date.now() + Number(ms||0);
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();
    ev('pause_followup', { jid, phoneKey: lead.phoneKey, ms });
  }

  function stopFollowUp(jid){
    const lead = getLead(jid);
    lead.stage = 'perdido';
    lead.pausedUntil = Date.now() + 365*24*60*60*1000;
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();
    ev('stop_followup', { jid, phoneKey: lead.phoneKey });
  }

  function setManualOff(jid, ms){
    const lead = getLead(jid);
    lead.manualOffUntil = Date.now() + Number(ms||0);
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();
    ev('manual_off', { jid, phoneKey: lead.phoneKey, ms });
  }

  function blockFollowUp(jid, phone, reason='manual'){
    const lead = getLead(jid);
    lead.blocked = true;
    lead.stage = 'perdido';
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;

    const pk = phone || lead.phoneKey || jidToPhoneKey(jid);
    data.blocked[pk] = { ts: nowTs(), iso: new Date().toISOString(), reason, jid };
    saveLeads();
    saveBlocked();
    ev('blocked', { jid, phoneKey: lead.phoneKey, reason });
  }

  function markAsClient(jid){
    const lead = getLead(jid);
    lead.isClient = true;
    lead.stage = 'fechado';
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();
    ev('mark_client', { jid, phoneKey: lead.phoneKey });
  }

  // ====== Agenda / Programados / Quote API ======
  function programStartMessage(phoneKey, date, time='09:00', text=''){
    const jid = phoneKeyToJid(phoneKey);
    if(!jid) return false;
    const at = new Date(`${date}T${time}:00`).getTime();
    data.scheduledStarts[jid] = { at, text: String(text||'') };
    const lead = getLead(jid);
    lead.stage = 'programado';
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();
    saveScheduled();
    ev('program_start_set', { jid, phoneKey: lead.phoneKey, at });
    return true;
  }

  function scheduleAgendaFromPanel(phoneKey, date, time, tplData={}){
    const jid = phoneKeyToJid(phoneKey);
    if(!jid) return false;
    const baseTs = new Date(`${date}T${time}:00`).getTime();
    const oneDay = 24*60*60*1000;

    data.agendas[jid] = [
      { key:'agenda0', at: baseTs - 7*oneDay, data: tplData, sent:false },
      { key:'agenda1', at: baseTs - 3*oneDay, data: tplData, sent:false },
      { key:'agenda2', at: baseTs - 1*oneDay, data: tplData, sent:false },
    ].filter(x => x.at > Date.now()-oneDay);

    const lead = getLead(jid);
    lead.stage='agendado';
    lead.updatedAt=nowTs();
    data.leads[jid]=lead;

    saveLeads();
    saveAgendas();
    ev('agenda_programada', { jid, phoneKey: lead.phoneKey, baseTs });
    return true;
  }

  async function sendConfirmNow(phoneKey, tplData={}){
    const jid = phoneKeyToJid(phoneKey);
    if(!jid) return { ok:false, error:'bad_phone' };

    const tpl = data.messagesConfig.confirmTemplate || '';
    const text = applyTemplate(tpl, {
      DATA: tplData.DATA || '',
      HORA: tplData.HORA || '',
      VEICULO: tplData.VEICULO || '',
      PRODUTO: tplData.PRODUTO || '',
      VALOR: tplData.VALOR || '',
      SINAL: tplData.SINAL || '',
      PAGAMENTO: tplData.PAGAMENTO || '',
    });
    return sendTextSafe(jid, text, { step:'confirmTemplate', agenda:true });
  }

  function cancelAgenda(jid){
    if(!jid) return false;
    delete data.agendas[jid];
    saveAgendas();
    ev('agenda_cancelada', { jid });
    return true;
  }

  async function sendQuoteNow(phoneKey, payload={}){
    const jid = phoneKeyToJid(phoneKey);
    if(!jid) return { ok:false, error:'bad_phone' };

    const lead = getLead(jid);
    if (payload.vehicle) lead.model = String(payload.vehicle);
    if (payload.year) lead.year = Number(payload.year);
    lead.stage = 'cotizado';
    lead.updatedAt = nowTs();
    data.leads[jid]=lead;
    saveLeads();

    const key = payload.productKey || 'ironGlassPlus';
    const q = data.quotesConfig[key] || data.quotesConfig.ironGlassPlus;
    const tpl = q?.template || '';

    const text = applyTemplate(tpl, {
      VEICULO: payload.vehicle || lead.model || '',
      ANO: payload.year || lead.year || '',
      VALOR: payload.value || '',
      PAGAMENTO: payload.payment || '',
    });

    return sendTextSafe(jid, text, { step:`quote_${key}` });
  }

  return {
    connect,
    disconnect,

    getStatus,
    setEnabled,
    getConfig,
    getLeads,
    getDataSnapshot,

    updateMessages,
    updateConfig,
    setCommands,
    updateQuotes,

    updateLead,
    pauseFollowUp,
    stopFollowUp,
    setManualOff,
    blockFollowUp,
    markAsClient,

    scheduleAgendaFromPanel,
    sendConfirmNow,
    cancelAgenda,
    programStartMessage,
    sendQuoteNow,
  };
}

module.exports = { createBot };
