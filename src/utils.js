const fs = require('fs');
const path = require('path');

function loadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[JSON] Erro ao ler ${path.basename(file)}:`, e?.message || e);
    return fallback;
  }
}

function saveJSON(file, data) {
  // ✅ FIX Railway: garante que a pasta exista antes de escrever
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function htmlEscape(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyTemplate(tpl, data) {
  let out = tpl || '';
  for (const [k, v] of Object.entries(data || {})) {
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), v ?? '');
  }
  out = out.replace(/{{\w+}}/g, '').replace(/\n\n\n+/g, '\n\n').trim();
  return out;
}

function normalizePhoneKeyFromJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  if (!jid.includes('@')) return null;
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const raw = jid.split('@')[0];
  const digits = String(raw).replace(/\D/g, '');
  return digits || null;
}

function getPhoneKeyFromMsg(msg, jid) {
  const byJid = normalizePhoneKeyFromJid(jid);
  if (byJid) return byJid;

  const spn = msg?.key?.senderPn;
  if (spn) {
    const digits = String(spn).replace(/\D/g, '');
    if (digits.length >= 10) return digits.startsWith('55') ? digits : ('55' + digits);
  }

  const part = msg?.key?.participant;
  const byPart = normalizePhoneKeyFromJid(part);
  if (byPart) return byPart;

  return null;
}

function migrateBlockedStructure(raw) {
  if (!raw || typeof raw !== 'object') return { phones: {}, legacy: {} };
  if (raw.phones && raw.legacy && typeof raw.phones === 'object' && typeof raw.legacy === 'object') return raw;

  const out = { phones: {}, legacy: {} };
  for (const [k, v] of Object.entries(raw)) {
    const phoneKey = normalizePhoneKeyFromJid(k);
    if (phoneKey) out.phones[phoneKey] = v;
    else out.legacy[k] = v;
  }
  return out;
}

// Extrai modelo/ano de um texto (heurístico). Retorna { model, year } ou {}
function parseCarInfo(text) {
  const t = (text || '').toString();
  const out = {};

  // ano 4 dígitos
  const y4 = t.match(/\b(19\d{2}|20\d{2})\b/);
  if (y4) out.year = Number(y4[1]);

  // ano tipo "19" ou "21" depois de modelo (muito heurístico)
  if (!out.year) {
    const y2 = t.match(/\b(\d{2})\b/);
    if (y2) {
      const n = Number(y2[1]);
      if (n >= 0 && n <= 40) out.year = 2000 + n;
      if (n >= 70 && n <= 99) out.year = 1900 + n;
    }
  }

  // modelo: pega até 3 palavras antes do ano, e limpa
  if (out.year) {
    const idx = t.indexOf(String(out.year));
    if (idx > 0) {
      const before = t.slice(0, idx).trim();
      const parts = before.split(/\s+/).slice(-3);
      const guess = parts.join(' ').replace(/[^\wÀ-ÿ\s-]/g, '').trim();
      if (guess && guess.length >= 3) out.model = guess.toUpperCase();
    }
  }

  return out;
}

module.exports = {
  loadJSON, saveJSON,
  htmlEscape, applyTemplate,
  normalizePhoneKeyFromJid, getPhoneKeyFromMsg, migrateBlockedStructure,
  parseCarInfo
};
