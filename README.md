# Análise de Apostas Esportivas

App completo para busca e análise de apostas esportivas com IA.

---

## Estrutura do projeto

```
apostas-app/
├── backend/        → Servidor Node.js (deploy no Render)
│   ├── server.js
│   └── package.json
└── frontend/       → Interface web (deploy no GitHub Pages)
    └── index.html
```

---

## Passo 1 — Deploy do Backend no Render

1. Acesse https://render.com e crie uma conta gratuita
2. Clique em **New > Web Service**
3. Conecte seu repositório GitHub e selecione a pasta `backend`
4. Configure:
   - **Name:** apostas-backend
   - **Root Directory:** backend
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Em **Environment Variables**, adicione:
   - `ANTHROPIC_API_KEY` = sua chave da API da Anthropic
6. Clique em **Create Web Service**
7. Aguarde o deploy. Anote a URL gerada (ex: `https://apostas-backend.onrender.com`)

---

## Passo 2 — Configurar o Frontend com a URL do Backend

Abra o arquivo `frontend/index.html` e localize a linha:

```js
const BACKEND_URL = window.BACKEND_URL || 'https://SEU-BACKEND.onrender.com';
```

Substitua `https://SEU-BACKEND.onrender.com` pela URL real do seu backend no Render.

---

## Passo 3 — Deploy do Frontend no GitHub Pages

1. No seu repositório GitHub, vá em **Settings > Pages**
2. Em **Source**, selecione a branch `main` e a pasta `/frontend` (ou `/docs` se preferir)
3. Clique em **Save**
4. Aguarde alguns minutos. O GitHub vai gerar uma URL pública como:
   `https://seu-usuario.github.io/apostas-app/`

---

## Como usar o app

1. Acesse a URL do GitHub Pages
2. Selecione a data dos jogos (padrão: amanhã)
3. Confirme o horário mínimo (padrão: 13h Brasília)
4. Defina a meta de jogos (padrão: 15)
5. Clique em **Buscar e analisar**
6. Aguarde a análise da IA (pode levar 30-60 segundos)
7. Clique em qualquer jogo para ver os detalhes e a justificativa da aposta

---

## Ligas analisadas (prioritárias)

- 🇧🇷 Brasileirão Série A e Série B (análise obrigatória para todos os jogos no filtro)
- 🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League (verificar horário — geralmente 12h Brasília)
- 🇩🇪 Bundesliga
- 🇫🇷 Ligue 1
- 🇪🇸 La Liga
- 🇵🇹 Liga Portugal
- 🇮🇹 Serie A italiana
- 🏆 Libertadores, Sul-Americana, Europa League, Champions League

---

## Chave da API Anthropic

Acesse https://console.anthropic.com para criar sua chave de API.
A chave fica salva apenas no Render como variável de ambiente — nunca exposta no frontend.
