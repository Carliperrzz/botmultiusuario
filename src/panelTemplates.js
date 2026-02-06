const QRCode = require('qrcode');

// escape seguro (fallback si utils no existe)
function htmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function qrDataUrl(qrText) {
  if (!qrText) return null;
  return QRCode.toDataURL(qrText, { margin: 1, scale: 6 });
}

// 🔐 normaliza user (NUNCA undefined)
function normalizeUser(input = {}) {
  const u = input.user || {};
  const username = input.username || u.username || 'Usuário';
  const role = input.role || u.role || 'viewer';
  const name = u.name || username;
  return { username, role, name };
}

function baseHTML({ title, user, content, scripts = '' }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${htmlEscape(title)}</title>
  <style>
    body{margin:0;background:#0b1220;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{max-width:1200px;margin:0 auto;padding:16px}
    h1{font-size:18px;margin:0 0 12px 0}
    .pill{display:inline-block;border:1px solid #1f2a44;background:#0b1220;border-radius:999px;padding:6px 10px;font-size:12px;color:#94a3b8}
    .card{background:#0f172a;border:1px solid #1f2a44;border-radius:16px;padding:14px;margin-bottom:14px}
    .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .btn{cursor:pointer;border:none;border-radius:14px;padding:10px 14px;font-weight:700}
    .btn-yellow{background:#facc15;color:#111827}
    .btn-dark{background:#020617;color:#e5e7eb;border:1px solid #1f2a44}
    select,input,textarea{
      background:#020617;color:#e5e7eb;
      border:1px solid #1f2a44;border-radius:12px;
      padding:10px
    }
    textarea{width:100%;min-height:100px}
    img.qr{max-width:260px;background:#fff;padding:8px;border-radius:12px}
    .muted{color:#94a3b8;font-size:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>
      📲 Iron Glass MultiBot
      <span class="pill">${htmlEscape(user.name)} · ${htmlEscape(user.role)}</span>
      <a href="/logout" class="pill" style="float:right">Sair</a>
    </h1>

    ${content}
  </div>

  ${scripts}
</body>
</html>`;
}

// ---------------- MOBILE ----------------
function layoutMobile(props = {}) {
  const user = normalizeUser(props);
  const {
    botId = 'v1',
    allowedBotIds = [],
    status = {},
    qrDataUrl: qrImg,
    rules = {},
    messages = {},
    statsEndpoint = ''
  } = props;

  const bots = (allowedBotIds.length ? allowedBotIds : [botId])
    .map(b => `<option value="${b}" ${b === botId ? 'selected' : ''}>${b}</option>`)
    .join('');

  const content = `
  <div class="card">
    <div class="row">
      <b>Bot</b>
      <select onchange="location.href='/m?botId='+this.value">${bots}</select>
      <button class="btn btn-dark" onclick="toggleConnect()">Conectar</button>
      <button class="btn btn-yellow" onclick="toggleEnabled()">Ativar</button>
    </div>

    <p class="muted">Status:
      <b>${status.connected ? 'Conectado' : 'Desconectado'}</b> ·
      <b>${status.enabled ? 'Ativo' : 'Pausado'}</b> ·
      Fila: <b>${status.queueSize ?? 0}</b>
    </p>

    <div>
      ${qrImg ? `<img class="qr" src="${qrImg}"/>` : `<p class="muted">Sem QR</p>`}
    </div>
  </div>

  <div class="card">
    <h3>📊 Estatísticas</h3>
    <div id="stats" class="muted">Carregando…</div>
  </div>

  <div class="card">
    <h3>⚙️ Configuração</h3>
    <form method="POST" action="/save">
      <input type="hidden" name="botId" value="${htmlEscape(botId)}"/>
      <p class="muted">Rules (JSON)</p>
      <textarea name="rules">${htmlEscape(JSON.stringify(rules, null, 2))}</textarea>
      <p class="muted">Messages (JSON)</p>
      <textarea name="messages">${htmlEscape(JSON.stringify(messages, null, 2))}</textarea>
      <button class="btn btn-yellow" style="width:100%;margin-top:10px">Salvar</button>
    </form>
  </div>
  `;

  const scripts = `
  <script>
    async function post(url, body){
      await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    }
    async function toggleConnect(){ await post('/api/toggle-connect',{botId:'${botId}'}); location.reload(); }
    async function toggleEnabled(){ await post('/api/toggle-enabled',{botId:'${botId}'}); location.reload(); }

    async function loadStats(){
      if(!'${statsEndpoint}') return;
      const r = await fetch('${statsEndpoint}');
      const j = await r.json();
      document.getElementById('stats').innerHTML =
        'Mensagens: <b>'+j.totalMessagesSent+'</b><br>'+
        'Ano mín: <b>'+j.minYearFollowUp+'</b><br>'+
        'Abaixo: <b>'+j.carsBelowMinYear+'</b><br>'+
        'OK: <b>'+j.carsAtOrAboveMinYear+'</b>';
    }
    loadStats();
  </script>
  `;

  return baseHTML({ title: 'Painel Mobile', user, content, scripts });
}

// ---------------- DESKTOP ----------------
function layoutDesktop(props = {}) {
  // Desktop usa o MESMO layout (seguro)
  return layoutMobile(props);
}

module.exports = {
  qrDataUrl,
  layoutMobile,
  layoutDesktop
};
