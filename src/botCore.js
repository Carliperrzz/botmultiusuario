'use strict';

const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const {
  ensureDir,
  loadJSON,
  saveJSON,
  applyTemplate,
  normalizePhone,
  jidToPhoneKey,
  phoneKeyToJid,
  isWithinWindow,
  parseCarInfo,
} = require('./utils');

// ---- helpers ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowTs() { return Date.now(); }
function randInt(min, max) {
  const a = Math.ceil(min), b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function parseListHours(str, fallbackArr) {
  try {
    const arr = String(str || '')
      .split(',')
      .map(s => Number(String(s).trim()))
      .filter(n => Number.isFinite(n) && n >= 0);
    return arr.length ? arr : fallbackArr;
  } catch (_) {
    return fallbackArr;
  }
}

function createBot({ botId, baseDir, authDir, eventLogger }) {
  const dataBase = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(baseDir, 'data');
  const botDir = path.join(dataBase, botId);
  ensureDir(botDir);
  ensureDir(authDir);

  const FILES = {
    config: path.join(botDir, 'config.json'),
    messages: path.join(botDir, 'messages.json'),
    leads: path.join(botDir, 'leads.json'),
    blocked: path.join(botDir, 'blocked.json'),
    scheduled: path.join(botDir, 'programados.json'),
    agendas: path.join(botDir, 'agendas.json'),
    quotes: path.join(botDir, 'quotes.json'),
    counters: path.join(botDir, 'counters.json'),
    dedupe: path.join(botDir, 'dedupe.json'),
  };

  // ===== defaults =====
  const defaults = {
    config: {
      window: { startHour: 9, endHour: 22 },
      limits: { perMinute: 8, perHour: 120, perDay: 400, perContactPerDay: 2 },
      rules: { minYearFollowUp: 2022 },
      commands: { stop: 'STOP', pause: 'PAUSE', client: 'CLIENTE', remove: 'REMOVE', botOff: 'BOT OFF' },
    },
    messagesConfig: {
      step0: 'Oi! Carlos por aqui 😊 Tudo certo? Você ainda quer proteger os vidros do seu carro?',
      step1: 'Passando pra lembrar: ainda quer fazer o Iron Glass no seu carro? Posso te mandar 2 horários pra escolher.',
      step2: 'Último toque 😊 Se quiser, me diz o modelo/ano do carro e eu já te passo o valor certinho.',
      step3: 'Se preferir, me chama quando estiver pronto. Estou à disposição!',
      extra: '',
      postSale30: 'Oi! Tudo bem? Passando só para saber como está a experiência com a Iron Glass 😊',
      agenda0: 'Olá! Faltam 7 dias para seu agendamento na Iron Glass.',
      agenda1: 'Olá! Faltam 3 dias para seu agendamento na Iron Glass.',
      agenda2: 'É amanhã! Seu horário é {{DATA}} às {{HORA}}. Te aguardo 🙂',
      confirmTemplate:
        '✅ *Agendamento confirmado*\n' +
        '📅 Data: {{DATA}}\n' +
        '🕒 Hora: {{HORA}}\n' +
        '🚗 Veículo: {{VEICULO}}\n' +
        '🛡️ Produto: {{PRODUTO}}\n' +
        '💰 Valor: {{VALOR}}\n' +
        '💳 Pagamento: {{PAGAMENTO}}',
    },
    quotesConfig: {
      ironGlassPlus: {
        template:
          '🛡️ *Cotização Iron Glass Plus*\n' +
          '🚗 Veículo: {{VEICULO}} {{ANO}}\n' +
          '💰 Valor: {{VALOR}}\n' +
          '💳 Pagamento: {{PAGAMENTO}}',
      },
    },
    counters: { byMinute: {}, byHour: {}, byDay: {}, byContactDay: {} },
  };

  // ===== load persisted =====
  let data = {
    config: loadJSON(FILES.config, defaults.config),
    messagesConfig: loadJSON(FILES.messages, defaults.messagesConfig),
    leads: loadJSON(FILES.leads, {}),
    blocked: loadJSON(FILES.blocked, {}),
    scheduledStarts: loadJSON(FILES.scheduled, {}),
    agendas: loadJSON(FILES.agendas, {}),
    quotesConfig: loadJSON(FILES.quotes, defaults.quotesConfig),
    counters: loadJSON(FILES.counters, defaults.counters),
    dedupe: loadJSON(FILES.dedupe, {}), // { key: ts }
  };

  // merge safe
  data.config = { ...defaults.config, ...(data.config || {}) };
  data.config.window = { ...defaults.config.window, ...(data.config.window || {}) };
  data.config.limits = { ...defaults.config.limits, ...(data.config.limits || {}) };
  data.config.rules = { ...defaults.config.rules, ...(data.config.rules || {}) };
  data.config.commands = { ...defaults.config.commands, ...(data.config.commands || {}) };

  data.messagesConfig = { ...defaults.messagesConfig, ...(data.messagesConfig || {}) };
  data.quotesConfig = { ...defaults.quotesConfig, ...(data.quotesConfig || {}) };

  data.counters = { ...defaults.counters, ...(data.counters || {}) };
  data.counters.byMinute = data.counters.byMinute || {};
  data.counters.byHour = data.counters.byHour || {};
  data.counters.byDay = data.counters.byDay || {};
  data.counters.byContactDay = data.counters.byContactDay || {};

  // ===== env behavior =====
  const SILENT_MODE = String(process.env.SILENT_MODE ?? 'true').toLowerCase() === 'true';
  const MARK_ONLINE_ON_CONNECT = String(process.env.MARK_ONLINE_ON_CONNECT ?? 'false').toLowerCase() === 'true';
  const READ_INBOUND_MESSAGES = String(process.env.READ_INBOUND_MESSAGES ?? 'false').toLowerCase() === 'true';
  const SEND_PRESENCE_UPDATES = String(process.env.SEND_PRESENCE_UPDATES ?? 'false').toLowerCase() === 'true';

  const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 1500);
  const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 3000);

  // gaps (para no mandar 2 seguidos ni al mismo ni global)
  const GLOBAL_GAP_MS = Number(process.env.GLOBAL_GAP_MS || 2500);
  const PER_CONTACT_GAP_MS = Number(process.env.PER_CONTACT_GAP_MS || 60000);

  // anti duplicados (misma msg al mismo jid dentro del TTL)
  const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 10 * 60 * 1000);

  // cooldown después de inbound (si cliente escribió ayer, HOY NO le mandes)
  const FOLLOWUP_AFTER_INBOUND_HOURS = Number(process.env.FOLLOWUP_AFTER_INBOUND_HOURS || 48);
  const INBOUND_COOLDOWN_MS = FOLLOWUP_AFTER_INBOUND_HOURS * 60 * 60 * 1000;

  // delays entre pasos (en horas). Ej: "0,72,120,240" => step0 inmediato, step1 3d, step2 5d, step3 10d
  const FOLLOWUP_DELAYS_HOURS = parseListHours(process.env.FOLLOWUP_DELAYS_HOURS, [0, 72, 120, 240]);

  // scheduler tick
  const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 5000);

  // ===== state =====
  let sock = null;
  let connecting = false;
  let manualDisconnect = false;

  let state = {
    connected: false,
    enabled: true,
    qr: null,
    queueSize: 0,
    lastError: null,
    lastUpdate: new Date().toISOString(),
  };

  function setState(patch) {
    state = { ...state, ...patch, lastUpdate: new Date().toISOString() };
  }

  function ev(action, extra = {}) {
    try {
      eventLogger && eventLogger({
        botId,
        ts: Date.now(),
        iso: new Date().toISOString(),
        action,
        ...extra,
      });
    } catch (_) {}
  }

  function saveAllLight() {
    saveJSON(FILES.config, data.config);
    saveJSON(FILES.messages, data.messagesConfig);
    saveJSON(FILES.leads, data.leads);
    saveJSON(FILES.blocked, data.blocked);
    saveJSON(FILES.scheduled, data.scheduledStarts);
    saveJSON(FILES.agendas, data.agendas);
    saveJSON(FILES.quotes, data.quotesConfig);
    saveJSON(FILES.counters, data.counters);
    saveJSON(FILES.dedupe, data.dedupe);
  }
  saveAllLight();

  // ===== lead =====
  function getLead(jid) {
    if (!data.leads[jid]) {
      const phoneKey = jidToPhoneKey(jid);
      data.leads[jid] = {
        jid,
        phoneKey,
        createdAt: nowTs(),
        updatedAt: nowTs(),
        lastInboundAt: 0,
        lastOutboundAt: 0,
        stage: 'novo',
        stepIndex: 0,
        nextAt: 0,
        pausedUntil: 0,
        manualOffUntil: 0,
        blocked: false,
        isClient: false,
        tags: [],
        notes: '',
        name: '',
        model: '',
        year: null,
      };
      saveJSON(FILES.leads, data.leads);
    }
    return data.leads[jid];
  }

  // ===== counters =====
  function keyMinute(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
  }
  function keyHour(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}-${d.getUTCHours()}`;
  }
  function keyDay(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
  }
  function pruneCounters() {
    const keepM = new Set([keyMinute(), keyMinute(Date.now()-60000), keyMinute(Date.now()-120000)]);
    for (const k of Object.keys(data.counters.byMinute)) if (!keepM.has(k)) delete data.counters.byMinute[k];
    const keepH = new Set([keyHour(), keyHour(Date.now()-3600000)]);
    for (const k of Object.keys(data.counters.byHour)) if (!keepH.has(k)) delete data.counters.byHour[k];
    const keepD = new Set([keyDay(), keyDay(Date.now()-86400000)]);
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
    saveJSON(FILES.counters, data.counters);
  }

  // ===== queue & gaps =====
  let sendQueue = Promise.resolve();
  let queueCount = 0;
  let lastGlobalSendAt = 0;
  const lastSendAtByJid = {};

  function enqueue(task) {
    queueCount += 1;
    setState({ queueSize: queueCount });
    sendQueue = sendQueue.then(async () => {
      try { return await task(); }
      finally {
        queueCount = Math.max(0, queueCount - 1);
        setState({ queueSize: queueCount });
      }
    }).catch(() => {});
    return sendQueue;
  }

  function dedupeKey(jid, step, text) {
    const t = String(text || '').slice(0, 140);
    return `${jid}|${step}|${t}`;
  }

  async function maybePresence(jid, type) {
    if (SILENT_MODE) return;
    if (!SEND_PRESENCE_UPDATES) return;
    try { await sock?.sendPresenceUpdate?.(type, jid); } catch (_) {}
  }

  async function sendTextSafe(jid, text, meta = {}) {
    if (!sock || !state.connected) return { ok: false, error: 'not_connected' };

    const check = canSendNow(jid);
    if (!check.ok) return { ok: false, error: check.reason };

    // per-contact gap
    const lastJ = lastSendAtByJid[jid] || 0;
    if (Date.now() - lastJ < PER_CONTACT_GAP_MS) return { ok: false, error: 'per_contact_gap' };

    // global gap
    if (Date.now() - lastGlobalSendAt < GLOBAL_GAP_MS) return { ok: false, error: 'global_gap' };

    // dedupe
    const dk = dedupeKey(jid, meta.step || 'text', text);
    const lastD = Number(data.dedupe[dk] || 0);
    if (Date.now() - lastD < DEDUPE_TTL_MS) return { ok: false, error: 'dedupe_ttl' };

    return enqueue(async () => {
      // re-check inside queue
      const re = canSendNow(jid);
      if (!re.ok) return { ok: false, error: re.reason };

      const lastJ2 = lastSendAtByJid[jid] || 0;
      if (Date.now() - lastJ2 < PER_CONTACT_GAP_MS) return { ok: false, error: 'per_contact_gap' };
      if (Date.now() - lastGlobalSendAt < GLOBAL_GAP_MS) await sleep(GLOBAL_GAP_MS);

      // mark dedupe BEFORE send (para evitar dobles por reinicio/tick)
      data.dedupe[dk] = Date.now();
      saveJSON(FILES.dedupe, data.dedupe);

      await sleep(randInt(MIN_DELAY_MS, MAX_DELAY_MS));
      await maybePresence(jid, 'composing');

      try {
        await sock.sendMessage(jid, { text: String(text || '') });
        await maybePresence(jid, 'paused');

        lastGlobalSendAt = Date.now();
        lastSendAtByJid[jid] = Date.now();
        markSendCounter(jid);

        const lead = getLead(jid);
        lead.lastOutboundAt = nowTs();
        lead.updatedAt = nowTs();
        data.leads[jid] = lead;
        saveJSON(FILES.leads, data.leads);

        ev('auto_sent', {
          jid,
          phoneKey: lead.phoneKey,
          textPreview: String(text || '').slice(0, 160),
          ...meta,
        });

        return { ok: true };
      } catch (e) {
        // if send failed, allow retry later
        data.dedupe[dk] = 0;
        saveJSON(FILES.dedupe, data.dedupe);
        setState({ lastError: String(e?.message || e) });
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // ===== funil scheduling =====
  function stepKeyByIndex(i) {
    return ['step0', 'step1', 'step2', 'step3'][i] || null;
  }

  function scheduleNextFromStep(lead) {
    const idx = Number(lead.stepIndex || 0);
    const hours = FOLLOWUP_DELAYS_HOURS[idx] ?? 72;
    lead.nextAt = Date.now() + hours * 60 * 60 * 1000;
    lead.updatedAt = nowTs();
  }

  async function trySendStep(lead) {
    const idx = Number(lead.stepIndex || 0);
    const key = stepKeyByIndex(idx);
    if (!key) return { ok: false, error: 'no_step' };

    const txt = data.messagesConfig[key];
    if (!txt || !String(txt).trim()) return { ok: false, error: 'empty_message' };

    const out = await sendTextSafe(lead.jid, txt, { step: key });
    if (out.ok) {
      lead.stepIndex = idx + 1;
      if (lead.stage === 'novo') lead.stage = 'em_negociacao';
      scheduleNextFromStep(lead);
      data.leads[lead.jid] = lead;
      saveJSON(FILES.leads, data.leads);
    }
    return out;
  }

  // ===== scheduler =====
  async function processAgendas(now) {
    // lock per agenda item: set sent BEFORE send
    let changed = false;
    for (const [jid, arr] of Object.entries(data.agendas || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;

      for (const ag of arr) {
        if (!ag?.at) continue;
        if (ag.sent) continue;

        if (now >= Number(ag.at)) {
          ag.sent = true;
          ag.sentAt = nowTs();
          saveJSON(FILES.agendas, data.agendas);
          changed = true;

          const key = ag.key || 'agenda0';
          const tpl = data.messagesConfig[key] || '';
          const text = applyTemplate(tpl, ag.data || {});
          const out = await sendTextSafe(jid, text, { step: key, agenda: true });

          if (!out.ok) {
            ag.sent = false;
            ag.sentAt = 0;
            saveJSON(FILES.agendas, data.agendas);
          }
        }
      }
    }
    if (changed) saveJSON(FILES.agendas, data.agendas);
  }

  async function processScheduledStarts(now) {
    for (const [jid, item] of Object.entries(data.scheduledStarts || {})) {
      if (!item?.at) continue;
      if (now < Number(item.at)) continue;

      const lead = getLead(jid);
      if (lead.blocked) { delete data.scheduledStarts[jid]; continue; }

      let text = String(item.text || '').trim();
      if (!text) text = data.messagesConfig.step0 || '';

      const out = await sendTextSafe(jid, text, { step: 'program_start' });
      if (out.ok) {
        // start funnel AFTER program start (next follow-up)
        lead.stage = 'programado';
        lead.stepIndex = 1; // step0 already used
        scheduleNextFromStep(lead);
        data.leads[jid] = lead;
        saveJSON(FILES.leads, data.leads);

        delete data.scheduledStarts[jid];
        saveJSON(FILES.scheduled, data.scheduledStarts);
      }
    }
  }

  async function processFollowUps(now) {
    if (!state.enabled) return;

    for (const lead of Object.values(data.leads || {})) {
      if (!lead?.jid) continue;
      if (lead.blocked || lead.isClient) continue;
      if (lead.pausedUntil && now < Number(lead.pausedUntil)) continue;
      if (lead.manualOffUntil && now < Number(lead.manualOffUntil)) continue;

      // IMPORTANT: cooldown after inbound (si habló ayer, no mandes hoy)
      if (lead.lastInboundAt && now - Number(lead.lastInboundAt) < INBOUND_COOLDOWN_MS) continue;

      if (!lead.nextAt || now < Number(lead.nextAt)) continue;

      const minYear = Number(data.config.rules?.minYearFollowUp || 2022);
      if (lead.year && Number(lead.year) < minYear) continue;

      await trySendStep(lead);
    }
  }

  async function schedulerTick() {
    const now = Date.now();
    await processScheduledStarts(now);
    await processAgendas(now);
    await processFollowUps(now);
  }

  let schedulerHandle = setInterval(() => {
    schedulerTick().catch(e => setState({ lastError: String(e?.message || e) }));
  }, SCHEDULER_TICK_MS);

  // ===== WhatsApp =====
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
        markOnlineOnConnect: SILENT_MODE ? false : MARK_ONLINE_ON_CONNECT,
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
            // DON'T read messages by default (avoid killing notifications)
            if (READ_INBOUND_MESSAGES && !SILENT_MODE) {
              try { await sock.readMessages?.([msg.key]); } catch (_) {}
            }

            lead.lastInboundAt = nowTs();
            lead.updatedAt = nowTs();

            // parse model/year
            const parsed = parseCarInfo(text);
            if (parsed.year && !lead.year) lead.year = parsed.year;
            if (parsed.model && (!lead.model || parsed.model.length > String(lead.model || '').length)) {
              lead.model = parsed.model;
            }

            // IMPORTANT:
            // - inbound should NOT trigger immediate followup
            // - if funnel already running, push nextAt forward (cooldown)
            if (lead.nextAt && lead.nextAt < (Date.now() + INBOUND_COOLDOWN_MS)) {
              lead.nextAt = Date.now() + INBOUND_COOLDOWN_MS;
            }

            data.leads[jid] = lead;
            saveJSON(FILES.leads, data.leads);

            ev('inbound_message', {
              jid,
              phoneKey: lead.phoneKey,
              textPreview: String(text).slice(0, 180),
              model: lead.model || null,
              year: lead.year || null,
            });
          } else {
            // optional: manual commands from seller (kept)
            const c = data.config.commands || {};
            const txt = String(text || '').trim().toUpperCase();

            if (c.stop && txt === String(c.stop).trim().toUpperCase()) {
              lead.blocked = true;
              lead.stage = 'perdido';
              data.leads[jid] = lead;
              saveJSON(FILES.leads, data.leads);
              data.blocked[lead.phoneKey] = { ts: nowTs(), iso: new Date().toISOString(), reason: 'cmd_stop', jid };
              saveJSON(FILES.blocked, data.blocked);
              ev('blocked', { jid, phoneKey: lead.phoneKey, reason: 'cmd_stop' });
            }
          }
        }
      });
    } catch (e) {
      setState({ lastError: String(e?.message || e), connected: false });
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    manualDisconnect = true;
    try { sock?.end?.(new Error('manual_disconnect')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
    sock = null;
    setState({ connected: false });
  }

  // ===== panel methods =====
  function getStatus() { return { ...state }; }
  function setEnabled(v) { setState({ enabled: !!v }); }
  function getConfig() { return JSON.parse(JSON.stringify(data.config)); }
  function getLeads() { return data.leads || {}; }

  function getDataSnapshot() {
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

  function updateMessages(patch = {}) {
    data.messagesConfig = { ...data.messagesConfig, ...(patch || {}) };
    saveJSON(FILES.messages, data.messagesConfig);
    return true;
  }

  function updateConfig(patch = {}) {
    data.config = {
      ...data.config,
      ...(patch || {}),
      window: { ...(data.config.window || {}), ...((patch || {}).window || {}) },
      limits: { ...(data.config.limits || {}), ...((patch || {}).limits || {}) },
      rules: { ...(data.config.rules || {}), ...((patch || {}).rules || {}) },
      commands: { ...(data.config.commands || {}), ...((patch || {}).commands || {}) },
    };
    saveJSON(FILES.config, data.config);
    return true;
  }

  function setCommands(cmds = {}) {
    data.config.commands = { ...(data.config.commands || {}), ...(cmds || {}) };
    saveJSON(FILES.config, data.config);
    return true;
  }

  function updateLead(jid, patch = {}) {
    if (!jid) return false;
    const lead = getLead(jid);
    data.leads[jid] = { ...lead, ...(patch || {}), updatedAt: nowTs() };
    saveJSON(FILES.leads, data.leads);
    return true;
  }

  // manual actions used by your panel
  function pauseFollowUp(jid, ms) {
    const lead = getLead(jid);
    lead.pausedUntil = Date.now() + Number(ms || 0);
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);
    ev('pause_followup', { jid, phoneKey: lead.phoneKey, ms });
  }

  function stopFollowUp(jid) {
    const lead = getLead(jid);
    lead.stage = 'perdido';
    lead.blocked = false;
    lead.pausedUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);
    ev('stop_followup', { jid, phoneKey: lead.phoneKey });
  }

  function setManualOff(jid, ms) {
    const lead = getLead(jid);
    lead.manualOffUntil = Date.now() + Number(ms || 0);
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);
    ev('manual_off', { jid, phoneKey: lead.phoneKey, ms });
  }

  function blockFollowUp(jid, phone, reason = 'manual') {
    const lead = getLead(jid);
    lead.blocked = true;
    lead.stage = 'perdido';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;

    data.blocked[phone || lead.phoneKey || jidToPhoneKey(jid)] = {
      ts: nowTs(),
      iso: new Date().toISOString(),
      reason,
      jid,
    };

    saveJSON(FILES.leads, data.leads);
    saveJSON(FILES.blocked, data.blocked);
    ev('blocked', { jid, phoneKey: lead.phoneKey, reason });
  }

  function markAsClient(jid) {
    const lead = getLead(jid);
    lead.isClient = true;
    lead.stage = 'fechado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);
    ev('mark_client', { jid, phoneKey: lead.phoneKey });
  }

  function programStartMessage(phoneKey, date, time = '09:00', text = '') {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return false;

    const at = new Date(`${date}T${time}:00`).getTime();
    data.scheduledStarts[jid] = { at, text: String(text || '') };
    saveJSON(FILES.scheduled, data.scheduledStarts);

    const lead = getLead(jid);
    lead.stage = 'programado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);

    ev('program_start_set', { jid, phoneKey: lead.phoneKey, at });
    return true;
  }

  function scheduleAgendaFromPanel(phoneKey, date, time, tplData = {}) {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return false;

    const baseTs = new Date(`${date}T${time}:00`).getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    // replace agendas for this jid to avoid duplicates
    data.agendas[jid] = [
      { key: 'agenda0', at: baseTs - 7 * oneDay, data: tplData, sent: false },
      { key: 'agenda1', at: baseTs - 3 * oneDay, data: tplData, sent: false },
      { key: 'agenda2', at: baseTs - 1 * oneDay, data: tplData, sent: false },
    ].filter(x => x.at > Date.now() - oneDay);

    saveJSON(FILES.agendas, data.agendas);

    const lead = getLead(jid);
    lead.stage = 'agendado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);

    ev('agenda_programada', { jid, phoneKey: lead.phoneKey, baseTs });
    return true;
  }

  async function sendConfirmNow(phoneKey, tplData = {}) {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return { ok: false, error: 'bad_phone' };

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

    return sendTextSafe(jid, text, { step: 'confirmTemplate', agenda: true });
  }

  function cancelAgenda(jid) {
    if (!jid) return false;
    delete data.agendas[jid];
    saveJSON(FILES.agendas, data.agendas);
    ev('agenda_cancelada', { jid });
    return true;
  }

  async function sendQuoteNow(phoneKey, payload = {}) {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return { ok: false, error: 'bad_phone' };

    const lead = getLead(jid);
    if (payload.vehicle) lead.model = String(payload.vehicle);
    if (payload.year) lead.year = Number(payload.year);
    lead.stage = 'cotizado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveJSON(FILES.leads, data.leads);

    const tpl = (data.quotesConfig?.ironGlassPlus?.template) || defaults.quotesConfig.ironGlassPlus.template;
    const text = applyTemplate(tpl, {
      VEICULO: payload.vehicle || lead.model || '',
      ANO: payload.year || lead.year || '',
      VALOR: payload.value || '',
      PAGAMENTO: payload.payment || '',
    });

    return sendTextSafe(jid, text, { step: 'quote_ironGlassPlus' });
  }

  function updateQuotes(nextQuotes = {}) {
    data.quotesConfig = { ...data.quotesConfig, ...(nextQuotes || {}) };
    saveJSON(FILES.quotes, data.quotesConfig);
    return true;
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
