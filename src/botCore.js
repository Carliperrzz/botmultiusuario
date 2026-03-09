// botCore.js — Iron Glass WhatsApp Bot (BLINDADO)
// - Cola global + cooldown global
// - Cola/cooldown por contacto (1 min real configurable)
// - Dedupe de mensajes entrantes (evita doble procesamiento por reconexión)
// - Scheduler sin solaparse (no corre ticks en paralelo)
// - Stats por hora local (TZ=America/Sao_Paulo)
// - Límites por minuto/hora/día y por contacto/día: si se alcanza, ESPERA (no dispara ráfagas)

'use strict';

const path = require('path');
const fs = require('fs');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

// Ajustá estos imports a tus utils reales:
const {
  loadJSON, saveJSON,
  applyTemplate,
  normalizePhoneKeyFromJid,
} = require('./utils');

// ==========================
// ENV / FLAGS
// ==========================
const SILENT_MODE = String(process.env.SILENT_MODE || 'true') === 'true';
const MARK_ONLINE = String(process.env.MARK_ONLINE_ON_CONNECT || 'false') === 'true';
const READ_INBOUND_MESSAGES = String(process.env.READ_INBOUND_MESSAGES || 'false') === 'true';
const SEND_PRESENCE_UPDATES = String(process.env.SEND_PRESENCE_UPDATES || 'false') === 'true';

// Delays “humanos”
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 1500);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 3000);

// Blindaje (recomendado)
const PER_CONTACT_GAP_MS = Number(process.env.PER_CONTACT_GAP_MS || 60000); // 1 minuto real por contacto
const GLOBAL_GAP_MS = Number(process.env.GLOBAL_GAP_MS || 2500);            // gap global entre cualquier envío
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 10 * 60 * 1000);  // 10 min

// Scheduler
const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 5000);

// Ventana (si tu config no trae, esto es fallback)
const DEFAULT_WINDOW = { start: '08:00', end: '20:00' };

// ==========================
// Helpers
// ==========================
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function nowTs() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function parseHHMM(s, fallback) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return { hh, mm };
}

function isWithinWindow(windowCfg) {
  const w = windowCfg && windowCfg.start && windowCfg.end ? windowCfg : DEFAULT_WINDOW;
  const start = parseHHMM(w.start, { hh: 8, mm: 0 });
  const end = parseHHMM(w.end, { hh: 20, mm: 0 });

  const d = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const startM = start.hh * 60 + start.mm;
  const endM = end.hh * 60 + end.mm;

  if (startM <= endM) return mins >= startM && mins <= endM;
  // ventana cruza medianoche
  return mins >= startM || mins <= endM;
}

// ==========================
// Data files
// ==========================
function makeFiles(dataDir) {
  return {
    config: path.join(dataDir, 'config.json'),
    messages: path.join(dataDir, 'messages.json'),
    leads: path.join(dataDir, 'leads.json'),
    agendas: path.join(dataDir, 'agendas.json'),
    scheduled: path.join(dataDir, 'scheduledStarts.json'),
    counters: path.join(dataDir, 'counters.json'),
    events: path.join(dataDir, 'events.json'),
  };
}

function defaultCounters() {
  return {
    byMinute: {},
    byHour: {},
    byDay: {},
    byContactDay: {},
  };
}

function defaultConfig() {
  return {
    enabled: true,
    window: DEFAULT_WINDOW,
    limits: {
      perMinute: 8,
      perHour: 120,
      perDay: 400,
      perContactPerDay: 2,
    },
    rules: {
      minYearFollowUp: 2022
    }
  };
}

function defaultMessages() {
  return {
    // ejemplo:
    agenda0: 'Olá! Lembrete do seu agendamento.',
  };
}

