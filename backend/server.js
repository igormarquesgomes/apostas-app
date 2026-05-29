const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// IDs de liga na API-Football
const LIGAS_PRIORITY = {
  // Brasil
  71:  { nome:'Série A',          tipo:'a',    pri:1 },
  72:  { nome:'Série B',          tipo:'b',    pri:2 },
  // Europeias
  135: { nome:'Serie A 🇮🇹',      tipo:'it',   pri:3 },
  140: { nome:'La Liga 🇪🇸',       tipo:'es',   pri:4 },
  39:  { nome:'Premier League',   tipo:'eu',   pri:5 },
  78:  { nome:'Bundesliga',       tipo:'eu',   pri:6 },
  61:  { nome:'Ligue 1',          tipo:'eu',   pri:6 },
  94:  { nome:'Liga Portugal',    tipo:'eu',   pri:6 },
  // Copas internacionais
  13:  { nome:'Libertadores',     tipo:'copa', pri:7 },
  11:  { nome:'Sul-Americana',    tipo:'copa', pri:7 },
  3:   { nome:'Europa League',    tipo:'copa', pri:7 },
  2:   { nome:'Champions League', tipo:'copa', pri:7 },
};

// IDs a ignorar explicitamente (ligas brasileiras que NÃO são prioritárias)
const LIGAS_IGNORAR = new Set([
  75, 76,      // Série C e Série D
  1098,        // Paulista Série B
  851,         // Carioca A2
  936, 614, 619, 620, 613, // Estaduais div 2
  1073, 1076, 1086, 1100, 1107, 1128, 1069, 1071, // Sub-20 e U17
  1148, 1158, 1096, 1097,  // Copas regionais
]);

// Sem NOMES_PRIORITY — usamos apenas IDs para máxima precisão
const NOMES_PRIORITY = [];

// Proteção de cota
let apiSuspensa = false;
let apiErrorMsg = '';
let reqHoje = 0;
let reqDia = '';
const LIMITE_SEGURO = 1000;
const LIMITE_ALERTA = 800;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Utilitários de data ─────────────────────────────────────
function hojeStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function diaOffset(dataStr, offset) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7)) - 1;
  const dia = parseInt(dataStr.substring(8,10));
  const d = new Date(Date.UTC(ano, mes, dia));
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function normalizarData(data) {
  if (!data) return null;
  if (data.includes('/')) {
    const p = data.split('/');
    if (p.length === 3) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }
  return data;
}

function ultimoDiaMes(dataStr) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7));
  return String(new Date(Date.UTC(ano, mes, 0)).getUTCDate()).padStart(2,'0');
}

function diaSemana(dataStr) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7)) - 1;
  const dia = parseInt(dataStr.substring(8,10));
  return new Date(Date.UTC(ano, mes, dia)).getUTCDay();
}

function contarRequisicao() {
  const hoje = hojeStr();
  if (reqDia !== hoje) { reqDia = hoje; reqHoje = 0; }
  reqHoje++;
  console.log(`📊 Req API hoje: ${reqHoje}/${LIMITE_SEGURO}`);
  if (reqHoje >= LIMITE_ALERTA) console.warn(`⚠️ ATENÇÃO: ${reqHoje} req hoje — limite: ${LIMITE_SEGURO}`);
  if (reqHoje >= LIMITE_SEGURO) {
    apiSuspensa = true;
    apiErrorMsg = `Limite de ${LIMITE_SEGURO} req/dia atingido. Reset amanhã.`;
    console.error(`🛑 LIMITE ATINGIDO — bloqueando chamadas`);
    return false;
  }
  return true;
}

// ─── Supabase ────────────────────────────────────────────────
async function dbGet(data) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}&select=apostas,resultados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows.length > 0 ? rows[0] : null;
  } catch(e) { return null; }
}

async function dbSave(data, apostas) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ data, apostas })
    });
  } catch(e) { console.error('Erro dbSave:', e.message); }
}

async function dbSaveResultados(data, resultados) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultados })
    });
  } catch(e) { console.error('Erro dbSaveResultados:', e.message); }
}

async function dbGetCalibracao(tipo) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.${tipo}&order=criado_em.desc&limit=1&select=relatorio,assertividade,periodo_inicio,periodo_fim`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows.length > 0 ? rows[0] : null;
  } catch(e) { return null; }
}

async function dbSaveCalibracao(tipo, periodoInicio, periodoFim, relatorio, assertividade) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/calibracao`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, periodo_inicio: periodoInicio, periodo_fim: periodoFim, relatorio, assertividade })
    });
  } catch(e) { console.error('Erro dbSaveCalibracao:', e.message); }
}

