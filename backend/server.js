const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const HEADERS = () => ({
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': 'sofascore.p.rapidapi.com'
});

// Categorias por prioridade
const CATEGORIAS_PRIORITY1 = [13];           // Brasil
const CATEGORIAS_PRIORITY2 = [31, 32, 1, 30, 7, 44, 1470, 1465, 1468]; // Europeias + Copas internacionais
const CATEGORIAS_COMPLEMENT1 = [35, 77, 86, 152, 47, 23, 24, 25]; // Ligas europeias secundárias (Turquia, Rússia, Holanda, etc)
const CATEGORIAS_COMPLEMENT2 = [48, 49, 165, 274, 280, 281, 20, 57]; // Sul-americanas (Argentina, Chile, Colômbia, etc)

// Ligas prioritárias por uniqueTournament.id
const LIGAS_PRIORITY = {
  325:  { nome:'Série A',          tipo:'a',    pri:1 },
  390:  { nome:'Série B',          tipo:'b',    pri:2 },
  23:   { nome:'Serie A 🇮🇹',      tipo:'it',   pri:3 },
  8:    { nome:'La Liga 🇪🇸',       tipo:'es',   pri:4 },
  17:   { nome:'Premier League',   tipo:'eu',   pri:5 },
  35:   { nome:'Bundesliga',       tipo:'eu',   pri:6 },
  34:   { nome:'Ligue 1',          tipo:'eu',   pri:6 },
  238:  { nome:'Liga Portugal',    tipo:'eu',   pri:6 },
  384:  { nome:'Libertadores',     tipo:'copa', pri:7 },
  480:  { nome:'Sul-Americana',    tipo:'copa', pri:7 },
  679:  { nome:'Europa League',    tipo:'copa', pri:7 },
  7:    { nome:'Champions League', tipo:'copa', pri:7 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Supabase ────────────────────────────────────────────────
async function dbGet(data) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}&select=apostas`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (rows && rows.length > 0) return rows[0].apostas;
    return null;
  } catch(e) { return null; }
}

async function dbSave(data, apostas) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ data, apostas })
    });
  } catch(e) { console.error('Erro ao salvar no banco:', e.message); }
}

// ─── Utilitários ─────────────────────────────────────────────
function normalizarData(data) {
  if (!data) return null;
  if (data.includes('/')) {
    const p = data.split('/');
    if (p.length === 3) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }
  return data;
}

function diaOffset(dataStr, offset) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7)) - 1;
  const dia = parseInt(dataStr.substring(8,10));
  const d = new Date(Date.UTC(ano, mes, dia));
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ─── Sofascore ───────────────────────────────────────────────
async function buscarJogosCat(catId, data) {
  try {
    const res = await fetch(
      `https://sofascore.p.rapidapi.com/tournaments/get-scheduled-events?categoryId=${catId}&date=${data}`,
      { headers: HEADERS() }
    );
    if (!res.ok) {
      if (res.status === 429) {
        await sleep(2000);
        const res2 = await fetch(
          `https://sofascore.p.rapidapi.com/tournaments/get-scheduled-events?categoryId=${catId}&date=${data}`,
          { headers: HEADERS() }
        );
        if (!res2.ok) return [];
        return (await res2.json()).events || [];
      }
      return [];
    }
    return (await res.json()).events || [];
  } catch(e) { return []; }
}

// Busca jogos de uma lista de categorias e filtra por janela/horário
// aceita qualquer liga (não filtra por LIGAS_PRIORITY)
async function buscarJogosLivres(categorias, datasParaBuscar, inicioDia, fimDia, minMinutos, jogosExistentes) {
  const novos = new Map();
  for (const catId of categorias) {
    for (const d of datasParaBuscar) {
      const eventos = await buscarJogosCat(catId, d);
      await sleep(150);
      for (const ev of eventos) {
        const ts = ev.startTimestamp;
        if (!ts || ts < inicioDia || ts >= fimDia) continue;
        const segundosNoDia = ts - inicioDia;
        const hBR = Math.floor(segundosNoDia / 3600);
        const mBR = Math.floor((segundosNoDia % 3600) / 60);
        if (hBR * 60 + mBR < minMinutos) continue;
        const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
        const key = `${ev.homeTeam?.name}-${ev.awayTeam?.name}`;
        if (!jogosExistentes.has(key) && !novos.has(key)) {
          const ligaId = ev.tournament?.uniqueTournament?.id;
          const ligaNome = ev.tournament?.name || `Liga ${catId}`;
          novos.set(key, {
            liga: ligaNome,
            tipo: 'eu',
            pri: 8,
            timeCasa: ev.homeTeam?.name,
            timeFora: ev.awayTeam?.name,
            horario: hStr
          });
        }
      }
    }
  }
  return Array.from(novos.values());
}

// ─── IA ──────────────────────────────────────────────────────
async function chamarIA(prompt) {
  const modelos = ['claude-haiku-4-5','claude-sonnet-4-5','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022','claude-3-haiku-20240307'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
      });
      const json = await res.json();
      if (!json.error) { console.log(`✅ Modelo: ${modelo}`); return json; }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

