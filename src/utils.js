const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJSON(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTemplate(tpl, data = {}) {
  return String(tpl || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k).toUpperCase();
    return data[key] != null ? String(data[key]) : '';
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nowTs() {
  return Date.now();
}

function randomInt(min, max) {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : ('55' + d);
}

function jidToPhoneKey(jid) {
  return String(jid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
}

function phoneKeyToJid(phoneKey) {
  const p = normalizePhone(phoneKey);
  return p ? `${p}@s.whatsapp.net` : '';
}

/**
 * Hora local de São Paulo (independiente del timezone del servidor)
 */
function getSaoPauloHour(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  });
  return Number(fmt.format(date));
}

function isWithinWindow(windowCfg = {}, date = new Date()) {
  const startHour = Number(windowCfg.startHour ?? 9);
  const endHour = Number(windowCfg.endHour ?? 22); // fin exclusivo
  const h = getSaoPauloHour(date);
  return h >= startHour && h < endHour;
}

function parseCarInfo(text) {
  const t = String(text || '').trim();
  if (!t) return { model: '', year: null };

  // año 19xx/20xx
  const ym = t.match(/\b(19\d{2}|20\d{2})\b/);
  const year = ym ? Number(ym[1]) : null;

  // modelo simple = texto sin año y sin exceso de espacios
  let model = t.replace(/\b(19\d{2}|20\d{2})\b/g, '').replace(/\s+/g, ' ').trim();

  // normalizaciones básicas
  model = model.replace(/[\-–—]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return { model, year };
}

module.exports = {
  ensureDir,
  loadJSON,
  saveJSON,
  htmlEscape,
  applyTemplate,
  sleep,
  nowTs,
  randomInt,
  normalizePhone,
  jidToPhoneKey,
  phoneKeyToJid,
  getSaoPauloHour,
  isWithinWindow,
  parseCarInfo,
};