async function dbGetCalibracoes(tipo, limit) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.${tipo}&order=criado_em.desc&limit=${limit}&select=id,relatorio,assertividade,periodo_inicio,periodo_fim`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    return await res.json() || [];
  } catch(e) { return []; }
}

async function dbDeleteCalibracaoAntiga(tipo) {
  try {
    const rows = await dbGetCalibracoes(tipo, 100);
    if (rows.length <= 1) return;
    const ids = rows.slice(1).map(r => r.id).join(',');
    await fetch(`${SUPABASE_URL}/rest/v1/calibracao?id=in.(${ids})`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) { console.error('Erro dbDelete:', e.message); }
}

// ─── API-Football ─────────────────────────────────────────────
async function verificarStatusAPI() {
  try {
    if (!contarRequisicao()) return false;
    const res = await fetch('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': APIFOOTBALL_KEY }
    });
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      apiSuspensa = true;
      apiErrorMsg = JSON.stringify(json.errors);
      console.error(`❌ API status erro: ${apiErrorMsg}`);
      return false;
    }
    const conta = json.response;
    console.log(`✅ API OK — Plano: ${conta?.subscription?.plan} | Req hoje: ${conta?.requests?.current}/${conta?.requests?.limit_day}`);
    apiSuspensa = false;
    apiErrorMsg = '';
    return true;
  } catch(e) {
    console.error('Erro verificarStatus:', e.message);
    return false;
  }
}

async function buscarFixturesPorData(data) {
  if (apiSuspensa) {
    console.error(`❌ API bloqueada: ${apiErrorMsg}`);
    return [];
  }
  if (!contarRequisicao()) return [];

  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );

    if (res.status === 401 || res.status === 403) {
      apiSuspensa = true;
      apiErrorMsg = `HTTP ${res.status} — chave inválida ou conta suspensa`;
      console.error(`❌ ${apiErrorMsg}`);
      return [];
    }
    if (!res.ok) { console.log(`⚠️ API erro HTTP ${res.status}`); return []; }

    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      const erros = JSON.stringify(json.errors);
      console.error(`❌ API errors: ${erros}`);
      if (erros.includes('token') || erros.includes('subscription') || erros.includes('requests')) {
        apiSuspensa = true;
        apiErrorMsg = erros;
      }
      return [];
    }

    const fixtures = json.response || [];
    console.log(`📊 API-Football: ${fixtures.length} fixtures recebidos`);

    // Log das ligas brasileiras para debug
    const ligasBR = [...new Set(
      fixtures.filter(f => f.league?.country === 'Brazil')
              .map(f => `ID:${f.league?.id} — ${f.league?.name}`)
    )];
    if (ligasBR.length) console.log(`🇧🇷 Ligas Brasil:\n  ${ligasBR.join('\n  ')}`);
    // Log detalhado jogos brasileiros NS
    const jogosBR = fixtures.filter(f => f.league?.country === "Brazil" && f.fixture?.status?.short === "NS");
    if (jogosBR.length) {
      console.log("🇧🇷 Jogos BR não iniciados:");
      jogosBR.forEach(f => console.log(`  LigaID:${f.league?.id} [${f.league?.name}] ${f.teams?.home?.name} x ${f.teams?.away?.name}`));
    }

    return fixtures;
  } catch(e) {
    console.error('Erro buscarFixtures:', e.message);
    return [];
  }
}

// ─── Estatísticas da API-Football ────────────────────────────
async function buscarUltimosJogos(teamId, qtd = 10) {
  if (!contarRequisicao()) return [];
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=${qtd}&status=FT`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    return json.response || [];
  } catch(e) { return []; }
}

async function buscarH2H(teamId1, teamId2) {
  if (!contarRequisicao()) return [];
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${teamId1}-${teamId2}&last=5`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    return json.response || [];
  } catch(e) { return []; }
}

async function buscarEstatisticasTime(teamId, ligaId, season = 2026) {
  if (!contarRequisicao()) return null;
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?team=${teamId}&league=${ligaId}&season=${season}`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    return json.response || null;
  } catch(e) { return null; }
}

function formatarForma(jogos, teamId) {
  return jogos.slice(0, 5).map(f => {
    const gh = f.goals?.home, ga = f.goals?.away;
    const home = f.teams?.home?.id === teamId;
    const gF = home ? gh : ga, gC = home ? ga : gh;
    if (gF > gC) return 'V';
    if (gF < gC) return 'D';
    return 'E';
  }).join(' ');
}

function calcularMediaGols(jogos, teamId) {
  if (!jogos.length) return '-';
  const total = jogos.reduce((s, f) => {
    const home = f.teams?.home?.id === teamId;
    return s + (home ? (f.goals?.home || 0) : (f.goals?.away || 0));
  }, 0);
  return (total / jogos.length).toFixed(1);
}

