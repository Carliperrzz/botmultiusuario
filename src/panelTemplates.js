const QRCode = require('qrcode');

// Si tu utils tiene htmlEscape, usalo. Si no, usamos fallback.
let htmlEscape = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

try {
  const utils = require('./utils');
  if (typeof utils.htmlEscape === 'function') htmlEscape = utils.htmlEscape;
} catch (_) {}

async function qrDataUrl(qrText) {
  if (!qrText) return null;
  return QRCode.toDataURL(qrText, { margin: 1, scale: 6 });
}

function normalizeUser(input = {}) {
  const u = input.user || {};
  const username = input.username || u.username || 'Usuário';
  const role = input.role || u.role || 'viewer';
  const name = u.name || username;
  return { username, role, name };
}

function pill(text) {
  return `<span class="pill">${htmlEscape(text)}</span>`;
}

function baseHead(title = 'Painel') {
  return `
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${htmlEscape(title)}</title>
  <style>
    :root{
      --bg:#0b1220; --card:#0f172a; --line:#1f2a44;
      --txt:#e5e7eb; --muted:#94a3b8; --yellow:#facc15;
      --green:#22c55e; --red:#ef4444; --blue:#60a5fa;
    }
    body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
    a{color:inherit}
    .wrap{max-width:980px;margin:0 auto;padding:14px}
    .top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
    .title{font-size:16px;font-weight:800}
    .pill{display:inline-block;border:1px solid var(--line);background:#0b1220;border-radius:999px;padding:6px 10px;font-size:12px;color:var(--muted)}
    .grid{display:grid;grid-template-columns:1fr;gap:12px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px}
    .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .btn{cursor:pointer;border:none;border-radius:14px;padding:10px 12px;font-weight:800}
    .btn-yellow{background:var(--yellow);color:#111827}
    .btn-dark{background:#0b1220;color:var(--txt);border:1px solid var(--line)}
    .muted{color:var(--muted);font-size:12px}
    .k{color:var(--muted);font-size:12px;margin-bottom:6px}
    .v{font-size:14px;font-weight:800}
    select,input{background:#0b1220;color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:10px;outline:none}
    textarea{width:100%;min-height:90px;background:#0b1220;color:var(--txt);border:1px solid var(--line);border-radius:12px;padding:10px;outline:none}
    hr{border:none;border-top:1px solid var(--line);margin:12px 0}
    .status{display:flex;gap:10px;flex-wrap:wrap}
    .dot{width:10px;height:10px;border-radius:999px;display:inline-block;margin-right:6px}
    .dot-green{background:var(--green)}
    .dot-red{background:var(--red)}
    .dot-blue{background:var(--blue)}
    img.qr{max-width:260px;border-radius:12px;border:1px solid var(--line);background:#fff;padding:8px}
    @media(min-width:900px){
      .grid{grid-template-columns:1.1fr .9fr}
    }
  </style>
  `;
}

function scriptCommon() {
  return `
  <script>
    async function postJSON(url, body){
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
      return r.json().catch(()=>({}));
    }

    async function refreshStatus(){
      const botId = document.querySelector('[name="botIdSel"]')?.value || '';
      const r = await fetch('/api/status?botId=' + encodeURIComponent(botId));
      const j = await r.json().catch(()=>null);
      if(!j) return;

      const connectedEl = document.getElementById('connectedVal');
      const enabledEl = document.getElementById('enabledVal');
      const queueEl = document.getElementById('queueVal');
      if(connectedEl) connectedEl.textContent = j.connected ? 'Conectado' : 'Desconectado';
      if(enabledEl) enabledEl.textContent = j.enabled ? 'Ativo' : 'Pausado';
      if(queueEl) queueEl.textContent = String(j.queueSize ?? 0);

      const qrBox = document.getElementById('qrBox');
      if(qrBox){
        if(j.qrDataUrl){
          qrBox.innerHTML = '<img class="qr" src="' + j.qrDataUrl + '" alt="QR"/><div class="muted" style="margin-top:8px">Escaneie no WhatsApp (Dispositivos conectados).</div>';
        }else{
          qrBox.innerHTML = '<div class="muted">Sem QR agora. Se estiver desconectado, clique em "Conectar".</div>';
        }
      }
    }

    async function refreshStats(){
      const st = document.getElementById('statsBox');
      const endpoint = st?.getAttribute('data-endpoint');
      if(!st || !endpoint) return;
      const r = await fetch(endpoint);
      const j = await r.json().catch(()=>null);
      if(!j) return;
      st.innerHTML = \`
        <div class="row">
          <div><div class="k">Mensagens auto enviadas</div><div class="v">\${j.totalMessagesSent ?? 0}</div></div>
          <div><div class="k">Ano mínimo follow-up</div><div class="v">\${j.minYearFollowUp ?? '-'}</div></div>
          <div><div class="k">Carros abaixo do ano</div><div class="v">\${j.carsBelowMinYear ?? 0}</div></div>
          <div><div class="k">Carros ok (>=)</div><div class="v">\${j.carsAtOrAboveMinYear ?? 0}</div></div>
        </div>
      \`;
    }

    async function doToggleConnect(){
      const botId = document.querySelector('[name="botIdSel"]')?.value || '';
      await postJSON('/api/toggle-connect', { botId });
      await refreshStatus();
    }

    async function doToggleEnabled(){
      const botId = document.querySelector('[name="botIdSel"]')?.value || '';
      await postJSON('/api/toggle-enabled', { botId });
      await refreshStatus();
    }

    function onBotChange(){
      const botId = document.querySelector('[name="botIdSel"]')?.value || '';
      const isMobile = location.pathname.startsWith('/m');
      location.href = (isMobile ? '/m' : '/d') + '?botId=' + encodeURIComponent(botId);
    }

    window.addEventListener('load', async ()=>{
      await refreshStatus();
      await refreshStats();
      setInterval(refreshStatus, 4000);
      setInterval(refreshStats, 12000);
    });
  </script>
  `;
}

