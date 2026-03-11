'use strict';
const QRCode = require('qrcode');
const { htmlEscape } = require('./utils');

async function qrDataUrl(qr){
  if (!qr) return null;
  try { return await QRCode.toDataURL(qr, { margin: 1, width: 320 }); }
  catch(_){ return null; }
}

function shell({ title='Painel', user, bodyHtml='' }){
  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${htmlEscape(title)}</title>
<style>
:root{--bg:#0b1220;--card:#0f172a;--line:#1f2a44;--text:#e5e7eb;--muted:#94a3b8;--y:#facc15;--r:#ef4444;--g:#22c55e;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
.wrap{max-width:900px;margin:0 auto;padding:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:12px}
.muted{color:var(--muted);font-size:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:12px;padding:10px 12px;font-weight:800;font-size:13px;cursor:pointer}
.btn-primary{background:var(--y);color:#111827}.btn-danger{background:var(--r);color:#fff}.btn-ghost{background:#111827;color:#e5e7eb;border:1px solid var(--line)}
.qr{display:flex;justify-content:center}.qr img{width:260px;background:#fff;border-radius:12px;padding:8px}
input,select,textarea{width:100%;background:#0b1220;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea{min-height:110px}
a{color:inherit}
</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`;
}

function layoutMobile({ title, user, bodyHtml }){ return shell({ title, user, bodyHtml }); }
function layoutDesktop({ title, user, bodyHtml }){ return shell({ title, user, bodyHtml }); }

module.exports = { qrDataUrl, layoutMobile, layoutDesktop };