async function coletarEstatisticas(teamId, teamNome, ligaId, oponenteId) {
  const [ultimosJogos, h2h] = await Promise.all([
    buscarUltimosJogos(teamId, 10),
    buscarH2H(teamId, oponenteId)
  ]);
  await sleep(200);

  const forma = formatarForma(ultimosJogos, teamId);
  const mediaGols = calcularMediaGols(ultimosJogos, teamId);

  // Calcular média de escanteios e cartões dos últimos jogos
  let totalEscanteios = 0, totalCartoes = 0, countStats = 0;
  for (const f of ultimosJogos) {
    if (f.statistics) {
      const statsTime = f.statistics.find(s => s.team?.id === teamId);
      if (statsTime) {
        const esc = statsTime.statistics?.find(s => s.type === 'Corner Kicks')?.value;
        const cart = statsTime.statistics?.find(s => s.type === 'Yellow Cards')?.value;
        if (esc) { totalEscanteios += parseInt(esc) || 0; countStats++; }
        if (cart) totalCartoes += parseInt(cart) || 0;
      }
    }
  }

  return {
    forma,
    mediaGols,
    mediaEscanteios: countStats > 0 ? (totalEscanteios / countStats).toFixed(1) : '-',
    mediaCartoes: countStats > 0 ? (totalCartoes / countStats).toFixed(1) : '-',
    h2hTexto: h2h.slice(0,3).map(f => `${f.teams?.home?.name} ${f.goals?.home}-${f.goals?.away} ${f.teams?.away?.name}`).join(' | ') || 'Sem H2H'
  };
}

// ─── IA ──────────────────────────────────────────────────────
async function chamarIA(prompt, maxTokens = 8000) {
  const modelos = ['claude-haiku-4-5','claude-sonnet-4-5','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
      });
      const json = await res.json();
      if (!json.error) { console.log(`✅ Modelo: ${modelo}`); return (json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''); }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

