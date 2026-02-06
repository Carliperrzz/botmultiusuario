const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const {
  loadJSON, saveJSON,
  normalizePhoneKeyFromJid, getPhoneKeyFromMsg, migrateBlockedStructure,
  applyTemplate, parseCarInfo
} = require('./utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;

function nowISO() { return new Date().toISOString(); }

function defaultQuotes() {
  return {
    ironGlass: {
      title: 'Cotização Iron Glass',
      template:
        '🛡️ *Cotização Iron Glass*\n' +
        '🚗 Veículo: {{VEICULO}} ({{ANO}})\n' +
        '✅ Proteção premium dos vidros\n\n' +
        '💰 Valor: {{VALOR}}\n' +
        '💳 Pagamento: {{PAGAMENTO}}\n\n' +
        'Se quiser, já agendamos a instalação. 😉'
    },
    ironGlassPlus: {
      title: 'Cotização Iron Glass Plus',
      template:
        '🛡️ *Cotização Iron Glass Plus*\n' +
        '🚗 Veículo: {{VEICULO}} ({{ANO}})\n' +
        '⭐ Cobertura avançada + benefícios extra\n\n' +
        '💰 Valor: {{VALOR}}\n' +
        '💳 Pagamento: {{PAGAMENTO}}\n\n' +
        'Posso te mandar 2 horários disponíveis agora?'
    },
    defender: {
      title: 'Cotização Defender',
      template:
        '🛡️ *Cotização Defender*\n' +
        '🚗 Veículo: {{VEICULO}} ({{ANO}})\n\n' +
        '💰 Valor: {{VALOR}}\n' +
        '💳 Pagamento: {{PAGAMENTO}}\n\n' +
        'Quer que eu confirme os detalhes e já deixo reservado?'
    }
  };
}

function createBot({ botId, baseDir, authDir, eventLogger }) {
  const dataDir = path.join(baseDir, 'data', botId);

  const FILES = {
    clients: path.join(dataDir, 'clientes.json'),
    messages: path.join(dataDir, 'mensajes.json'),
    blocked: path.join(dataDir, 'bloqueados.json'),
    paused: path.join(dataDir, 'pausados.json'),
    agendas: path.join(dataDir, 'agendas.json'),
    program: path.join(dataDir, 'programados.json'),
    config: path.join(dataDir, 'config.json'),
    runtime: path.join(dataDir, 'runtime.json'),
    leads: path.join(dataDir, 'leads.json'),
    quotes: path.join(dataDir, 'quotes.json'),
  };

  // state
  let clients = {};
  let messagesConfig = {};
  let blocked = { phones: {}, legacy: {} };
  let paused = {};
  let agendas = {};
  let scheduledStarts = {};
  let leads = {};
  let quotesConfig = {};
  let config = {};
  let runtime = { enabled: true };

  let sock = null;
  let isConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  // queue
  let messageQueue = [];
  const queueSet = new Set();
  let sendingNow = false;
  const botSentRecently = new Set();
  const scheduledQueue = new Set();

  // rate limit (simple counters)
  let counters = {
    minKey: '',
    hourKey: '',
    dayKey: '',
    perMinute: 0,
    perHour: 0,
    perDay: 0,
    perContactDay: {} // phoneKey -> count
  };

  function loadAll() {
    clients = loadJSON(FILES.clients, {});
    messagesConfig = loadJSON(FILES.messages, {});
    blocked = migrateBlockedStructure(loadJSON(FILES.blocked, { phones:{}, legacy:{} }));
    paused = loadJSON(FILES.paused, {});
    agendas = loadJSON(FILES.agendas, {});
    scheduledStarts = loadJSON(FILES.program, {});
    config = loadJSON(FILES.config, {});
    runtime = loadJSON(FILES.runtime, { enabled: true });
    leads = loadJSON(FILES.leads, {});
    quotesConfig = loadJSON(FILES.quotes, defaultQuotes());
    saveQuotes();

    // persist blocked structure if needed
    saveJSON(FILES.blocked, blocked);
  }

  function saveClients() { saveJSON(FILES.clients, clients); }
  function saveMessages() { saveJSON(FILES.messages, messagesConfig); }
  function saveBlocked() { saveJSON(FILES.blocked, blocked); }
  function savePaused() { saveJSON(FILES.paused, paused); }
  function saveAgendas() { saveJSON(FILES.agendas, agendas); }
  function saveProgram() { saveJSON(FILES.program, scheduledStarts); }
  function saveConfig() { saveJSON(FILES.config, config); }
  function saveRuntime() { saveJSON(FILES.runtime, runtime); }
  function saveLeads() { saveJSON(FILES.leads, leads); }
  function saveQuotes() { saveJSON(FILES.quotes, quotesConfig); }

  function getWindow() { return config?.window || { startHour: 9, endHour: 22 }; }
  function getFollow() { return config?.followup || { stepsDays:[3,5,7,15], extraIntervalDays:30 }; }
  function getAgendaCfg() { return config?.agenda || { offsetsDays:[7,3,1] }; }
  function getCommands() { return config?.commands || {}; }
  function getRules() { return config?.rules || { minYearFollowUp: 2022 }; }
  function getLimits() { return config?.limits || { perMinute: 8, perHour: 120, perDay: 400, perContactPerDay: 2 }; }

  function isInsideWindow(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    const w = getWindow();
    return h >= Number(w.startHour || 9) && h < Number(w.endHour || 22);
  }

  function markBotSent(jid) {
    botSentRecently.add(jid);
    setTimeout(() => botSentRecently.delete(jid), 2 * 60 * 1000);
  }

  function isBlocked(jid, phoneKey) {
    if (phoneKey && blocked?.phones?.[phoneKey]) return true;
    if (jid && blocked?.legacy?.[jid]) return true;
    return false;
  }

  function enqueue(item) {
    const k = `${item.kind}:${item.jid}:${item.key || ''}`;
    if (queueSet.has(k)) return;
    queueSet.add(k);
    messageQueue.push(item);
  }

  function dequeue() {
    const item = messageQueue.shift();
    if (!item) return null;
    const k = `${item.kind}:${item.jid}:${item.key || ''}`;
    queueSet.delete(k);
    return item;
  }

  function startFollowUp(jid, extraData = {}) {
    const phoneKey = normalizePhoneKeyFromJid(jid);
    if (isBlocked(jid, phoneKey)) return;

    // rules: if year known and < minYearFollowUp -> do not start
    const rules = getRules();
    const minYear = Number(rules?.minYearFollowUp || 2022);

    const existing = clients[jid] || {};
    const year = extraData.year ?? existing.year;
    const model = extraData.model ?? existing.model;

    if (year && Number(year) < minYear) {
      // keep record, but don't follow
      clients[jid] = {
        ...existing,
        lastContact: Date.now(),
        year: Number(year),
        model: model || existing.model || '',
        stage: 'no_follow_year',
        nextFollowUpAt: null,
        stepIndex: 0,
        ignoreNextFromMe: false,
        manualOffUntil: null,
      };
      saveClients();
      return;
    }

    const now = Date.now();
    const follow = getFollow();
    clients[jid] = {
      ...existing,
      lastContact: now,
      stepIndex: 0,
      nextFollowUpAt: now + Number(follow.stepsDays[0]) * DAY_MS,
      ignoreNextFromMe: false,
      stage: existing.stage || 'lead',
      model: model || existing.model || '',
      year: year ? Number(year) : existing.year,
      manualOffUntil: existing.manualOffUntil || null,
      isClient: existing.isClient || false
    };
    saveClients();
  }

  function stopFollowUp(jid) {
    if (clients[jid]) {
      delete clients[jid];
      saveClients();
    }
    // remove queued funil items
    messageQueue = messageQueue.filter(it => !(it.jid === jid && it.kind === 'funil'));
    for (const k of Array.from(queueSet)) {
      if (k.startsWith(`funil:${jid}:`)) queueSet.delete(k);
    }
  }

  function pauseFollowUp(jid, ms = 72 * 60 * 60 * 1000) {
    paused[jid] = { pausedAt: Date.now(), ms };
    savePaused();
    // clean queued funil
    messageQueue = messageQueue.filter(item => !(item.jid === jid && item.kind === 'funil'));
    for (const k of Array.from(queueSet)) {
      if (k.startsWith(`funil:${jid}:`)) queueSet.delete(k);
    }
    stopFollowUp(jid);
  }

  function setManualOff(jid, ms) {
    const c = clients[jid] || {};
    c.manualOffUntil = Date.now() + ms;
    clients[jid] = c;
    saveClients();
  }

  function blockFollowUp(jid, phoneKey, reason = 'STOP') {
    const pk = phoneKey || normalizePhoneKeyFromJid(jid);
    if (pk) blocked.phones[pk] = { blockedAt: Date.now(), reason };
    else blocked.legacy[jid] = { blockedAt: Date.now(), reason };
    saveBlocked();

    pauseFollowUp(jid);
    stopFollowUp(jid);

    cancelAgenda(jid);

    if (scheduledStarts[jid]) {
      delete scheduledStarts[jid];
      saveProgram();
      scheduledQueue.delete(jid);
    }

    // clear any queued items
    messageQueue = messageQueue.filter(m => m.jid !== jid);
    for (const k of Array.from(queueSet)) {
      if (k.includes(`:${jid}:`)) queueSet.delete(k);
    }
  }

  function scheduleAgenda(jid, appointmentTs, meta) {
    const now = Date.now();
    const list = [];
    const payload = meta || {};

    stopFollowUp(jid);

    // remove queued funil
    messageQueue = messageQueue.filter(item => !(item.jid === jid && item.kind === 'funil'));
    for (const k of Array.from(queueSet)) {
      if (k.startsWith(`funil:${jid}:`)) queueSet.delete(k);
    }

    if (scheduledStarts[jid]) {
      delete scheduledStarts[jid];
      saveProgram();
      scheduledQueue.delete(jid);
    }

    const cfg = getAgendaCfg();
    for (let idx = 0; idx < cfg.offsetsDays.length; idx++) {
      const days = Number(cfg.offsetsDays[idx]);
      const at = appointmentTs - days * DAY_MS;
      if (at > now) {
        list.push({ at, key: `agenda${idx}`, data: payload });
      }
    }

    if (list.length === 0) return;

    agendas[jid] = list.sort((a, b) => a.at - b.at);
    saveAgendas();
  }

  function cancelAgenda(jid) {
    if (agendas[jid]) {
      delete agendas[jid];
      saveAgendas();
    }
    messageQueue = messageQueue.filter(m => !(m.jid === jid && m.kind === 'agenda'));
    for (const k of Array.from(queueSet)) {
      if (k.startsWith(`agenda:${jid}:`)) queueSet.delete(k);
    }
  }

  function parseAgendaConfirmation(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (!lower.includes('confirma') && !lower.includes('agend') && !lower.includes('agenda')) return null;

    const dateMatch = lower.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (!dateMatch) return null;

    let d = dateMatch[1], m = dateMatch[2], y = dateMatch[3];
    if (y.length === 2) y = '20' + y;

    const timeMatch = lower.match(/(\d{1,2})\s*[:h]\s*(\d{2})/i);
    let hh = '09', mm = '00';
    if (timeMatch) {
      hh = String(timeMatch[1]).padStart(2, '0');
      mm = String(timeMatch[2]).padStart(2, '0');
    }

    const iso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T${hh}:${mm}:00`;
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return null;
    return ts;
  }

  function getMsgMs(msg) {
    if (msg.messageTimestamp) return Number(msg.messageTimestamp) * 1000;
    return Date.now();
  }

  function canSendNow(jid) {
    const limits = getLimits();
    const now = new Date();
    const minKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    const hourKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}`;
    const dayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;

    if (counters.minKey !== minKey) { counters.minKey = minKey; counters.perMinute = 0; }
    if (counters.hourKey !== hourKey) { counters.hourKey = hourKey; counters.perHour = 0; }
    if (counters.dayKey !== dayKey) { counters.dayKey = dayKey; counters.perDay = 0; counters.perContactDay = {}; }

    const phoneKey = normalizePhoneKeyFromJid(jid) || jid;
    const perContact = counters.perContactDay[phoneKey] || 0;

    if (counters.perMinute >= Number(limits.perMinute || 8)) return false;
    if (counters.perHour >= Number(limits.perHour || 120)) return false;
    if (counters.perDay >= Number(limits.perDay || 400)) return false;
    if (perContact >= Number(limits.perContactPerDay || 2)) return false;

    counters.perMinute++;
    counters.perHour++;
    counters.perDay++;
    counters.perContactDay[phoneKey] = perContact + 1;
    return true;
  }

  function startScheduleChecker() {
    setInterval(() => {
      if (!runtime.enabled) return;
      const now = Date.now();

      // funil
      for (const [jid, c] of Object.entries(clients)) {
        const phoneKey = normalizePhoneKeyFromJid(jid);
        if (isBlocked(jid, phoneKey)) continue;
        if (paused[jid]) continue;
        if (c.manualOffUntil && Date.now() < c.manualOffUntil) continue;
        if (!c.nextFollowUpAt) continue;
        if (now >= c.nextFollowUpAt) enqueue({ jid, kind: 'funil' });
      }

      // agenda
      for (const [jid, arr] of Object.entries(agendas)) {
        const phoneKey = normalizePhoneKeyFromJid(jid);
        if (isBlocked(jid, phoneKey)) continue;
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          if (now >= it.at) enqueue({ jid, kind: 'agenda', key: it.key });
        }
      }

      // programados
      for (const [jid, s] of Object.entries(scheduledStarts || {})) {
        if (!s || !s.at) continue;
        if (now >= s.at) {
          const phoneKey = normalizePhoneKeyFromJid(jid);
          if (isBlocked(jid, phoneKey)) continue;
          if (!scheduledQueue.has(jid)) {
            enqueue({ jid, kind: 'startFunil' });
            scheduledQueue.add(jid);
          }
        }
      }
    }, 60 * 1000);
  }

  function startMessageSender() {
    setInterval(async () => {
      if (!runtime.enabled) return;
      if (!sock || sendingNow) return;
      const item = dequeue();
      if (!item) return;

      if (!isConnected) {
        // put back
        enqueue(item);
        return;
      }

      const now = Date.now();
      if (!isInsideWindow(now)) {
        enqueue(item);
        return;
      }

      const c = clients[item.jid];
      if (c?.manualOffUntil && Date.now() < c.manualOffUntil) return;

      // jitter 5-55s
      const jitterMs = 5000 + Math.floor(Math.random() * 50000);
      sendingNow = true;
      await new Promise(r => setTimeout(r, jitterMs));

      try {
        const { jid, kind, key } = item;
        const phoneKey = normalizePhoneKeyFromJid(jid);
        if (isBlocked(jid, phoneKey)) return;

        if (!canSendNow(jid)) {
          // back to queue later
          enqueue(item);
          return;
        }

        if (kind === 'funil') {
          const follow = getFollow();
          const c = clients[jid];
          if (!c) return;

          let msgKey = 'extra';
          if (c.isClient) msgKey = 'postSale30';
          else if (c.stepIndex >= 0 && c.stepIndex <= follow.stepsDays.length - 1) msgKey = `step${c.stepIndex}`;

          const texto =
            messagesConfig[msgKey] ||
            (c.isClient ? messagesConfig.postSale30 : null) ||
            messagesConfig.extra ||
            'Olá! Tudo bem?';

          c.ignoreNextFromMe = true;
          saveClients();

          markBotSent(jid);
          await sock.sendMessage(jid, { text: texto });
          try { const c0 = clients[jid]||{}; const pk = normalizePhoneKeyFromJid(jid)||''; eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'auto_sent', kind:'agenda', phoneKey: pk, jid, model: c0.model||null, year: c0.year||null, key }); } catch(_){}

          try { const c0 = clients[jid]||{}; const pk = normalizePhoneKeyFromJid(jid)||''; eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'auto_sent', kind:'funil', phoneKey: pk, jid, model: c0.model||null, year: c0.year||null }); } catch(_){}

          const sentAt = Date.now();
          c.lastContact = sentAt;

          if (c.isClient) {
            c.stepIndex = follow.stepsDays.length;
            c.nextFollowUpAt = sentAt + Number(follow.extraIntervalDays) * DAY_MS;
          } else if (c.stepIndex < follow.stepsDays.length - 1) {
            c.stepIndex += 1;
            const dias = Number(follow.stepsDays[c.stepIndex]);
            c.nextFollowUpAt = sentAt + dias * DAY_MS;
          } else {
            c.stepIndex += 1;
            c.nextFollowUpAt = sentAt + Number(follow.extraIntervalDays) * DAY_MS;
          }
          saveClients();
        }

        if (kind === 'agenda') {
          const arr = agendas[jid];
          if (!Array.isArray(arr)) return;
          const it = arr.find(x => x.key === key);
          if (!it) return;

          const baseText = messagesConfig[key] || '📅 Lembrete do seu agendamento Iron Glass.';
          const data = Object.assign({}, it.data || {});

          if ((!data.DATA || !data.HORA) && it.at) {
            let offsetDays = null;
            if (key === 'agenda0') offsetDays = 7;
            else if (key === 'agenda1') offsetDays = 3;
            else if (key === 'agenda2') offsetDays = 1;

            if (offsetDays != null) {
              const apptTs = it.at + offsetDays * DAY_MS;
              const d = new Date(apptTs);
              const dd = String(d.getDate()).padStart(2, '0');
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const yyyy = d.getFullYear();
              const hh = String(d.getHours()).padStart(2, '0');
              const min = String(d.getMinutes()).padStart(2, '0');
              data.DATA = `${dd}/${mm}/${yyyy}`;
              data.HORA = `${hh}:${min}`;
            }
          }

          const texto = applyTemplate(baseText, data);
          markBotSent(jid);
          await sock.sendMessage(jid, { text: texto });

          agendas[jid] = arr.filter(x => x.key !== key);
          if (agendas[jid].length === 0) delete agendas[jid];
          saveAgendas();
        }

        if (kind === 'startFunil') {
          const s = scheduledStarts[jid];
          if (!s || !s.at) return;

          const texto = (s.text && s.text.trim()) || messagesConfig.step0 || 'Olá! Tudo bem?';
          markBotSent(jid);
          await sock.sendMessage(jid, { text: texto });
          try { const c0 = clients[jid]||{}; const pk = normalizePhoneKeyFromJid(jid)||''; eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'auto_sent', kind:'program_start', phoneKey: pk, jid, model: c0.model||null, year: c0.year||null }); } catch(_){}

          startFollowUp(jid);

          delete scheduledStarts[jid];
          saveProgram();
          scheduledQueue.delete(jid);
        }

      } catch (err) {
        console.error(`[${botId}] [SEND] erro:`, err?.message || err);
        enqueue(item);
      } finally {
        sendingNow = false;
      }
    }, 60 * 1000);
  }

  function setupMessageHandler() {
    if (!sock) return;

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages?.[0];
      if (!msg || !msg.message) return;

      const remoteJid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;

      let jid = remoteJid;
      if (remoteJid && remoteJid.endsWith('@lid')) {
        const real = msg.key.senderPn || msg.key.participant;
        if (real && real.endsWith('@s.whatsapp.net')) jid = real;
      }

      if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter')) return;

      const phoneKey = getPhoneKeyFromMsg(msg, jid);

      const msgMs = getMsgMs(msg);
      if (Date.now() - msgMs > RECENT_WINDOW_MS) return;

      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        '';

      const lower = (body || '').toLowerCase();
      const c = clients[jid];
      const cmds = getCommands();

      // log inbound for stats
      try {
        const car = parseCarInfo(body);
        eventLogger({
          botId, ts: Date.now(), iso: nowISO(),
          phoneKey: phoneKey || '',
          jid,
          action: 'inbound_message',
          textPreview: String(body || '').slice(0, 120),
          model: car.model || null,
          year: car.year || null
        });
        // Save car info to client (even if we won't follow)
        if (car.year || car.model) {
          const cur = clients[jid] || {};
          clients[jid] = { ...cur, year: car.year ?? cur.year, model: car.model ?? cur.model };
          saveClients();
        }
        // Lead CRM update
        ensureLead(jid, phoneKey);
        upsertLead(jid, phoneKey, { lastInboundAt: Date.now(), model: car.model || null, year: car.year || null });
      } catch (_) {}

      if (fromMe) {
        const isCmd = lower.includes((cmds.stop||'').toLowerCase()) ||
                      lower.includes((cmds.pause||'').toLowerCase()) ||
                      lower.includes((cmds.client||'').toLowerCase()) ||
                      lower.includes((cmds.remove||'').toLowerCase()) ||
                      lower.includes((cmds.botOff||'').toLowerCase());

        if (botSentRecently.has(jid) && !isCmd) return;

        if (cmds.stop && lower.includes(cmds.stop.toLowerCase())) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          blockFollowUp(jid, phoneKey, 'MANUAL_STOP');
          return;
        }
        if (cmds.pause && lower.includes(cmds.pause.toLowerCase())) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          pauseFollowUp(jid);
          return;
        }
        if (cmds.remove && lower.includes(cmds.remove.toLowerCase())) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          stopFollowUp(jid);
          return;
        }
        if (cmds.botOff && lower.includes(cmds.botOff.toLowerCase())) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          setManualOff,
    markAsClient(jid, 24 * 60 * 60 * 1000);
          return;
        }
        if (cmds.client && lower.includes(cmds.client.toLowerCase())) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          cancelAgenda(jid);
          startPostSaleMonthly(jid);
          return;
        }

        const apptTs = parseAgendaConfirmation(body);
        if (apptTs) {
          if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
          scheduleAgenda(jid, apptTs);
          stopFollowUp(jid);
          return;
        }

        if (c && c.ignoreNextFromMe) {
          c.ignoreNextFromMe = false;
          saveClients();
          return;
        }

        // if seller is talking, start followup (unless agenda active), respecting year rules
        if (!isBlocked(jid, phoneKey)) {
          if (agendas[jid] && Array.isArray(agendas[jid]) && agendas[jid].length > 0) {
            // don't start
          } else {
            startFollowUp(jid);
          }
        }
        return;
      }

      // client message
      if (isBlocked(jid, phoneKey)) return;

      // pause window per jid
      if (paused[jid]) {
        const pausedAt = paused[jid].pausedAt || paused[jid];
        const ms = paused[jid].ms || (72 * 60 * 60 * 1000);
        const until = pausedAt + ms;
        if (Date.now() < until) return;
        delete paused[jid];
        savePaused();
      }

      const c2 = clients[jid];
      if (c2 && c2.isClient) {
        c2.lastContact = Date.now();
        saveClients();
        return;
      }

      // update car info if present
      const car = parseCarInfo(body);
      startFollowUp(jid, car);
    });
  }

  function startPostSaleMonthly(jid) {
    const phoneKey = normalizePhoneKeyFromJid(jid);
    if (isBlocked(jid, phoneKey)) return;

    const now = Date.now();
    const follow = getFollow();
    const c = clients[jid] || {};

    c.isClient = true;
    c.stepIndex = follow.stepsDays.length;
    c.lastContact = now;
    c.nextFollowUpAt = now + Number(follow.extraIntervalDays) * DAY_MS;
    c.ignoreNextFromMe = false;

    clients[jid] = c;
    saveClients();

    if (paused[jid]) {
      delete paused[jid];
      savePaused();
    }
  }