// ==========================
// Bot Factory
// ==========================
function createBot(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
  const authDir = opts.authDir || path.join(process.cwd(), 'auth');

  ensureDir(dataDir);
  ensureDir(authDir);

  const FILES = makeFiles(dataDir);

  const data = {
    config: loadJSON(FILES.config, defaultConfig()),
    messagesConfig: loadJSON(FILES.messages, defaultMessages()),
    leads: loadJSON(FILES.leads, {}),
    agendas: loadJSON(FILES.agendas, {}),
    scheduledStarts: loadJSON(FILES.scheduled, {}),
    counters: loadJSON(FILES.counters, defaultCounters()),
    events: loadJSON(FILES.events, []),
  };

  // ==========================
  // State
  // ==========================
  let sock = null;
  let connecting = false;
  let manualDisconnect = false;

  const state = {
    enabled: true,
    connected: false,
    qr: null,
    lastError: null,
    queueSize: 0,
    lastSendAt: 0,
  };

  function setState(patch) { Object.assign(state, patch); }

  // ==========================
  // Persistence helpers
  // ==========================
  function saveConfig() { saveJSON(FILES.config, data.config); }
  function saveMessages() { saveJSON(FILES.messages, data.messagesConfig); }
  function saveLeads() { saveJSON(FILES.leads, data.leads); }
  function saveAgendas() { saveJSON(FILES.agendas, data.agendas); }
  function saveScheduled() { saveJSON(FILES.scheduled, data.scheduledStarts); }
  function saveCounters() { saveJSON(FILES.counters, data.counters); }
  function saveEvents() { saveJSON(FILES.events, data.events); }

  function ev(type, payload) {
    data.events.push({ at: nowTs(), type, payload: payload || {} });
    // recorte para no crecer infinito:
    if (data.events.length > 2000) data.events.splice(0, data.events.length - 2000);
    saveEvents();
  }

  // ==========================
  // Lead helpers
  // ==========================
  function getLead(jid) {
    if (!data.leads[jid]) {
      data.leads[jid] = {
        jid,
        phoneKey: normalizePhoneKeyFromJid ? normalizePhoneKeyFromJid(jid) : jid,
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
        year: null,
        model: '',
      };
      saveLeads();
    }
    return data.leads[jid];
  }

  // ==========================
  // Queue + rate limit (BLINDADO)
  // ==========================
  let sendQueue = Promise.resolve();
  let queueCount = 0;

  // per-contact next allowed time
  const contactNextAt = new Map();

  // dedupe inbound
  const recentMsg = new Map(); // id -> ts

  function enqueue(task) {
    queueCount += 1;
    setState({ queueSize: queueCount });

    sendQueue = sendQueue.then(async () => {
      try {
        return await task();
      } finally {
        queueCount = Math.max(0, queueCount - 1);
        setState({ queueSize: queueCount });
      }
    });

    // No tragues errores silenciosamente:
    sendQueue = sendQueue.catch((e) => {
      setState({ lastError: String(e?.message || e) });
      ev('queue_error', { error: String(e?.message || e) });
    });

    return sendQueue;
  }

  // ===== Keys (LOCAL TIME) =====
  function keyMinute(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
  }
  function keyHour(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}-${d.getHours()}`;
  }
  function keyDay(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  }

  function pruneCounters() {
    const now = Date.now();
    const keepM = new Set([keyMinute(now), keyMinute(now-60000), keyMinute(now-120000), keyMinute(now-180000)]);
    for (const k of Object.keys(data.counters.byMinute)) if (!keepM.has(k)) delete data.counters.byMinute[k];

    const keepH = new Set([keyHour(now), keyHour(now-3600000), keyHour(now-7200000)]);
    for (const k of Object.keys(data.counters.byHour)) if (!keepH.has(k)) delete data.counters.byHour[k];

    const keepD = new Set([keyDay(now), keyDay(now-86400000), keyDay(now-2*86400000)]);
    for (const k of Object.keys(data.counters.byDay)) if (!keepD.has(k)) delete data.counters.byDay[k];

    for (const k of Object.keys(data.counters.byContactDay)) {
      const day = k.split('|')[0];
      if (!keepD.has(day)) delete data.counters.byContactDay[k];
    }
  }

  function canSendNow(jid) {
    pruneCounters();

    if (!isWithinWindow(data.config.window || {})) return { ok: false, reason: 'outside_window' };

    const limits = data.config.limits || {};
    const ts = Date.now();
    const km = keyMinute(ts), kh = keyHour(ts), kd = keyDay(ts);
    const kcd = `${kd}|${jid}`;

    const perMinute = data.counters.byMinute[km] || 0;
    const perHour = data.counters.byHour[kh] || 0;
    const perDay = data.counters.byDay[kd] || 0;
    const perContactDay = data.counters.byContactDay[kcd] || 0;

    if (perMinute >= Number(limits.perMinute || 8)) return { ok: false, reason: 'limit_minute' };
    if (perHour >= Number(limits.perHour || 120)) return { ok: false, reason: 'limit_hour' };
    if (perDay >= Number(limits.perDay || 400)) return { ok: false, reason: 'limit_day' };
    if (perContactDay >= Number(limits.perContactPerDay || 2)) return { ok: false, reason: 'limit_contact_day' };

    return { ok: true };
  }

  function markSendCounter(jid) {
    const ts = Date.now();
    const km = keyMinute(ts), kh = keyHour(ts), kd = keyDay(ts);
    const kcd = `${kd}|${jid}`;

    data.counters.byMinute[km] = (data.counters.byMinute[km] || 0) + 1;
    data.counters.byHour[kh] = (data.counters.byHour[kh] || 0) + 1;
    data.counters.byDay[kd] = (data.counters.byDay[kd] || 0) + 1;
    data.counters.byContactDay[kcd] = (data.counters.byContactDay[kcd] || 0) + 1;
    saveCounters();
  }

  async function maybePresence(jid, type) {
    if (SILENT_MODE) return;
    if (!SEND_PRESENCE_UPDATES) return;
    try { await sock?.sendPresenceUpdate?.(type, jid); } catch (_) {}
  }

  // Espera hasta que los límites vuelvan a permitir enviar (en vez de spammear/soltar todo junto)
  async function waitForLimits(jid) {
    while (true) {
      const ok = canSendNow(jid);
      if (ok.ok) return;
      // Esperas “inteligentes” según el tipo de límite
      if (ok.reason === 'outside_window') {
        // Espera 60s y reintenta (simple y seguro)
        await sleep(60000);
      } else if (ok.reason === 'limit_minute') {
        await sleep(30000);
      } else if (ok.reason === 'limit_hour') {
        await sleep(5 * 60 * 1000);
      } else if (ok.reason === 'limit_day' || ok.reason === 'limit_contact_day') {
        await sleep(30 * 60 * 1000);
      } else {
        await sleep(10000);
      }
    }
  }

  async function sendTextSafe(jid, text, meta = {}) {
    if (!sock || !state.connected) return { ok: false, error: 'not_connected' };

    const lead = getLead(jid);

    return enqueue(async () => {
      // 0) Espera ventana y límites (NO dispara ráfaga)
      await waitForLimits(jid);

      // 1) Cooldown por contacto (1 min real)
      const nextContact = contactNextAt.get(jid) || 0;
      const waitContact = Math.max(0, nextContact - Date.now());
      if (waitContact > 0) await sleep(waitContact);

      // 2) Cooldown global (entre cualquier envío)
      const waitGlobal = Math.max(0, (state.lastSendAt + GLOBAL_GAP_MS) - Date.now());
      if (waitGlobal > 0) await sleep(waitGlobal);

      // 3) Delay humano aleatorio
      await sleep(randomInt(MIN_DELAY_MS, MAX_DELAY_MS));

      await maybePresence(jid, 'composing');

      try {
        await sock.sendMessage(jid, { text: String(text || '') });
        await maybePresence(jid, 'paused');

        // marcar contadores SOLO aquí (envío real)
        markSendCounter(jid);

        // Actualizar timers
        state.lastSendAt = Date.now();
        contactNextAt.set(jid, Date.now() + PER_CONTACT_GAP_MS);

        // Lead stats
        lead.lastOutboundAt = nowTs();
        lead.updatedAt = nowTs();
        data.leads[jid] = lead;
        saveLeads();

        ev('auto_sent', {
          jid,
          phoneKey: lead.phoneKey,
          meta,
          len: String(text || '').length
        });

        return { ok: true };
      } catch (e) {
        const msg = String(e?.message || e);
        setState({ lastError: msg });
        ev('send_error', { jid, error: msg, meta });
        return { ok: false, error: msg };
      }
    });
  }

  // ==========================
  // Scheduler (NO overlap)
  // ==========================
  let schedulerHandle = null;
  let schedulerRunning = false;

  function stepKeys() {
    // Si vos tenés steps en config, adaptalo aquí
    // Ejemplo: data.messagesConfig tiene keys step0, step1...
    const keys = Object.keys(data.messagesConfig || {}).filter(k => /^step\d+$/i.test(k));
    keys.sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    return keys;
  }

  async function trySendStep(lead, stepIdx) {
    const keys = stepKeys();
    const key = keys[stepIdx];
    if (!key) return;

    const tpl = data.messagesConfig[key] || '';
    const text = applyTemplate(tpl, lead);

    const out = await sendTextSafe(lead.jid, text, { step: key, followup: true });
    if (out.ok) {
      lead.stepIndex = stepIdx + 1;
      lead.updatedAt = nowTs();

      // Programación siguiente (ejemplo simple: 3 días)
      const nextDelayDays = Number(process.env.FOLLOWUP_DAYS || 3);
      lead.nextAt = Date.now() + nextDelayDays * 24 * 60 * 60 * 1000;
      data.leads[lead.jid] = lead;
      saveLeads();
    }
  }

  async function processAgendas(now) {
    let changed = false;

    for (const [jid, arr] of Object.entries(data.agendas || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;

      // ✅ Blindaje: solo 1 envío por contacto por tick
      let sentOneThisTick = false;

      const nextArr = [];
      for (const ag of arr) {
        if (!ag?.at) continue;
        if (ag.sent) { nextArr.push(ag); continue; }

        if (!sentOneThisTick && now >= Number(ag.at)) {
          const msgKey = ag.key || 'agenda0';
          const tpl = data.messagesConfig[msgKey] || data.messagesConfig.agenda0 || '';
          const text = applyTemplate(tpl, ag.data || {});
          const out = await sendTextSafe(jid, text, { step: msgKey, agenda: true });

          if (out.ok) {
            ag.sent = true;
            ag.sentAt = nowTs();
            changed = true;
            sentOneThisTick = true;
          }
        }

        nextArr.push(ag);
      }

      // limpieza (7 días)
      data.agendas[jid] = nextArr.filter(x => !x.sent || (Date.now() - Number(x.at || 0) < 7 * 24 * 60 * 60 * 1000));
    }

    if (changed) saveAgendas();
  }

  async function processFollowUps(now) {
    if (!state.enabled) return;

    for (const lead of Object.values(data.leads || {})) {
      if (!lead?.jid) continue;
      if (lead.blocked) continue;
      if (lead.isClient) continue;
      if (lead.pausedUntil && now < Number(lead.pausedUntil)) continue;
      if (lead.manualOffUntil && now < Number(lead.manualOffUntil)) continue;
      if (!lead.nextAt) continue; // no arranca si no fue programado
      if (now < Number(lead.nextAt)) continue;

      const minYear = Number(data.config.rules?.minYearFollowUp || 2022);
      if (lead.year && Number(lead.year) < minYear) continue;

      const stepIdx = Number(lead.stepIndex || 0);
      if (stepIdx >= stepKeys().length) continue;

      await trySendStep(lead, stepIdx);
    }
  }

  async function schedulerTick() {
    if (schedulerRunning) return; // ✅ NO solapa ticks
    schedulerRunning = true;
    try {
      const now = Date.now();
      await processAgendas(now);
      await processFollowUps(now);
      saveLeads();
    } finally {
      schedulerRunning = false;
    }
  }

  function startScheduler() {
    if (schedulerHandle) clearInterval(schedulerHandle);
    schedulerHandle = setInterval(() => {
      schedulerTick().catch((e) => setState({ lastError: String(e?.message || e) }));
    }, SCHEDULER_TICK_MS);
  }

  // ==========================
  // WhatsApp / Baileys
  // ==========================
  function dedupeSeen(msgId) {
    if (!msgId) return false;

    const now = Date.now();
    // limpia TTL
    for (const [k, ts] of recentMsg.entries()) {
      if (now - ts > DEDUPE_TTL_MS) recentMsg.delete(k);
    }
    if (recentMsg.has(msgId)) return true;
    recentMsg.set(msgId, now);
    return false;
  }

  async function connect() {
    if (connecting) return;
    if (sock && state.connected) return;

    connecting = true;
    manualDisconnect = false;
    setState({ lastError: null });

    try {
      ensureDir(authDir);

      const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, P({ level: 'silent' })),
        },
        browser: ['Iron Glass', 'Chrome', '1.0.0'],
        markOnlineOnConnect: SILENT_MODE ? false : MARK_ONLINE,
        generateHighQualityLinkPreview: false,
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (u) => {
        const { connection, qr, lastDisconnect } = u;

        if (qr) {
          setState({ qr, connected: false });
          ev('wa_qr', {});
        }

        if (connection === 'open') {
          setState({ connected: true, qr: null, lastError: null });
          ev('wa_open', {});
        }

        if (connection === 'close') {
          setState({ connected: false });
          const code = lastDisconnect?.error?.output?.statusCode;
          ev('wa_close', { code });

          if (manualDisconnect) return;

          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => connect().catch(() => {}), 2500);
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages || []) {
          const jid = msg?.key?.remoteJid;
          if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;

          const msgId = msg?.key?.id;
          if (dedupeSeen(msgId)) continue; // ✅ dedupe

          const fromMe = !!msg?.key?.fromMe;

          const text =
            msg?.message?.conversation ||
            msg?.message?.extendedTextMessage?.text ||
            msg?.message?.imageMessage?.caption ||
            msg?.message?.videoMessage?.caption ||
            '';

          if (!text) continue;

          const lead = getLead(jid);

          if (!fromMe) {
            // ✅ NO marcar leído por defecto (no perder notificaciones)
            if (READ_INBOUND_MESSAGES && !SILENT_MODE) {
              try { await sock.readMessages?.([msg.key]); } catch (_) {}
            }

            lead.lastInboundAt = nowTs();
            lead.updatedAt = nowTs();
            data.leads[jid] = lead;
            saveLeads();

            ev('inbound', { jid, text: String(text).slice(0, 200) });
          } else {
            // si querés contabilizar salientes manuales, lo podés hacer acá
          }
        }
      });

      // Start scheduler once
      startScheduler();

    } catch (e) {
      setState({ lastError: String(e?.message || e) });
      ev('connect_error', { error: String(e?.message || e) });
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    manualDisconnect = true;
    try { await sock?.logout?.(); } catch (_) {}
    try { sock?.end?.(); } catch (_) {}
    sock = null;
    setState({ connected: false });
  }

  // ==========================
  // Public API
  // ==========================
  function setEnabled(v) {
    state.enabled = !!v;
    data.config.enabled = !!v;
    saveConfig();
  }

  function updateConfig(patch) {
    data.config = Object.assign({}, data.config, patch || {});
    saveConfig();
  }

  function updateMessages(patch) {
    data.messagesConfig = Object.assign({}, data.messagesConfig, patch || {});
    saveMessages();
  }

  return {
    state,
    data,
    connect,
    disconnect,
    sendTextSafe,
    setEnabled,
    updateConfig,
    updateMessages,
  };
}

module.exports = { createBot };
