# Iron Glass MultiBot (5 números + 1 painel)

## Requisitos
- Node.js 18+ (recomendado 20/22)
- 5 números de WhatsApp (um por vendedor)

## Rodar local (CMD)
```bash
npm install
npm start
```
Abra:
- Painel mobile: http://localhost:3000/m
- Painel desktop: http://localhost:3000/admin

Login inicial (altere no painel ou editando data/users.json):
- admin / admin123
- v1 / 123
- v2 / 123
- v3 / 123
- v4 / 123
- v5 / 123

## Railway (importante)
Este projeto guarda sessões do WhatsApp em `auth/` e dados em `data/`.
Em Railway, **use Volume** (disco persistente) montado no projeto para não perder o login.

Variáveis:
- PORT (Railway define)
- SESSION_SECRET (obrigatório em produção)

## Como funciona
- 5 bots independentes (v1..v5), cada um com seu QR e sua sessão.
- Cada vendedor edita **suas próprias mensagens/comandos/regras** no painel.
- Regra: se detectar ano < 2022 (configurável por vendedor), NÃO entra no funil, mas registra estatística em events.json.


## Novas telas (mobile)
- /m/agenda (confirmação + lembretes)
- /m/program (programar 1ª mensagem futura)