// ─── IA com busca web (para estatísticas reais) ─────────────
async function chamarIAComBusca(prompt, maxTokens = 16000) {
  const modelos = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: modelo,
          max_tokens: maxTokens,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const json = await res.json();
      if (!json.error) {
        console.log(`✅ Modelo com busca: ${modelo}`);
        const txt = (json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        return txt;
      }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo} busca: ${e.message}`); }
  }
  // Fallback sem busca
  return chamarIA(prompt, maxTokens);
}

// ─── Memória de calibração ────────────────────────────────────
async function buscarMemoria() {
  const [semestral, mensal, semanal, diario] = await Promise.all([
    dbGetCalibracao('semestral'), dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'), dbGetCalibracao('diario')
  ]);
  let mem = '';
  if (semestral) mem += `\n[SEMESTRAL ${semestral.periodo_inicio}→${semestral.periodo_fim} | ${semestral.assertividade}%]\n${semestral.relatorio}\n`;
  if (mensal)    mem += `\n[MENSAL ${mensal.periodo_inicio}→${mensal.periodo_fim} | ${mensal.assertividade}%]\n${mensal.relatorio}\n`;
  if (semanal)   mem += `\n[SEMANAL ${semanal.periodo_inicio}→${semanal.periodo_fim} | ${semanal.assertividade}%]\n${semanal.relatorio}\n`;
  if (diario)    mem += `\n[DIÁRIO ${diario.periodo_inicio} | ${diario.assertividade}%]\n${diario.relatorio}\n`;
  return mem;
}

// ─── Geração de apostas ──────────────────────────────────────
async function gerarApostas(data, horaMin, metaJogos) {
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;

  const fixtures = await buscarFixturesPorData(data);
  const jogosMap = new Map();
  const jogosComp = new Map();

  for (const f of fixtures) {
    const ts = f.fixture?.timestamp;
    const status = f.fixture?.status?.short;
    const ligaId = f.league?.id;
    const timeCasa = f.teams?.home?.name;
    const timeFora = f.teams?.away?.name;

    if (!ts || !timeCasa || !timeFora) continue;
    if (status !== 'NS') continue;

    // Filtrar Sub
    const subRegex = /\bU\d{2}\b/i;
    const ligaNome = f.league?.name || '';
    if (subRegex.test(timeCasa) || subRegex.test(timeFora) || subRegex.test(ligaNome)) continue;

    // Filtrar ligas irrelevantes
    const ligaLower = ligaNome.toLowerCase();
    if (ligaLower.includes('amateur') || ligaLower.includes('reserve') || ligaLower.includes('youth')) continue;

    // Horário Brasília (UTC-3)
    // Jogos entre 00:00-02:59 UTC pertencem ao dia anterior em Brasília
    // Usamos o timestamp da fixture para calcular horário correto
    const dt = new Date(ts * 1000);
    let hBR = dt.getUTCHours() - 3;
    const mBR = dt.getUTCMinutes();
    // Corrigir horário negativo (jogos após meia-noite UTC = noite em Brasília)
    if (hBR < 0) hBR += 24;
    const totalMin = hBR * 60 + mBR;
    if (totalMin < minMinutos) continue;
    // Ignorar jogos madrugada (após 01:00 Brasília = após 04:00 UTC) — são do dia seguinte
    if (hBR >= 1 && hBR < 10) continue;

    const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
    const key = `${timeCasa}-${timeFora}`;
    const pais = f.league?.country || '';

    // Ignorar ligas explicitamente marcadas
    if (LIGAS_IGNORAR.has(ligaId)) continue;

    // Identificar liga por ID
    const ligaMatch = LIGAS_PRIORITY[ligaId];

    if (ligaMatch) {
      if (!jogosMap.has(key))
        jogosMap.set(key, { liga: ligaMatch.nome, tipo: ligaMatch.tipo, pri: ligaMatch.pri, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
    } else {
      // Complementares — ordenar por região
      const paisLower = pais.toLowerCase();
      let priComp = 20;
      if (["brazil","argentina","colombia","chile","uruguay","peru","venezuela","bolivia","ecuador","paraguay"].includes(paisLower)) priComp = 9;
      else if (["egypt","morocco","algeria","saudi-arabia","uae","qatar","kuwait"].includes(paisLower)) priComp = 10;
      else if (["turkey","netherlands","belgium","scotland","greece","russia","ukraine"].includes(paisLower)) priComp = 11;
      else if (["austria","czech-republic","poland","norway","finland","sweden","denmark"].includes(paisLower)) priComp = 18;
      if (!jogosComp.has(key))
        jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: 'eu', pri: priComp, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
    }
  }

  // Combinar prioritários + complementares ordenados por prioridade
  // Limite de 4 apenas às 13:00
  let jogos = Array.from(jogosMap.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

  if (jogos.length < metaJogos) {
    const compOrdenado = Array.from(jogosComp.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));
    let cont13h = 0;
    const compFiltrado = [];
    for (const j of compOrdenado) {
      if (j.horario === '13:00') {
        cont13h++;
        if (cont13h <= 4) compFiltrado.push(j);
      } else {
        compFiltrado.push(j);
      }
    }
    const faltam = metaJogos - jogos.length;
    jogos = [...jogos, ...compFiltrado.slice(0, faltam)];
  }

  console.log(`\nJogos selecionados: ${jogos.length}`);
  jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

  if (!jogos.length) return null;

  // Coletar estatísticas reais da API para cada jogo
  console.log('\n📊 Coletando estatísticas reais da API-Football...');
  const statsCache = {};
  const jogosComStats = [];

  for (const f of fixtures) {
    const tCasaId = f.teams?.home?.id;
    const tForaId = f.teams?.away?.id;
    const tCasaNome = f.teams?.home?.name;
    const tForaNome = f.teams?.away?.name;
    const jogo = jogos.find(j => j.timeCasa === tCasaNome && j.timeFora === tForaNome);
    if (!jogo || jogo._stats) continue;

    const ligaId = f.league?.id;
    const [statsCasa, statsFora] = await Promise.all([
      coletarEstatisticas(tCasaId, tCasaNome, ligaId, tForaId),
      coletarEstatisticas(tForaId, tForaNome, ligaId, tCasaId)
    ]);
    await sleep(300);

    jogo._stats = { tCasaId, tForaId, statsCasa, statsFora };
    console.log(`  ✅ Stats: ${tCasaNome} vs ${tForaNome}`);
  }

  const ano = parseInt(data.substring(0,4));
  const mes = parseInt(data.substring(5,7));
  const dia = parseInt(data.substring(8,10));
  const df = `${String(dia).padStart(2,'0')}/${String(mes).padStart(2,'0')}/${ano}`;

  // Montar lista de jogos com estatísticas para o prompt
  const listaJogos = jogos.map((j, i) => {
    const s = j._stats;
    const sc = s?.statsCasa, sf = s?.statsFora;
    return `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}
   Casa: forma=${sc?.forma||'?'} gols/jogo=${sc?.mediaGols||'?'} esc=${sc?.mediaEscanteios||'?'} cart=${sc?.mediaCartoes||'?'}
   Fora: forma=${sf?.forma||'?'} gols/jogo=${sf?.mediaGols||'?'} esc=${sf?.mediaEscanteios||'?'} cart=${sf?.mediaCartoes||'?'}
   H2H: ${sc?.h2hTexto||'sem dados'}`;
  }).join('\n');

  const memoria = await buscarMemoria();
  const blocoMem = memoria ? `\nHISTÓRICO:\n${memoria}\n` : '';

  const prompt = `Você é um analista de apostas esportivas especializado. Analise os jogos abaixo com as estatísticas reais já coletadas da API-Football e gere 1 aposta por jogo para a Estrela Bet.

DATA: ${df}
${blocoMem}
JOGOS COM ESTATÍSTICAS REAIS (últimos 5 jogos de cada time):
${listaJogos}

INSTRUÇÕES:
- Série A e Série B têm análise OBRIGATÓRIA
- Use os dados fornecidos (forma, gols/jogo, escanteios, cartões, H2H) para fundamentar cada aposta
- Pode usar web_search para confirmar ou complementar informações específicas (lesões, escalações, clima)
- Use o histórico de calibração para evitar padrões que historicamente erram
- Preencha TODOS os campos com valores numéricos reais — nunca use "-"

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"A","time_fora":"B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"Casa marca 1.8 gols/jogo, fora sofre 1.2. H2H último ano: 3 jogos com Over 2.5. Forma recente favorece ataque."}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;

  const txt = await chamarIAComBusca(prompt);
  if (!txt) return null;
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  return JSON.parse(txt.slice(s, e+1));
}

