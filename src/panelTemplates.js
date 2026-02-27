const QRCode = require('qrcode');
const { htmlEscape } = require('./utils');

async function qrDataUrl(qr) {
  if (!qr) return null;
  try {
    return await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  } catch (e) {
    return null;
  }
}

function baseShell({ title = 'Painel', user, bodyHtml = '', mobile = true }) {
  const isAdmin = user?.role === 'admin';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${htmlEscape(title)}</title>
  <style>
    :root{
      --bg:#0b1220; --card:#0f172a; --line:#1f2a44; --text:#e5e7eb; --muted:#94a3b8;
      --yellow:#facc15; --red:#ef4444; --green:#22c55e; --blue:#2563eb;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    a{color:inherit}
    .wrap{max-width:${mobile ? '760px' : '1200px'};margin:0 auto;padding:12px}
    .topbar{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap}
    .brand{font-weight:900}
    .muted{color:var(--muted);font-size:12px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:12px}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media (max-width:700px){ .grid2{grid-template-columns:1fr} }
    label{display:block;margin:8px 0 4px;color:var(--muted);font-size:12px}
    input,select,textarea{
      width:100%;background:#0b1220;color:var(--text);border:1px solid var(--line);
      border-radius:12px;padding:10px 12px;font-size:14px
    }
    textarea{min-height:100px;resize:vertical}
    table{border-collapse:collapse}
    th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;font-size:13px;vertical-align:top}
    .btn{
      display:inline-flex;align-items:center;justify-content:center;gap:6px;
      border:none;border-radius:12px;padding:10px 12px;font-size:13px;font-weight:800;cursor:pointer
    }
    .btn-primary{background:var(--yellow);color:#111827}
    .btn-danger{background:var(--red);color:white}
    .btn-ok{background:var(--green);color:#08130c}
    .btn-ghost{background:#111827;color:#e5e7eb;border:1px solid var(--line)}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--muted)}
    .qr{display:flex;justify-content:center}
    .qr img{width:260px;max-width:100%;background:#fff;border-radius:12px;padding:8px}
    .nav{display:flex;gap:8px;flex-wrap:wrap}
    .nav a{
      text-decoration:none;padding:8px 10px;border-radius:10px;background:#111827;border:1px solid var(--line);font-size:12px
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <div class="brand">🛡️ Iron Glass MultiBot</div>
        <div class="muted">Usuário: <b>${htmlEscape(user?.username || '')}</b> · Perfil: <b>${htmlEscape(user?.role || '')}</b></div>
      </div>
      <div class="row">
        <a class="btn btn-ghost" style="text-decoration:none" href="/m">Painel</a>
        <a class="btn btn-ghost" style="text-decoration:none" href="/m/leads">Leads</a>
        <a class="btn btn-ghost" style="text-decoration:none" href="/m/messages">Mensagens</a>
        <a class="btn btn-ghost" style="text-decoration:none" href="/m/rules">Regras</a>
        <a class="btn btn-ghost" style="text-decoration:none" href="/m/stats">Stats</a>
        ${isAdmin ? `<a class="btn btn-ghost" style="text-decoration:none" href="/admin">Admin</a><a class="btn btn-ghost" style="text-decoration:none" href="/m/users">Usuários</a>` : ``}
        <a class="btn btn-danger" style="text-decoration:none" href="/logout">Sair</a>
      </div>
    </div>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function layoutMobile({ title, user, bodyHtml }) {
  return baseShell({ title, user, bodyHtml, mobile: true });
}

function layoutDesktop({ title, user, bodyHtml }) {
  return baseShell({ title, user, bodyHtml, mobile: false });
}

module.exports = {
  qrDataUrl,
  layoutMobile,
  layoutDesktop,
};