function markAsClient(jid) {
    // Marca contato como cliente (pós-venda) e ativa fluxo mensal
    startPostSaleMonthly(jid);
    const pk = normalizePhoneKeyFromJid(jid) || '';
    upsertLead(jid, pk, { stage: 'fechado', isClient: true, lastOutboundAt: Date.now() });
    eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'marked_client', phoneKey: pk });
  }


  async function cleanupSocket() {
    try {
      if (sock?.ev) sock.ev.removeAllListeners();
      if (sock?.ws) sock.ws.close();
      if (sock?.end) sock.end();
    } catch (_) {}
    sock = null;
    isConnected = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(30000, 3000 * reconnectAttempts);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await startBot();
    }, delay);
  }

  let qrString = null;

  async function startBot() {
    try {
      await cleanupSocket();

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'error' }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false
      });

      // block receipts
      const blockReceipt = (name) => async (...args) => { return; };
      if (sock.readMessages) sock.readMessages = blockReceipt('readMessages');
      if (sock.sendReadReceipt) sock.sendReadReceipt = blockReceipt('sendReadReceipt');
      if (sock.sendReceipt) sock.sendReceipt = blockReceipt('sendReceipt');

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) qrString = qr;

        if (connection === 'open') {
          isConnected = true;
          reconnectAttempts = 0;
          qrString = null;
          eventLogger({ botId, ts: Date.now(), iso: nowISO(), action: 'connected' });
        } else if (connection === 'close') {
          isConnected = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          eventLogger({ botId, ts: Date.now(), iso: nowISO(), action: 'disconnected', statusCode: statusCode || null });

          if (statusCode !== DisconnectReason.loggedOut) {
            scheduleReconnect();
          } else {
            // logged out: QR will appear on next start
          }
        }
      });

      setupMessageHandler();
    } catch (err) {
      console.error(`[${botId}] startBot error:`, err?.message || err);
      scheduleReconnect();
    }
  }

  // public controls
  async function connect() {
    loadAll();
    await startBot();
  }
  async function disconnect() {
    await cleanupSocket();
  }
  function setEnabled(enabled) {
    runtime.enabled = Boolean(enabled);
    saveRuntime();
  }

  function getStatus() {
    return {
      botId,
      connected: isConnected,
      hasQR: Boolean(qrString),
      enabled: Boolean(runtime?.enabled),
      queueSize: messageQueue.length,
      qr: qrString
    };
  }

  function getDataSnapshot() {
    loadAll();
    return { clients, messagesConfig, blocked, paused, agendas, scheduledStarts, leads, quotesConfig, config, runtime };
  }

  function updateQuotes(newQuotes) {
    quotesConfig = { ...quotesConfig, ...newQuotes };
    saveQuotes();
  }

  function updateLead(jid, patch) {
    if (!jid) return null;
    const pk = normalizePhoneKeyFromJid(jid) || (leads[jid]?.phoneKey) || '';
    return upsertLead(jid, pk, patch || {});
  }

  function getLeadsList() {
    loadAll();
    return Object.values(leads || {}).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  }

  async function sendQuoteNow(phoneKey, payload) {
    const jid = phoneKey + '@s.whatsapp.net';
    if (!sock || !isConnected) return { ok:false, error:'not_connected' };
    const productKey = payload?.productKey || 'ironGlassPlus';
    const tpl = quotesConfig?.[productKey]?.template || '';
    const text = applyTemplate(tpl, {
      VEICULO: payload?.vehicle || '',
      ANO: String(payload?.year || ''),
      VALOR: payload?.value || '',
      PAGAMENTO: payload?.payment || ''
    });
    try {
      markBotSent(jid);
      await sock.sendMessage(jid, { text });
      upsertLead(jid, phoneKey, { lastOutboundAt: Date.now(), stage: 'cotizado', lastQuoteAt: Date.now(), lastQuoteProduct: productKey, lastQuoteValue: payload?.value || '' });
      eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'quote_sent', phoneKey, productKey, value: payload?.value || '' });
      return { ok:true, text };
    } catch (e) {
      return { ok:false, error: e?.message || String(e) };
    }
  }

  function updateMessages(newMessages) {
    messagesConfig = { ...messagesConfig, ...newMessages };
    saveMessages();
  }

  function updateConfig(partial) {
    config = { ...config, ...partial };
    saveConfig();
  }

  function setCommands(commands) {
    config.commands = { ...(config.commands || {}), ...(commands || {}) };
    saveConfig();
  }

  function setRules(rules) {
    config.rules = { ...(config.rules || {}), ...(rules || {}) };
    saveConfig();
  }

  async function sendConfirmNow(phoneKey, data) {
    const jid = phoneKey + '@s.whatsapp.net';
    if (!sock || !isConnected) return { ok:false, error:'not_connected' };
    const text = applyTemplate(messagesConfig.confirmTemplate, data);
    try {
      markBotSent(jid);
      await sock.sendMessage(jid, { text });
      upsertLead(jid, phoneKey, { lastOutboundAt: Date.now(), stage: 'agendado' });
      eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'confirm_sent', phoneKey });
      return { ok:true };
    } catch (e) {
      return { ok:false, error: e?.message || String(e) };
    }
  }

  function scheduleAgendaFromPanel(phoneKey, date, time, meta) {
    const jid = phoneKey + '@s.whatsapp.net';
    const apptTs = new Date(`${date}T${time}:00`).getTime();
    scheduleAgenda(jid, apptTs, meta);
    upsertLead(jid, phoneKey, { stage: 'agendado' });
    eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'agenda_set', phoneKey, apptTs });
  }

  function programStartMessage(phoneKey, date, time, text) {
    const jid = phoneKey + '@s.whatsapp.net';
    const ts = new Date(`${date}T${time || '09:00'}:00`).getTime();
    if (!ts || Number.isNaN(ts)) return false;
    scheduledStarts[jid] = { at: ts, text: (text || '').trim() };
    saveProgram();
    pauseFollowUp(jid);
    scheduledQueue.delete(jid);
    upsertLead(jid, phoneKey, { stage: 'programado' });
    eventLogger({ botId, ts: Date.now(), iso: nowISO(), action:'program_set', phoneKey, at: ts });
    return true;
  }

  // init
  loadAll();
  startScheduleChecker();
  startMessageSender();

  // auto-connect on boot (so QR appears in panel)
  // but allow runtime.enabled to control sending
  connect();

  return {
    botId,
    connect, disconnect,
    setEnabled,
    getStatus,
    getConfig: () => config,
    getLeads: () => leads,
    getDataSnapshot,
    updateMessages,
    sendQuoteNow,
    getLeadsList,
    updateLead,
    updateQuotes,
    updateConfig,
    setCommands,
    setRules,
    sendConfirmNow,
    scheduleAgendaFromPanel,
    cancelAgenda,
    programStartMessage,
    stopFollowUp,
    pauseFollowUp,
    blockFollowUp,
    setManualOff,
    markAsClient
  };
}

module.exports = { createBot };
function upsertLead(jid, phoneKey, patch) {
  const cur = leads[jid] || { jid, phoneKey: phoneKey || '', createdAt: Date.now() };
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  leads[jid] = next;
  saveLeads();
  return next;
}

function ensureLead(jid, phoneKey) {
  if (!jid) return null;
  return upsertLead(jid, phoneKey || '', {});
}

