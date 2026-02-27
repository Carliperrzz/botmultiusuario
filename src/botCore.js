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
  sleep,
  nowTs,
  randomInt,
  jidToPhoneKey,
  phoneKeyToJid,
  isWithinWindow,
  parseCarInfo,
} = require('./utils');

function createBot({ botId, baseDir, authDir, eventLogger }) {
  const botDir = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(baseDir, 'data'), botId);
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
  };

  const defaults = {
    config: {
      window: { startHour: 9, endHour: 22 },
      limits: { perMinute: 8, perHour: 120, perDay: 400, perContactPerDay: 2 },
      rules: { minYearFollowUp: 2022 },
      commands: { stop: 'STOP', pause: 'PAUSE', client: 'CLIENTE', remove: 'REMOVE', botOff: 'BOT OFF' },
    },
    messages: {
      step0: 'Oi! Carlos por aqui 😊 Tudo certo? Você ainda quer proteger os vidros do seu carro?',
      step1: 'Passando para saber se posso te ajudar com alguma dúvida sobre o blindagem dos vidros 😊',
      step2: 'Se quiser, eu posso te enviar uma cotização sem compromisso 👍',
      step3: 'Última mensagem por aqui 😊 Se ainda tiver interesse, me chama que te atendo com prazer.',
      extra: '',
      postSale30: 'Oi! Tudo bem? Passando só para saber como está a experiência com a Iron Glass 😊',
      agenda0: 'Olá! Faltam 7 dias para seu agendamento na Iron Glass.',
      agenda1: 'Olá! Faltam 3 dias para seu agendamento na Iron Glass.',
      agenda2: 'Olá! Seu agendamento é amanhã. Qualquer dúvida me chama 😊',
      confirmTemplate:
        '✅ *Agendamento confirmado*\\n' +
        '📅 Data: {{DATA}}\\n' +
        '🕒 Hora: {{HORA}}\\n' +
        '🚗 Veículo: {{VEICULO}}\\n' +
        '🛡️ Produto: {{PRODUTO}}\\n' +
        '💰 Valor: {{VALOR}}\\n' +
        '💳 Pagamento: {{PAGAMENTO}}',
    },
    quotes: {
      ironGlass: {
        title: 'Cotização Iron Glass',
        template:
          '🛡️ *Cotização Iron Glass*\\n' +
          '🚗 Veículo: {{VEICULO}} {{ANO}}\\n' +
          '💰 Valor: {{VALOR}}\\n' +
          '💳 Pagamento: {{PAGAMENTO}}',
      },
      ironGlassPlus: {
        title: 'Cotização Iron Glass Plus',
        template:
          '🛡️ *Cotização Iron Glass Plus*\\n' +
          '🚗 Veículo: {{VEICULO}} {{ANO}}\\n' +
          '💰 Valor: {{VALOR}}\\n' +
          '💳 Pagamento: {{PAGAMENTO}}',
      },
      defender: {
        title: 'Cotização Defender',
        template:
          '🛡️ *Cotização Defender*\\n' +
          '🚗 Veículo: {{VEICULO}} {{ANO}}\\n' +
          '💰 Valor: {{VALOR}}\\n' +
          '💳 Pagamento: {{PAGAMENTO}}',
      },
    },
  };

  let sock = null;
  let connecting = false;
  let state = {
    connected: false,
    enabled: true,
    qr: null,
    queueSize: 0,
    lastError: null,
    lastUpdate: new Date().toISOString(),
  };

  let data = {
    config: loadJSON(FILES.config, defaults.config),
    messagesConfig: loadJSON(FILES.messages, defaults.messages),
    leads: loadJSON(FILES.leads, {}),
    blocked: loadJSON(FILES.blocked, {}),
    scheduledStarts: loadJSON(FILES.scheduled, {}),
    agendas: loadJSON(FILES.agendas, {}),
    quotesConfig: loadJSON(FILES.quotes, defaults.quotes),
    counters: loadJSON(FILES.counters, {
      byMinute: {},
      byHour: {},
      byDay: {},
      byContactDay: {},
    }),
  };

  // merge defaults sin pisar
  data.config = { ...defaults.config, ...(data.config || {}) };
  data.config.window = { ...defaults.config.window, ...(data.config.window || {}) };
  data.config.limits = { ...defaults.config.limits, ...(data.config.limits || {}) };
  data.config.rules = { ...defaults.config.rules, ...(data.config.rules || {}) };
  data.config.commands = { ...defaults.config.commands, ...(data.config.commands || {}) };
  data.messagesConfig = { ...defaults.messages, ...(data.messagesConfig || {}) };
  data.quotesConfig = { ...defaults.quotes, ...(data.quotesConfig || {}) };

  function persistAll() {
    saveJSON(FILES.config, data.config);
    saveJSON(FILES.messages, data.messagesConfig);
    saveJSON(FILES.leads, data.leads);
    saveJSON(FILES.blocked, data.blocked);
    saveJSON(FILES.scheduled, data.scheduledStarts);
    saveJSON(FILES.agendas, data.agendas);
    saveJSON(FILES.quotes, data.quotesConfig);
    saveJSON(FILES.counters, data.counters);
  }
  persistAll();

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
        dedupe: {}, // stepKey -> ts
      };
      saveJSON(FILES.leads, data.leads);
    }
    return data.leads[jid];
  }

  function saveLeads() { saveJSON(FILES.leads, data.leads); }
  function saveConfig() { saveJSON(FILES.config, data.config); }
  function saveMessages() { saveJSON(FILES.messages, data.messagesConfig); }
  function saveBlocked() { saveJSON(FILES.blocked, data.blocked); }
  function saveScheduled() { saveJSON(FILES.scheduled, data.scheduledStarts); }
  function saveAgendas() { saveJSON(FILES.agendas, data.agendas); }
  function saveQuotes() { saveJSON(FILES.quotes, data.quotesConfig); }
  function saveCounters() { saveJSON(FILES.counters, data.counters); }

  // ---------- rate limit / queue ----------
  let sendQueue = Promise.resolve();
  let queueCount = 0;

  function enqueue(task) {
    queueCount += 1;
    setState({ queueSize: queueCount });
    sendQueue = sendQueue
      .then(async () => {
        try { return await task(); }
        finally {
          queueCount = Math.max(0, queueCount - 1);
          setState({ queueSize: queueCount });
        }
      })
      .catch(() => {});
    return sendQueue;
  }

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
    // limpieza simple para que no crezca
    const minuteKeep = new Set([keyMinute(), keyMinute(Date.now()-60000), keyMinute(Date.now()-120000)]);
    for (const k of Object.keys(data.counters.byMinute || {})) if (!minuteKeep.has(k)) delete data.counters.byMinute[k];

    const hourKeep = new Set([keyHour(), keyHour(Date.now()-3600000)]);
    for (const k of Object.keys(data.counters.byHour || {})) if (!hourKeep.has(k)) delete data.counters.byHour[k];

    const dayKeep = new Set([keyDay(), keyDay(Date.now()-86400000)]);
    for (const k of Object.keys(data.counters.byDay || {})) if (!dayKeep.has(k)) delete data.counters.byDay[k];

    for (const k of Object.keys(data.counters.byContactDay || {})) {
      const day = k.split('|')[0];
      if (!dayKeep.has(day)) delete data.counters.byContactDay[k];
    }
  }

  function canSendNow(jid) {
    pruneCounters();
    const limits = data.config.limits || defaults.config.limits;
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
    if (!isWithinWindow(data.config.window || {})) return { ok: false, reason: 'outside_window' };

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

  async function sendTextSafe(jid, text, meta = {}) {
    if (!sock || !state.connected) return { ok: false, error: 'not_connected' };
    const lead = getLead(jid);

    const check = canSendNow(jid);
    if (!check.ok) return { ok: false, error: check.reason };

    const minDelay = Number(process.env.MIN_DELAY_MS || 1200);
    const maxDelay = Number(process.env.MAX_DELAY_MS || 2800);

    return enqueue(async () => {
      const again = canSendNow(jid);
      if (!again.ok) return { ok: false, error: again.reason };

      await sleep(randomInt(minDelay, maxDelay));

      try {
        await sock.sendMessage(jid, { text: String(text || '') });
        markSendCounter(jid);

        lead.lastOutboundAt = nowTs();
        lead.updatedAt = nowTs();
        data.leads[jid] = lead;
        saveLeads();

        ev('auto_sent', {
          jid,
          phoneKey: lead.phoneKey,
          textPreview: String(text || '').slice(0, 120),
          ...meta,
        });

        return { ok: true };
      } catch (e) {
        setState({ lastError: String(e?.message || e) });
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // ---------- funil ----------
  function stepKeys() {
    return ['step0', 'step1', 'step2', 'step3'];
  }

  function scheduleNextByStep(lead) {
    // delays entre pasos (ajustables si querés luego por config)
    const delays = [
      0,                      // step0 puede ir inmediato cuando entra
      24 * 60 * 60 * 1000,    // step1: 24h
      48 * 60 * 60 * 1000,    // step2: 48h
      72 * 60 * 60 * 1000,    // step3: 72h
    ];
    const idx = Number(lead.stepIndex || 0);
    lead.nextAt = Date.now() + (delays[idx] || (24 * 60 * 60 * 1000));
    lead.updatedAt = nowTs();
  }

  async function trySendStep(lead, stepIdx) {
    const key = stepKeys()[stepIdx];
    if (!key) return { ok: false, error: 'step_end' };

    // dedupe: no mandar mismo step < 10 min
    const dedupeTs = Number(lead.dedupe?.[key] || 0);
    if (Date.now() - dedupeTs < 10 * 60 * 1000) {
      return { ok: false, error: 'dedupe' };
    }

    const txt = data.messagesConfig[key];
    if (!txt || !String(txt).trim()) return { ok: false, error: 'empty_message' };

    const out = await sendTextSafe(lead.jid, txt, { step: key });
    if (out.ok) {
      lead.dedupe = lead.dedupe || {};
      lead.dedupe[key] = Date.now();
      lead.stepIndex = stepIdx + 1;
      lead.stage = (lead.stage === 'novo' ? 'em_negociacao' : lead.stage);
      scheduleNextByStep(lead);
      data.leads[lead.jid] = lead;
      saveLeads();
    }
    return out;
  }

  async function schedulerTick() {
    if (!state.enabled) return;
    const now = Date.now();

    // 1) mensagens programadas (programados)
    for (const [jid, item] of Object.entries(data.scheduledStarts || {})) {
      if (!item || !item.at) continue;
      if (now < Number(item.at)) continue;

      const lead = getLead(jid);
      if (lead.blocked) { delete data.scheduledStarts[jid]; continue; }

      let text = String(item.text || '').trim();
      if (!text) text = data.messagesConfig.step0 || '';

      const out = await sendTextSafe(jid, text, { step: 'program_start' });
      if (out.ok) {
        lead.stage = 'programado';
        lead.stepIndex = 1; // já mandou o primeiro toque
        lead.nextAt = now + 24 * 60 * 60 * 1000;
        lead.updatedAt = nowTs();
        lead.dedupe = lead.dedupe || {};
        lead.dedupe.step0 = now;
        data.leads[jid] = lead;
        delete data.scheduledStarts[jid];
        saveLeads();
        saveScheduled();
      }
    }

    // 2) agendas (lembretes)
    for (const [jid, arr] of Object.entries(data.agendas || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const pending = [];
      for (const ag of arr) {
        if (!ag || !ag.at) continue;
        if (ag.sent) { pending.push(ag); continue; }

        if (now >= Number(ag.at)) {
          const msgKey = ag.key || 'agenda0';
          const tpl = data.messagesConfig[msgKey] || '';
          const text = applyTemplate(tpl, ag.data || {});
          const out = await sendTextSafe(jid, text, { step: msgKey, agenda: true });
          if (out.ok) {
            ag.sent = true;
            ag.sentAt = nowTs();
          }
        }
        pending.push(ag);
      }
      data.agendas[jid] = pending.filter(x => !x.sent || (Date.now() - Number(x.at || 0) < 7 * 24 * 60 * 60 * 1000));
    }
    saveAgendas();

    // 3) funil normal
    for (const lead of Object.values(data.leads || {})) {
      if (!lead || !lead.jid) continue;
      if (lead.blocked) continue;
      if (lead.isClient) continue;
      if (lead.pausedUntil && now < Number(lead.pausedUntil)) continue;
      if (lead.manualOffUntil && now < Number(lead.manualOffUntil)) continue;
      if (lead.nextAt && now < Number(lead.nextAt)) continue;

      // regra por ano
      const minYear = Number(data.config.rules?.minYearFollowUp || 2022);
      if (lead.year && Number(lead.year) < minYear) {
        // registra inbound/stat, mas no funil não entra
        continue;
      }

      const stepIdx = Number(lead.stepIndex || 0);
      if (stepIdx >= stepKeys().length) continue;

      await trySendStep(lead, stepIdx);
    }

    saveLeads();
  }

  let schedulerHandle = setInterval(() => {
    schedulerTick().catch((e) => setState({ lastError: String(e?.message || e) }));
  }, 5000);

  // ---------- WhatsApp / Baileys ----------
  async function connect() {
    if (connecting) return;
    if (sock && state.connected) return;

    connecting = true;
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
        markOnlineOnConnect: false,
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (u) => {
        const { connection, qr, lastDisconnect } = u;

        if (qr) setState({ qr, connected: false });

        if (connection === 'open') {
          setState({ connected: true, qr: null, lastError: null });
          ev('wa_open', {});
        }

        if (connection === 'close') {
          setState({ connected: false });
          const code = lastDisconnect?.error?.output?.statusCode;
          ev('wa_close', { code });

          // Nota: el server.js ya maneja reset QR al desconectar manualmente.
          // Acá hacemos reconexión simple si no fue logout explícito.
          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => {
              connect().catch(() => {});
            }, 2500);
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
            // inbound
            lead.lastInboundAt = nowTs();
            lead.updatedAt = nowTs();

            // parse básico año/modelo si todavía no lo tenemos
            const parsed = parseCarInfo(text);
            if (parsed.year && !lead.year) lead.year = parsed.year;
            if (parsed.model && (!lead.model || lead.model.length < parsed.model.length)) lead.model = parsed.model;

            // si es lead nuevo, programar step0
            if (!lead.stepIndex) {
              lead.stepIndex = 0;
              lead.nextAt = Date.now(); // scheduler lo toma
            }

            data.leads[jid] = lead;
            saveLeads();

            ev('inbound_message', {
              jid,
              phoneKey: lead.phoneKey,
              textPreview: String(text).slice(0, 180),
              model: lead.model || null,
              year: lead.year || null,
            });

            // comandos del vendedor (si el vendedor escribe desde su propio WhatsApp al cliente)
            // OJO: esto en grupos/escenarios complejos puede necesitar ajuste. Acá lo dejamos solo para mensajes salientes.
          } else {
            // comando manual si el vendedor envía texto al lead
            const c = data.config.commands || {};
            const txt = String(text || '').trim().toUpperCase();

            if (c.stop && txt === String(c.stop).trim().toUpperCase()) {
              blockFollowUp(jid, lead.phoneKey, 'cmd_stop');
            } else if (c.pause && txt === String(c.pause).trim().toUpperCase()) {
              pauseFollowUp(jid, 72 * 60 * 60 * 1000);
            } else if (c.client && txt === String(c.client).trim().toUpperCase()) {
              markAsClient(jid);
            } else if (c.remove && txt === String(c.remove).trim().toUpperCase()) {
              stopFollowUp(jid);
            } else if (c.botOff && txt === String(c.botOff).trim().toUpperCase()) {
              setManualOff(jid, 24 * 60 * 60 * 1000);
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
    try { sock?.end?.(new Error('manual_disconnect')); } catch (_) {}
    try { sock?.ws?.close?.(); } catch (_) {}
    sock = null;
    setState({ connected: false });
  }

  // ---------- métodos usados por server.js ----------
  function getStatus() {
    return { ...state };
  }

  function setEnabled(v) {
    setState({ enabled: !!v });
  }

  function getConfig() {
    return JSON.parse(JSON.stringify(data.config));
  }

  function getLeads() {
    return data.leads || {};
  }

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
    data.messagesConfig = { ...data.messagesConfig, ...patch };
    saveMessages();
    return true;
  }

  function updateConfig(patch = {}) {
    data.config = {
      ...data.config,
      ...patch,
      window: { ...(data.config.window || {}), ...(patch.window || {}) },
      limits: { ...(data.config.limits || {}), ...(patch.limits || {}) },
      rules: { ...(data.config.rules || {}), ...(patch.rules || {}) },
      commands: { ...(data.config.commands || {}), ...(patch.commands || {}) },
    };
    saveConfig();
    return true;
  }

  function setCommands(cmds = {}) {
    data.config.commands = {
      ...(data.config.commands || {}),
      ...cmds,
    };
    saveConfig();
    return true;
  }

  function updateLead(jid, patch = {}) {
    if (!jid) return false;
    const lead = getLead(jid);
    const next = { ...lead, ...patch, updatedAt: nowTs() };
    data.leads[jid] = next;
    saveLeads();
    return true;
  }

  function pauseFollowUp(jid, ms) {
    const lead = getLead(jid);
    lead.pausedUntil = Date.now() + Number(ms || 0);
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();
    ev('pause_followup', { jid, phoneKey: lead.phoneKey, ms });
  }

  function stopFollowUp(jid) {
    const lead = getLead(jid);
    lead.stage = 'perdido';
    lead.pausedUntil = Date.now() + 365 * 24 * 60 * 60 * 1000; // pausa longa
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();
    ev('stop_followup', { jid, phoneKey: lead.phoneKey });
  }

  function setManualOff(jid, ms) {
    const lead = getLead(jid);
    lead.manualOffUntil = Date.now() + Number(ms || 0);
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();
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
    saveLeads();
    saveBlocked();
    ev('blocked', { jid, phoneKey: lead.phoneKey, reason });
  }

  function markAsClient(jid) {
    const lead = getLead(jid);
    lead.isClient = true;
    lead.stage = 'fechado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();
    ev('mark_client', { jid, phoneKey: lead.phoneKey });
  }

  function programStartMessage(phoneKey, date, time = '09:00', text = '') {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return false;
    const ts = new Date(`${date}T${time}:00`).getTime();
    data.scheduledStarts[jid] = { at: ts, text: String(text || '') };
    const lead = getLead(jid);
    lead.stage = 'programado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();
    saveScheduled();
    ev('program_start_set', { jid, phoneKey: lead.phoneKey, at: ts });
    return true;
  }

  function scheduleAgendaFromPanel(phoneKey, date, time, tplData = {}) {
    const jid = phoneKeyToJid(phoneKey);
    if (!jid) return false;

    const baseTs = new Date(`${date}T${time}:00`).getTime();
    const oneDay = 24 * 60 * 60 * 1000;
    const list = data.agendas[jid] || [];

    const items = [
      { key: 'agenda0', at: baseTs - 7 * oneDay, data: tplData, sent: false },
      { key: 'agenda1', at: baseTs - 3 * oneDay, data: tplData, sent: false },
      { key: 'agenda2', at: baseTs - 1 * oneDay, data: tplData, sent: false },
    ];

    // remove existentes e substitui
    data.agendas[jid] = items.filter(x => x.at > Date.now() - oneDay);
    saveAgendas();

    const lead = getLead(jid);
    lead.stage = 'agendado';
    lead.updatedAt = nowTs();
    data.leads[jid] = lead;
    saveLeads();

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
    saveAgendas();
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
    saveLeads();

    const key = payload.productKey || 'ironGlassPlus';
    const q = data.quotesConfig[key] || data.quotesConfig.ironGlassPlus;
    const tpl = q.template || '';
    const text = applyTemplate(tpl, {
      VEICULO: payload.vehicle || lead.model || '',
      ANO: payload.year || lead.year || '',
      VALOR: payload.value || '',
      PAGAMENTO: payload.payment || '',
    });

    return sendTextSafe(jid, text, { step: `quote_${key}` });
  }

  function updateQuotes(nextQuotes = {}) {
    data.quotesConfig = { ...data.quotesConfig, ...nextQuotes };
    saveQuotes();
    return true;
  }

  // start scheduler even if not connected (for state maintenance)
  setState({ enabled: true });

  return {
    // WA
    connect,
    disconnect,

    // state/panel
    getStatus,
    setEnabled,
    getConfig,
    getLeads,
    getDataSnapshot,

    // settings
    updateMessages,
    updateConfig,
    setCommands,
    updateQuotes,

    // lead actions
    updateLead,
    pauseFollowUp,
    stopFollowUp,
    setManualOff,
    blockFollowUp,
    markAsClient,

    // agenda/program/quote
    scheduleAgendaFromPanel,
    sendConfirmNow,
    cancelAgenda,
    programStartMessage,
    sendQuoteNow,
  };
}

module.exports = { createBot };