// ─── Agentes ─────────────────────────────────────────────────
// Buscar resultado de fixture pelo ID na API-Football
async function buscarResultadoFixture(fixtureId) {
  if (!contarRequisicao()) return null;
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    const f = json.response?.[0];
    if (!f) return null;
    const status = f.fixture?.status?.short;
    if (!['FT','AET','PEN'].includes(status)) return null; // Jogo não terminou
    return {
      placar: `${f.goals?.home}-${f.goals?.away}`,
      golsCasa: f.goals?.home,
      golsFora: f.goals?.away,
      status
    };
  } catch(e) { return null; }
}

// Buscar fixture pelo nome dos times e data (para apostas sem fixtureId)
async function buscarFixturePorTimes(timeCasa, timeFora, data) {
  if (!contarRequisicao()) return null;
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    const fixtures = json.response || [];
    // Buscar por nome aproximado
    const normalizar = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
    const nCasa = normalizar(timeCasa), nFora = normalizar(timeFora);
    return fixtures.find(f => {
      const hNome = normalizar(f.teams?.home?.name);
      const aNome = normalizar(f.teams?.away?.name);
      return (hNome?.includes(nCasa?.split(' ')[0]) || nCasa?.includes(hNome?.split(' ')[0])) &&
             (aNome?.includes(nFora?.split(' ')[0]) || nFora?.includes(aNome?.split(' ')[0]));
    }) || null;
  } catch(e) { return null; }
}

// Buscar estatísticas detalhadas de um fixture (escanteios, cartões)
async function buscarStatsFixture(fixtureId) {
  if (!contarRequisicao()) return null;
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    const json = await res.json();
    const teams = json.response || [];
    let escanteiosCasa = 0, escanteiosFora = 0;
    let cartoesCasa = 0, cartoesFora = 0;
    let ambosM = false;

    for (const team of teams) {
      const stats = team.statistics || [];
      const corners = stats.find(s => s.type === 'Corner Kicks')?.value || 0;
      const yellowCards = stats.find(s => s.type === 'Yellow Cards')?.value || 0;
      const redCards = stats.find(s => s.type === 'Red Cards')?.value || 0;
      const goals = stats.find(s => s.type === 'Goals')?.value || 0;

      if (teams.indexOf(team) === 0) {
        escanteiosCasa = parseInt(corners) || 0;
        cartoesCasa = (parseInt(yellowCards) || 0) + (parseInt(redCards) || 0);
        if ((parseInt(goals) || 0) > 0) ambosM = true;
      } else {
        escanteiosFora = parseInt(corners) || 0;
        cartoesFora = (parseInt(yellowCards) || 0) + (parseInt(redCards) || 0);
        if ((parseInt(goals) || 0) > 0) ambosM = true;
      }
    }

    return {
      escanteiosTotal: escanteiosCasa + escanteiosFora,
      escanteiosCasa, escanteiosFora,
      cartoesTotal: cartoesCasa + cartoesFora,
      cartoesCasa, cartoesFora,
      ambosMarcaram: teams.length === 2 ? ambosM : null
    };
  } catch(e) { return null; }
}

