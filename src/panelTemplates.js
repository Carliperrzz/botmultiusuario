const QRCode = require('qrcode');
const { htmlEscape } = require('./utils');

async function qrDataUrl(qrText) {
  if (!qrText) return null;
  try {
    return await QRCode.toDataURL(qrText, { margin: 1, scale: 6 });
  } catch {
    return null;
  }
}

function layoutMobile({ title, user, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>${htmlEscape(title)}</title>
<style>
  :root{--bg:#0b1220;--card:#0f172a;--muted:#94a3b8;--line:#1f2a44;--accent:#facc15;--danger:#ef4444;--ok:#22c55e;}
  body{margin:0;background:var(--bg);color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
  .top{position:sticky;top:0;background:rgba(11,18,32,.92);backdrop-filter: blur(8px);border-bottom:1px solid var(--line);padding:12px 14px;z-index:10}
  .top h1{margin:0;font-size:16px;display:flex;align-items:center;gap:10px}
  .pill{font-size:12px;color:var(--muted);border:1px solid var(--line);padding:4px 10px;border-radius:999px}
  .wrap{padding:14px;max-width:720px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 12px;margin:10px 0}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .btn{appearance:none;border:none;border-radius:14px;padding:12px 14px;font-weight:700;font-size:14px;cursor:pointer}
  .btn-primary{background:var(--accent);color:#111827}
  .btn-ghost{background:transparent;color:#e5e7eb;border:1px solid var(--line)}
  .btn-danger{background:var(--danger);color:white}
  .btn-ok{background:var(--ok);color:#052e16}
  .muted{color:var(--muted);font-size:12px}
  input,textarea,select{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px}
  textarea{min-height:110px;resize:vertical}
  label{display:block;margin:10px 0 6px;color:var(--muted);font-size:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media (max-width:520px){.grid2{grid-template-columns:1fr}}
  a{color:#e5e7eb}
  .qr{display:flex;justify-content:center}
  .qr img{width:280px;max-width:92vw;border-radius:16px;border:1px solid var(--line);background:white}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .tab{padding:8px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;text-decoration:none;color:#e5e7eb}
  .tab.active{border-color:var(--accent);color:var(--accent)}
  .footer{padding:16px 14px 26px;color:var(--muted);font-size:12px;text-align:center}
</style>
</head>
<body>
  <div class="top">
    const u = user || { name: 'Usuário', role: 'viewer' };

<h1>📲 ${htmlEscape(title)} <span class="pill">${htmlEscape(u.name)} · ${htmlEscape(u.role)}</span></h1>
<div class="tabs">
      <a class="tab" href="/m">Painel</a>
      <a class="tab" href="/m/messages">Mensagens</a>
      <a class="tab" href="/m/quote">Cotizar</a>
      <a class="tab" href="/m/leads">Leads</a>
      <a class="tab" href="/m/dashboard">Dashboard</a>
      <a class="tab" href="/m/agenda">Agenda</a>
      <a class="tab" href="/m/program">Programar</a>
      <a class="tab" href="/m/commands">Comandos</a>
      <a class="tab" href="/m/rules">Regras</a>
      <a class="tab" href="/m/stats">Estatísticas</a>
      ${user.role === 'admin' ? `<a class="tab" href="/m/users">Usuários</a> <a class="tab" href="/admin">Desktop</a>` : ``}
      <a class="tab" href="/logout">Sair</a>
    </div>
  </div>
  <div class="wrap">${bodyHtml}</div>
  <div class="footer">${footerHtml || 'Iron Glass MultiBot · mobile-first'}</div>
</body>
</html>`;
}

function layoutDesktop({ title, bodyHtml }) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEscape(title)}</title>
<style>
  body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
  .wrap{max-width:1100px;margin:26px auto;padding:0 14px}
  .card{background:#0f172a;border:1px solid #1f2a44;border-radius:16px;padding:14px;margin:12px 0}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .btn{appearance:none;border:none;border-radius:999px;padding:10px 14px;font-weight:700;cursor:pointer}
  .btn-primary{background:#facc15;color:#111827}
  .btn-ghost{background:transparent;color:#e5e7eb;border:1px solid #1f2a44}
  .btn-danger{background:#ef4444;color:white}
  input,textarea,select{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #1f2a44;border-radius:12px;padding:10px 12px;font-size:14px}
  textarea{min-height:110px}
  label{display:block;margin:10px 0 6px;color:#94a3b8;font-size:12px}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #1f2a44;padding:10px;text-align:left}
  th{color:#94a3b8;font-size:12px}
  .muted{color:#94a3b8;font-size:12px}
  a{color:#e5e7eb}
</style>
</head>
<body>
<div class="wrap">${bodyHtml}</div>
</body></html>`;
}

module.exports = { qrDataUrl, layoutMobile, layoutDesktop };