function renderPanel({ mode='mobile', user, botId, allowedBotIds=[], status={}, qrDataUrl=null, rules={}, messages={}, statsEndpoint='/api/stats' } = {}) {
  const title = mode === 'desktop' ? 'Painel Desktop' : 'Painel Mobile';
  const connected = !!status.connected;
  const enabled = !!status.enabled;
  const queueSize = status.queueSize ?? 0;

  const botOptions = (allowedBotIds && allowedBotIds.length ? allowedBotIds : [botId || 'v1'])
    .map(id => `<option value="${htmlEscape(id)}" ${id===botId?'selected':''}>${htmlEscape(id)}</option>`)
    .join('');

  return `<!doctype html>
  <html>
    <head>${baseHead(title)}</head>
    <body>
      <div class="wrap">

        <div class="top">
          <div class="title">📲 Iron Glass MultiBot · ${pill(user.name)} ${pill(user.role)}</div>
          <div class="row">
            <a class="pill" href="/logout">Sair</a>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <div class="row" style="justify-content:space-between">
              <div class="row">
                <div class="muted">Bot:</div>
                <select name="botIdSel" onchange="onBotChange()">
                  ${botOptions}
                </select>
              </div>
              <div class="row">
                <button class="btn btn-dark" onclick="doToggleConnect()">Conectar / Desconectar</button>
                <button class="btn btn-yellow" onclick="doToggleEnabled()">Ativar / Pausar</button>
              </div>
            </div>

            <hr/>

            <div class="status">
              <div>${connected ? '<span class="dot dot-green"></span>' : '<span class="dot dot-red"></span>'}<span class="muted">Conexão:</span> <b id="connectedVal">${connected ? 'Conectado' : 'Desconectado'}</b></div>
              <div>${enabled ? '<span class="dot dot-blue"></span>' : '<span class="dot dot-red"></span>'}<span class="muted">Bot:</span> <b id="enabledVal">${enabled ? 'Ativo' : 'Pausado'}</b></div>
              <div><span class="muted">Fila:</span> <b id="queueVal">${htmlEscape(queueSize)}</b></div>
              <div class="muted">Bot atual: <b>${htmlEscape(botId)}</b></div>
            </div>

            <hr/>

            <div id="qrBox">
              ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR"/>` : `<div class="muted">Sem QR agora. Se estiver desconectado, clique em "Conectar".</div>`}
            </div>
          </div>

          <div class="card">
            <div class="k">📊 Estatísticas</div>
            <div id="statsBox" data-endpoint="${htmlEscape(statsEndpoint)}">
              <div class="muted">Carregando...</div>
            </div>

            <hr/>

            <div class="k">⚙️ Configuração (Rules / Messages)</div>
            <form method="POST" action="/save">
              <input type="hidden" name="botId" value="${htmlEscape(botId)}"/>

              <div class="k">Rules (JSON)</div>
              <textarea name="rules">${htmlEscape(JSON.stringify(rules || {}, null, 2))}</textarea>

              <div class="k" style="margin-top:10px">Messages (JSON)</div>
              <textarea name="messages">${htmlEscape(JSON.stringify(messages || {}, null, 2))}</textarea>

              <button class="btn btn-yellow" type="submit" style="margin-top:10px;width:100%">Salvar</button>
              <div class="muted" style="margin-top:8px">Dica: mantenha JSON válido. Se errar, o bot pode ignorar/usar padrão.</div>
            </form>
          </div>
        </div>

      </div>
      ${scriptCommon()}
    </body>
  </html>`;
}

function layoutMobile(props = {}) {
  const user = normalizeUser(props);
  return renderPanel({
    mode: 'mobile',
    user,
    botId: props.botId,
    allowedBotIds: props.allowedBotIds || [],
    status: props.status || {},
    qrDataUrl: props.qrDataUrl || null,
    rules: props.rules || {},
    messages: props.messages || {},
    statsEndpoint: props.statsEndpoint || '/api/stats'
  });
}

function layoutDesktop(props = {}) {
  const user = normalizeUser(props);
  return renderPanel({
    mode: 'desktop',
    user,
    botId: props.botId,
    allowedBotIds: props.allowedBotIds || [],
    status: props.status || {},
    qrDataUrl: props.qrDataUrl || null,
    rules: props.rules || {},
    messages: props.messages || {},
    statsEndpoint: props.statsEndpoint || '/api/stats'
  });
}

module.exports = {
  qrDataUrl,
  layoutMobile,
  layoutDesktop
};