// Verificar se aposta bateu baseado no resultado e estatísticas
function verificarAposta(jogo, golsCasa, golsFora, stats = null) {
  const total = golsCasa + golsFora;
  const aposta = jogo.aposta?.toLowerCase() || '';
  const mercado = jogo.mercado?.toLowerCase() || '';
  const casaVence = golsCasa > golsFora;
  const foraVence = golsFora > golsCasa;
  const empate = golsCasa === golsFora;

  // Helper: verificar over/under genérico
  const checkOverUnder = (valor, linha) => {
    const n = parseFloat(linha);
    if (aposta.includes(`over ${linha}`) || aposta.includes(`mais de ${linha}`)) return valor > n ? 'green' : 'red';
    if (aposta.includes(`under ${linha}`) || aposta.includes(`menos de ${linha}`)) return valor < n ? 'green' : 'red';
    return null;
  };

  // ── MERCADO GOLS ──────────────────────────────────────────
  if (mercado === 'gols') {
    for (const linha of ['0.5','1.5','2.5','3.5','4.5']) {
      const r = checkOverUnder(total, linha);
      if (r) return r;
    }
    // Ambos marcam
    if (aposta.includes('ambos marcam') || aposta.includes('ambas marcam') || aposta.includes('btts')) {
      const ambos = golsCasa > 0 && golsFora > 0;
      if (aposta.includes('não') || aposta.includes('nao') || aposta.includes('- não')) return ambos ? 'red' : 'green';
      return ambos ? 'green' : 'red';
    }
    // Time marca primeiro / anytime
    if (aposta.includes('marca')) {
      const nomeCasa = jogo.time_casa?.toLowerCase() || '';
      const nomeFora = jogo.time_fora?.toLowerCase() || '';
      const palavrasCasa = nomeCasa.split(' ').filter(p => p.length > 3);
      const palavrasFora = nomeFora.split(' ').filter(p => p.length > 3);
      if (palavrasCasa.some(p => aposta.includes(p))) return golsCasa > 0 ? 'green' : 'red';
      if (palavrasFora.some(p => aposta.includes(p))) return golsFora > 0 ? 'green' : 'red';
    }
  }

  // ── MERCADO ESCANTEIOS ────────────────────────────────────
  if (mercado === 'escanteios' && stats) {
    const esc = stats.escanteiosTotal;
    for (const linha of ['7.5','8.5','9.5','10.5','11.5','12.5']) {
      const r = checkOverUnder(esc, linha);
      if (r) return r;
    }
    // Escanteios por time
    if (aposta.includes('escanteios casa') || aposta.includes('cantos casa')) {
      for (const linha of ['3.5','4.5','5.5','6.5']) {
        const r = checkOverUnder(stats.escanteiosCasa, linha);
        if (r) return r;
      }
    }
  }

  // ── MERCADO CARTÕES ───────────────────────────────────────
  if (mercado === 'cartoes' && stats) {
    const cart = stats.cartoesTotal;
    for (const linha of ['1.5','2.5','3.5','4.5','5.5']) {
      const r = checkOverUnder(cart, linha);
      if (r) return r;
    }
    // Cartões por time
    const nomeCasa = jogo.time_casa?.toLowerCase() || '';
    const nomeFora = jogo.time_fora?.toLowerCase() || '';
    const palavrasCasa = nomeCasa.split(' ').filter(p => p.length > 3);
    const palavrasFora = nomeFora.split(' ').filter(p => p.length > 3);
    if (palavrasCasa.some(p => aposta.includes(p))) {
      for (const linha of ['0.5','1.5','2.5']) {
        const r = checkOverUnder(stats.cartoesCasa, linha);
        if (r) return r;
      }
    }
    if (palavrasFora.some(p => aposta.includes(p))) {
      for (const linha of ['0.5','1.5','2.5']) {
        const r = checkOverUnder(stats.cartoesFora, linha);
        if (r) return r;
      }
    }
  }

  // ── MERCADO RESULTADO ─────────────────────────────────────
  if (mercado === 'resultado') {
    const nomeCasa = jogo.time_casa?.toLowerCase() || '';
    const nomeFora = jogo.time_fora?.toLowerCase() || '';
    const palavrasCasa = nomeCasa.split(' ').filter(p => p.length > 3);
    const apostaMencCasa = palavrasCasa.some(p => aposta.includes(p));
    const apostaMencFora = !apostaMencCasa && nomeFora.split(' ').filter(p => p.length > 3).some(p => aposta.includes(p));

    if (aposta.includes('empate')) return empate ? 'green' : 'red';
    if (aposta.includes('ou empata') || aposta.includes('vence ou empata') || aposta.includes('dupla chance')) {
      if (apostaMencCasa) return (casaVence || empate) ? 'green' : 'red';
      if (apostaMencFora) return (foraVence || empate) ? 'green' : 'red';
    }
    if (aposta.includes('vence') || aposta.includes('vitória') || aposta.includes('vitoria')) {
      if (apostaMencCasa) return casaVence ? 'green' : 'red';
      if (apostaMencFora) return foraVence ? 'green' : 'red';
    }
  }

  return 'pendente';
}