// ─── Geração principal ───────────────────────────────────────
async function gerarApostas(data, horaMin, metaJogos) {
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;

  const ano = parseInt(data.substring(0,4));
  const mes = parseInt(data.substring(5,7)) - 1;
  const dia = parseInt(data.substring(8,10));
  const inicioDia = Math.floor(Date.UTC(ano, mes, dia, 3, 0, 0) / 1000);
  const fimDia = inicioDia + 86400;
  const datasParaBuscar = [diaOffset(data,-1), data, diaOffset(data,1)];

  const jogosMap = new Map();

  // PASSO 1: Buscar ligas prioritárias (Brasil + grandes ligas + copas)
  const todasCats = [...CATEGORIAS_PRIORITY1, ...CATEGORIAS_PRIORITY2];
  for (const catId of todasCats) {
    for (const d of datasParaBuscar) {
      const eventos = await buscarJogosCat(catId, d);
      await sleep(150);
      for (const ev of eventos) {
        const ligaId = ev.tournament?.uniqueTournament?.id;
        const liga = LIGAS_PRIORITY[ligaId];
        if (!liga) continue;
        const ts = ev.startTimestamp;
        if (!ts || ts < inicioDia || ts >= fimDia) continue;
        const segundosNoDia = ts - inicioDia;
        const hBR = Math.floor(segundosNoDia / 3600);
        const mBR = Math.floor((segundosNoDia % 3600) / 60);
        if (hBR * 60 + mBR < minMinutos) continue;
        const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
        const key = `${ev.homeTeam?.name}-${ev.awayTeam?.name}`;
        if (!jogosMap.has(key)) {
          jogosMap.set(key, { liga: liga.nome, tipo: liga.tipo, pri: liga.pri, timeCasa: ev.homeTeam?.name, timeFora: ev.awayTeam?.name, horario: hStr });
        }
      }
    }
  }
  console.log(`Prioridade 1+2: ${jogosMap.size} jogos`);

  // PASSO 2: Complemento 1 — ligas europeias secundárias (se < metaJogos)
  if (jogosMap.size < metaJogos) {
    console.log(`Buscando complemento 1 (ligas europeias secundárias)...`);
    const extras = await buscarJogosLivres(CATEGORIAS_COMPLEMENT1, datasParaBuscar, inicioDia, fimDia, minMinutos, jogosMap);
    const faltam = metaJogos - jogosMap.size;
    extras.slice(0, faltam).forEach(j => jogosMap.set(`${j.timeCasa}-${j.timeFora}`, j));
    console.log(`Após complemento 1: ${jogosMap.size} jogos`);
  }

  // PASSO 3: Complemento 2 — ligas sul-americanas (se ainda < metaJogos)
  if (jogosMap.size < metaJogos) {
    console.log(`Buscando complemento 2 (ligas sul-americanas)...`);
    const extras = await buscarJogosLivres(CATEGORIAS_COMPLEMENT2, datasParaBuscar, inicioDia, fimDia, minMinutos, jogosMap);
    const faltam = metaJogos - jogosMap.size;
    extras.slice(0, faltam).forEach(j => jogosMap.set(`${j.timeCasa}-${j.timeFora}`, j));
    console.log(`Após complemento 2: ${jogosMap.size} jogos`);
  }

  const jogos = Array.from(jogosMap.values())
    .sort((a, b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

  console.log(`Total final: ${jogos.length} jogos`);
  jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

  if (!jogos.length) return null;

  const df = `${String(dia).padStart(2,'0')}/${String(mes+1).padStart(2,'0')}/${ano}`;
  const listaJogos = jogos.map((j, i) => `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`).join('\n');

  const prompt = `Você é um analista de apostas esportivas. Analise os jogos CONFIRMADOS pela API Sofascore para ${df} e gere 1 aposta por jogo para a Estrela Bet.

JOGOS VALIDADOS:
${listaJogos}

REGRAS: Série A e Série B têm análise OBRIGATÓRIA. Analise últimos 10 jogos de cada time (gols, escanteios, vitórias, fase, tabela, cartões) + confronto direto último ano. 1 aposta por jogo com mercado definido pelos dados.

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"Time A","time_fora":"Time B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"3-4 linhas com dados que embasam a aposta."}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;

  const iaJson = await chamarIA(prompt);
  if (!iaJson) return null;

  const txt = (iaJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s === -1 || e === -1) return null;

  return JSON.parse(txt.slice(s, e + 1));
}

// ─── Endpoints ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/analisar', async (req, res) => {
  let { data, hora, meta } = req.body;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });
  data = normalizarData(data);
  if (!data) return res.status(400).json({ error: 'Formato de data inválido.' });

  const horaMin = hora || '13:00';
  const metaJogos = parseInt(meta) || 15;

  try {
    console.log(`\n=== Apostas para ${data} ===`);
    if (SUPABASE_URL && SUPABASE_KEY) {
      const cached = await dbGet(data);
      if (cached) { console.log(`✅ Cache hit`); return res.json(cached); }
      console.log(`Cache miss — gerando...`);
    }
    const resultado = await gerarApostas(data, horaMin, metaJogos);
    if (!resultado) return res.json({ jogos: [], aviso: 'Nenhum jogo encontrado.' });
    if (SUPABASE_URL && SUPABASE_KEY) {
      await dbSave(data, resultado);
      console.log(`✅ Salvo no banco`);
    }
    res.json(resultado);
  } catch (err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/apostas/:periodo', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Banco não configurado.' });
  const { periodo } = req.params;
  const hoje = new Date();
  const hojeStr = `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth()+1).padStart(2,'0')}-${String(hoje.getUTCDate()).padStart(2,'0')}`;
  let dataConsulta;
  if (periodo === 'ontem') dataConsulta = diaOffset(hojeStr, -1);
  else if (periodo === 'hoje') dataConsulta = hojeStr;
  else if (periodo === 'amanha') dataConsulta = diaOffset(hojeStr, 1);
  else return res.status(400).json({ error: 'Use: ontem, hoje ou amanha.' });
  try {
    const cached = await dbGet(dataConsulta);
    if (cached) return res.json({ data: dataConsulta, ...cached });
    return res.json({ data: dataConsulta, jogos: [], aviso: `Apostas para ${dataConsulta} ainda não foram geradas.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