async function agentValidar(data) {
  console.log(`\n🔍 Validando ${data}`);
  const row = await dbGet(data);
  if (!row?.apostas?.jogos) { console.log('Sem apostas'); return; }
  if (row.resultados) { console.log('Já validado'); return; }

  const jogos = row.apostas.jogos;
  const resultados = [];
  let cacheFixtures = null; // Cache das fixtures do dia para evitar múltiplas chamadas

  for (const jogo of jogos) {
    console.log(`  Verificando: ${jogo.time_casa} x ${jogo.time_fora}`);
    let placar = null, golsCasa = null, golsFora = null, fixtureIdUsado = jogo.fixtureId || null;

    try {
      // Tentar pelo fixtureId salvo
      if (jogo.fixtureId) {
        const res = await buscarResultadoFixture(jogo.fixtureId);
        if (res) { placar = res.placar; golsCasa = res.golsCasa; golsFora = res.golsFora; }
        await sleep(300);
      }

      // Fallback: buscar pelo nome dos times
      if (golsCasa === null) {
        if (!cacheFixtures) {
          // Buscar todos os fixtures do dia de uma vez (1 requisição)
          if (!contarRequisicao()) { resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: 'limite API', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora }); continue; }
          const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`, { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
          const json = await res.json();
          cacheFixtures = json.response || [];
          await sleep(300);
        }

        const normalizar = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
        const nCasa = normalizar(jogo.time_casa), nFora = normalizar(jogo.time_fora);
        const fixture = cacheFixtures.find(f => {
          const hN = normalizar(f.teams?.home?.name), aN = normalizar(f.teams?.away?.name);
          const status = f.fixture?.status?.short;
          if (!['FT','AET','PEN'].includes(status)) return false;
          return (hN?.includes(nCasa?.split(' ')[0]) || nCasa?.includes(hN?.split(' ')[0])) &&
                 (aN?.includes(nFora?.split(' ')[0]) || nFora?.includes(aN?.split(' ')[0]));
        });

        if (fixture) {
          golsCasa = fixture.goals?.home;
          golsFora = fixture.goals?.away;
          placar = `${golsCasa}-${golsFora}`;
          fixtureIdUsado = fixture.fixture?.id || fixtureIdUsado;
        }
      }

      if (golsCasa !== null && golsFora !== null) {
        // Buscar stats detalhadas se precisar (cartões/escanteios)
        let stats = null;
        const mercado = jogo.mercado?.toLowerCase() || '';
        if (['escanteios','cartoes'].includes(mercado) && fixtureIdUsado) {
          stats = await buscarStatsFixture(fixtureIdUsado);
          await sleep(300);
        }
        const resultado = verificarAposta(jogo, golsCasa, golsFora, stats);
        console.log(`    ✅ ${placar} → ${resultado.toUpperCase()}`);
        resultados.push({ encontrado: true, placar, resultado_aposta: resultado, motivo: `${jogo.time_casa} ${golsCasa} x ${golsFora} ${jogo.time_fora}`, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
      } else {
        console.log(`    ⏳ Resultado não encontrado`);
        resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: 'resultado não encontrado na API', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
      }
    } catch(err) {
      console.log(`    ❌ Erro: ${err.message}`);
      resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: err.message, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
    }
  }

  await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: resultados });
  const g = resultados.filter(r=>r.resultado_aposta==='green').length;
  const r = resultados.filter(r=>r.resultado_aposta==='red').length;
  const p = resultados.filter(r=>r.resultado_aposta==='pendente').length;
  console.log(`✅ Validação: ${g} green, ${r} red, ${p} pendente`);
}

async function agentDiario(data) {
  const row = await dbGet(data);
  if (!row?.resultados) return;
  const apostas = row.apostas?.jogos || [];
  const resultados = row.resultados?.apostas || [];
  const g = resultados.filter(r=>r.resultado_aposta==='green').length;
  const r = resultados.filter(r=>r.resultado_aposta==='red').length;
  const total = g + r;
  const assert = total > 0 ? ((g/total)*100).toFixed(2) : 0;
  const detalhes = resultados.map(r => { const a = apostas.find(x=>x.id===r.jogo_id); return `- ${r.time_casa} x ${r.time_fora}: ${a?.aposta||r.aposta} → ${r.resultado_aposta?.toUpperCase()} (${r.placar||'-'}) | ${r.motivo}`; }).join('\n');
  const relatorio = await chamarIA(`Analise apostas do dia ${data}. Assertividade: ${assert}% (${g} green, ${r} red).\n${detalhes}\nIdentifique padrões de erro. Máx 300 palavras.`, 2000);
  if (!relatorio) return;
  await dbSaveCalibracao('diario', data, data, relatorio, parseFloat(assert));
  console.log(`✅ Relatório diário — ${assert}%`);
}

async function agentSemanal() {
  const hoje = hojeStr();
  const diarios = await dbGetCalibracoes('diario', 7);
  if (!diarios.length) return;
  const media = (diarios.reduce((s,d)=>s+(parseFloat(d.assertividade)||0),0)/diarios.length).toFixed(2);
  const inicio = diarios[diarios.length-1].periodo_inicio;
  const textos = diarios.map((d,i)=>`Dia ${i+1} (${d.periodo_inicio}) — ${d.assertividade}%:\n${d.relatorio}`).join('\n---\n');
  const relatorio = await chamarIA(`Consolide relatórios diários em semanal. Período: ${inicio} a ${hoje} | Média: ${media}%\n\n${textos}\n\nPatterns, recomendações. Máx 400 palavras.`, 2000);
  if (!relatorio) return;
  await dbSaveCalibracao('semanal', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracaoAntiga('diario');
  console.log(`✅ Semanal — ${media}%`);
}

async function agentMensal() {
  const hoje = hojeStr();
  const semanais = await dbGetCalibracoes('semanal', 5);
  if (!semanais.length) return;
  const media = (semanais.reduce((s,x)=>s+(parseFloat(x.assertividade)||0),0)/semanais.length).toFixed(2);
  const inicio = semanais[semanais.length-1].periodo_inicio;
  const textos = semanais.map((s,i)=>`Semana ${i+1} (${s.periodo_inicio}→${s.periodo_fim}) — ${s.assertividade}%:\n${s.relatorio}`).join('\n---\n');
  const relatorio = await chamarIA(`Consolide semanais em mensal. Período: ${inicio} a ${hoje} | Média: ${media}%\n\n${textos}\n\n${parseFloat(media)>=80?'Acima de 80% — mantenha.':'Abaixo de 80% — o que mudar?'} Máx 500 palavras.`, 3000);
  if (!relatorio) return;
  await dbSaveCalibracao('mensal', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracaoAntiga('semanal');
  console.log(`✅ Mensal — ${media}%`);
}

async function agentSemestral() {
  const hoje = hojeStr();
  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length < 3) return;
  const media = (mensais.reduce((s,m)=>s+(parseFloat(m.assertividade)||0),0)/mensais.length).toFixed(2);
  const inicio = mensais[mensais.length-1].periodo_inicio;
  const textos = mensais.map((m,i)=>`Mês ${i+1} (${m.periodo_inicio}→${m.periodo_fim}) — ${m.assertividade}%:\n${m.relatorio}`).join('\n---\n');
  const relatorio = await chamarIA(`Consolide mensais em semestral. Período: ${inicio} a ${hoje} | Média: ${media}%\n\n${textos}\n\nEvolução, padrões, estratégias. Máx 600 palavras.`, 4000);
  if (!relatorio) return;
  await dbSaveCalibracao('semestral', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracaoAntiga('mensal');
  console.log(`✅ Semestral — ${media}%`);
}

async function rotinaNoturna() {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);
  console.log(`\n🌙 Rotina noturna — ${hoje}`);
  await agentValidar(ontem);
  await agentDiario(ontem);
  if (diaSemana(hoje) === 0) await agentSemanal();
  if (hoje.substring(8,10) === ultimoDiaMes(hoje)) await agentMensal();
  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length >= 6) await agentSemestral();
  if (apiSuspensa && apiErrorMsg.includes('Limite')) {
    apiSuspensa = false; apiErrorMsg = ''; reqHoje = 0;
    console.log('✅ Bloqueio de API resetado');
  }
  console.log('✅ Rotina noturna concluída');
}

// ─── Endpoints ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', api: 'API-Football v3',
  api_suspensa: apiSuspensa, api_erro: apiErrorMsg || null,
  req_hoje: reqHoje, limite: LIMITE_SEGURO
}));

app.get('/api-status', async (req, res) => {
  const ok = await verificarStatusAPI();
  res.json({ ok, suspensa: apiSuspensa, erro: apiErrorMsg || null, req_hoje: reqHoje, limite: LIMITE_SEGURO, uso: ((reqHoje/LIMITE_SEGURO)*100).toFixed(1)+'%' });
});

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
      if (cached?.apostas) { console.log('✅ Cache hit'); return res.json(cached.apostas); }
      console.log('Cache miss — gerando...');
    }
    const resultado = await gerarApostas(data, horaMin, metaJogos);
    if (!resultado) return res.json({ jogos: [], aviso: 'Nenhum jogo encontrado.' });
    if (SUPABASE_URL && SUPABASE_KEY) { await dbSave(data, resultado); console.log('✅ Salvo no banco'); }
    res.json(resultado);
  } catch (err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/apostas/:periodo', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Banco não configurado.' });
  const { periodo } = req.params;
  const hoje = hojeStr();
  let dataConsulta;
  if (periodo === 'ontem') dataConsulta = diaOffset(hoje, -1);
  else if (periodo === 'hoje') dataConsulta = hoje;
  else if (periodo === 'amanha') dataConsulta = diaOffset(hoje, 1);
  else return res.status(400).json({ error: 'Use: ontem, hoje ou amanha.' });
  try {
    const cached = await dbGet(dataConsulta);
    if (cached?.apostas) return res.json({ data: dataConsulta, ...cached.apostas, resultados: cached.resultados });
    return res.json({ data: dataConsulta, jogos: [], aviso: `Apostas para ${dataConsulta} ainda não foram geradas.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/rotina-noturna', async (req, res) => {
  res.json({ mensagem: 'Rotina iniciada' });
  rotinaNoturna().catch(console.error);
});

app.post('/validar/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });
  res.json({ mensagem: `Validação de ${data} iniciada` });
  agentValidar(data).then(() => agentDiario(data)).catch(console.error);
});

app.get('/calibracao', async (req, res) => {
  const [semestral, mensal, semanal, diario] = await Promise.all([
    dbGetCalibracao('semestral'), dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'), dbGetCalibracao('diario')
  ]);
  res.json({ semestral, mensal, semanal, diario });
});

// Endpoint para buscar TODOS os relatórios de calibração (para aba Relatórios)
app.get('/calibracao-todos', async (req, res) => {
  try {
    const [semestrais, mensais, semanais, diarios] = await Promise.all([
      dbGetCalibracoes('semestral', 10),
      dbGetCalibracoes('mensal', 12),
      dbGetCalibracoes('semanal', 8),
      dbGetCalibracoes('diario', 30)
    ]);
    res.json({ semestrais, mensais, semanais, diarios });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Endpoint para buscar datas disponíveis no banco (para limitar calendário)
app.get('/datas-disponiveis', async (req, res) => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?select=data&order=data.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    const datas = (rows || []).map(r => r.data);
    res.json({ datas });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Endpoint para o dashboard buscar apostas + resultados por data
app.get('/apostas-resultado/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });
  try {
    const row = await dbGet(data);
    if (!row || !row.apostas) return res.json({ data, apostas: null, resultados: null });
    return res.json({ data, apostas: row.apostas, resultados: row.resultados || null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

function agendarRotina() {
  const agora = new Date();
  const prox = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()+1, 0, 5, 0));
  const ms = prox.getTime() - agora.getTime();
  console.log(`⏰ Próxima rotina em ${Math.round(ms/60000)} min`);
  setTimeout(() => {
    rotinaNoturna().catch(console.error);
    setInterval(() => rotinaNoturna().catch(console.error), 24*60*60*1000);
  }, ms);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarRotina();
});
