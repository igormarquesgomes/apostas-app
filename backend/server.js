const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MANUS_API_KEY = process.env.MANUS_API_KEY;

// ─── Manus AI ────────────────────────────────────────────────
async function chamarManus(prompt, timeoutMs = 120000) {
  if (!MANUS_API_KEY) {
    console.log('⚠️ MANUS_API_KEY não configurada — pulando');
    return null;
  }
  try {
    console.log('🔍 Manus: buscando dados na web...');
    // Criar tarefa
    const res = await fetch('https://api.manus.ai/v1/tasks', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'API_KEY': MANUS_API_KEY
      },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) {
      console.error(`❌ Manus erro: ${res.status}`);
      return null;
    }
    const task = await res.json();
    const taskId = task.task_id || task.id;
    if (!taskId) { console.error('❌ Manus: sem task_id'); return null; }
    console.log(`🔍 Manus task: ${taskId}`);

    // Aguardar conclusão com polling
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      await sleep(5000);
      const statusRes = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
        headers: { 'accept': 'application/json', 'API_KEY': MANUS_API_KEY }
      });
      if (!statusRes.ok) continue;
      const status = await statusRes.json();
      const estado = status.status || status.state;
      if (estado === 'completed' || estado === 'stopped') {
        console.log(`✅ Manus concluído: ${taskId}`);
        return status.result || status.output || status.message || JSON.stringify(status);
      }
      if (estado === 'failed' || estado === 'error') {
        console.error(`❌ Manus falhou: ${taskId}`);
        return null;
      }
      console.log(`🔍 Manus aguardando... (${Math.round((Date.now()-inicio)/1000)}s)`);
    }
    console.error(`❌ Manus timeout após ${timeoutMs/1000}s`);
    return null;
  } catch(e) {
    console.error('❌ Manus erro:', e.message);
    return null;
  }
}
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const ODDS_API_KEY = process.env.ODDS_API_KEY;

// ─── The Odds API ─────────────────────────────────────────────
// Mapeamento de ligas para a The Odds API
const ODDS_SPORT_KEYS = {
  'soccer_brazil_campeonato': 'Série A',
  'soccer_brazil_serie_b': 'Série B',
  'soccer_conmebol_copa_libertadores': 'Libertadores',
  'soccer_conmebol_copa_sudamericana': 'Sul-Americana',
  'soccer_uefa_champs_league': 'Champions League',
  'soccer_uefa_europa_league': 'Europa League',
  'soccer_spain_la_liga': 'La Liga',
  'soccer_italy_serie_a': 'Serie A IT',
  'soccer_epl': 'Premier League',
  'soccer_germany_bundesliga': 'Bundesliga',
  'soccer_france_ligue_one': 'Ligue 1',
};

// Cache de odds do dia — busca 1x por dia
let oddsCacheData = null;
let oddsCacheDate = '';
let oddsReqHoje = 0;
const ODDS_LIMITE = 25; // máx 25 chamadas/mês para ficar bem dentro dos 500

async function buscarOddsDia(data) {
  // Só busca 1 vez por dia
  if (oddsCacheDate === data && oddsCacheData) {
    console.log('✅ Odds cache hit');
    return oddsCacheData;
  }

  if (oddsReqHoje >= ODDS_LIMITE) {
    console.warn(`⚠️ Odds API: limite mensal de segurança atingido (${ODDS_LIMITE} req)`);
    return null;
  }

  if (!ODDS_API_KEY) {
    console.log('ℹ️ ODDS_API_KEY não configurada');
    return null;
  }

  try {
    const todasOdds = {};
    // Só buscar ligas prioritárias que têm mais chance de ter odds
    const sports = [
      'soccer_brazil_campeonato',
      'soccer_brazil_serie_b',
      'soccer_conmebol_copa_libertadores',
      'soccer_conmebol_copa_sudamericana',
      'soccer_uefa_champs_league',
      'soccer_uefa_europa_league',
      'soccer_spain_la_liga',
      'soccer_italy_serie_a',
      'soccer_epl',
    ];

    for (const sport of sports) {
      if (oddsReqHoje >= ODDS_LIMITE) break;

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`;
      const res = await fetch(url);

      if (!res.ok) {
        if (res.status === 422) continue; // Liga sem jogos hoje — normal
        console.log(`⚠️ Odds API ${sport}: HTTP ${res.status}`);
        continue;
      }

      const remaining = res.headers.get('x-requests-remaining');
      const used = res.headers.get('x-requests-used');
      if (used || remaining) console.log(`📊 Odds API: ${used} usados, ${remaining} restantes`);

      if (remaining && parseInt(remaining) < 50) {
        console.warn(`⚠️ Odds API: apenas ${remaining} créditos restantes!`);
        oddsReqHoje = ODDS_LIMITE;
        break;
      }

      const jogos = await res.json();
      oddsReqHoje++;

      for (const jogo of jogos) {
        const jogoData = jogo.commence_time?.substring(0, 10);
        if (jogoData !== data) continue;
        const key = `${jogo.home_team}|${jogo.away_team}`;
        todasOdds[key] = jogo.bookmakers || [];
      }

      await sleep(300);
    }

    oddsCacheData = todasOdds;
    oddsCacheDate = data;
    console.log(`✅ Odds carregadas para ${data}: ${Object.keys(todasOdds).length} jogos`);
    return todasOdds;
  } catch(e) {
    console.error('Erro buscarOdds:', e.message);
    return null;
  }
}

// Encontrar odds de um jogo específico
function extrairOdds(todasOdds, timeCasa, timeFora, mercado) {
  if (!todasOdds) return null;

  const normalizar = s => s?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,' ').trim();
  const nCasa = normalizar(timeCasa), nFora = normalizar(timeFora);
  const palavraCasa = nCasa?.split(' ')[0] || '';
  const palavraFora = nFora?.split(' ')[0] || '';

  // Encontrar jogo por nome aproximado
  let jogoOdds = null;
  for (const [key, bookmakers] of Object.entries(todasOdds)) {
    const [hNome, aNome] = key.split('|').map(normalizar);
    if ((hNome?.includes(palavraCasa) || palavraCasa?.includes(hNome?.split(' ')[0])) &&
        (aNome?.includes(palavraFora) || palavraFora?.includes(aNome?.split(' ')[0]))) {
      jogoOdds = bookmakers;
      break;
    }
  }

  if (!jogoOdds || !jogoOdds.length) return null;

  // Calcular odd média do mercado solicitado
  let oddCasa = [], oddEmpate = [], oddFora = [], oddOver = [], oddUnder = [];

  for (const bm of jogoOdds) {
    for (const market of bm.markets || []) {
      if (market.key === 'h2h') {
        for (const outcome of market.outcomes || []) {
          const n = normalizar(outcome.name);
          if (n === nCasa || n?.includes(palavraCasa)) oddCasa.push(outcome.price);
          else if (n === 'draw') oddEmpate.push(outcome.price);
          else oddFora.push(outcome.price);
        }
      }
      if (market.key === 'totals') {
        for (const outcome of market.outcomes || []) {
          if (outcome.name === 'Over') oddOver.push(outcome.price);
          if (outcome.name === 'Under') oddUnder.push(outcome.price);
        }
      }
    }
  }

  const media = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : null;

  return {
    casa: media(oddCasa),
    empate: media(oddEmpate),
    fora: media(oddFora),
    over: media(oddOver),
    under: media(oddUnder),
    bookmakers: jogoOdds.length
  };
}

// Selecionar a odd correta baseado na aposta definida
function selecionarOdd(oddsJogo, aposta, timeCasa, timeFora) {
  if (!oddsJogo) return null;
  const a = aposta?.toLowerCase() || '';
  const nCasa = timeCasa?.toLowerCase() || '';
  const nFora = timeFora?.toLowerCase() || '';
  const palavrasCasa = nCasa.split(' ').filter(p=>p.length>3);
  const mencCasa = palavrasCasa.some(p=>a.includes(p));
  const mencFora = !mencCasa && nFora.split(' ').filter(p=>p.length>3).some(p=>a.includes(p));

  if (a.includes('over')) return oddsJogo.over;
  if (a.includes('under') || a.includes('menos de')) return oddsJogo.under;
  if (a.includes('empate')) return oddsJogo.empate;
  if (mencCasa && (a.includes('vence') || a.includes('vitória'))) return oddsJogo.casa;
  if (mencFora && (a.includes('vence') || a.includes('vitória'))) return oddsJogo.fora;
  return null;
}

// IDs de liga na API-Football
// Seleções campeãs do mundo (para filtrar eliminatórias e amistosos)
const SELECOES_CAMPEAS = new Set([
  // Brasil (5x), Alemanha (4x), Itália (4x), Argentina (3x), França (2x),
  // Uruguai (2x), Inglaterra (1x), Espanha (1x)
  'brazil','brasil',
  'germany','deutschland','alemanha',
  'italy','italia','itália',
  'argentina',
  'france','franca','frança',
  'uruguay','uruguai',
  'england','inglaterra',
  'spain','espanha','españa',
]);

function isSelecaoCampea(timeCasa, timeFora) {
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
  const nc = n(timeCasa), nf = n(timeFora);
  // Verificar match exato ou parcial
  return [...SELECOES_CAMPEAS].some(s => {
    const sn = n(s);
    return nc === sn || nf === sn ||
           nc?.includes(sn) || nf?.includes(sn) ||
           sn.includes(nc?.split(' ')[0]) || sn.includes(nf?.split(' ')[0]);
  });
}

// Times que participam de Champions League ou Europa League nas grandes ligas
// Quando esses times jogam na liga nacional, têm prioridade extra
const TIMES_CHAMPIONS = new Set([
  // Serie A Italiana
  'inter','inter milan','internazionale','milan','ac milan','juventus','napoli','atalanta','lazio','roma','fiorentina',
  // La Liga
  'real madrid','barcelona','atletico madrid','athletic bilbao','real sociedad','villarreal','sevilla','betis',
  // Premier League
  'manchester city','arsenal','liverpool','chelsea','manchester united','tottenham','newcastle','aston villa',
  // Bundesliga
  'bayer leverkusen','bayer 04 leverkusen','borussia dortmund','dortmund','rb leipzig','leipzig','bayern munich','bayern munchen','eintracht frankfurt','wolfsburg',
  // Ligue 1
  'paris saint germain','psg','marseille','monaco','lille','lyon','brest',
  // Liga Portugal
  'benfica','porto','sporting cp','sporting','braga',
]);

function isTimesChampions(timeCasa, timeFora) {
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
  const nc = n(timeCasa), nf = n(timeFora);
  return [...TIMES_CHAMPIONS].some(t => nc?.includes(t) || nf?.includes(t) || t.includes(nc?.split(' ')[0]) || t.includes(nf?.split(' ')[0]));
}

const LIGAS_PRIORITY = {
  // Brasil
  71:  { nome:'Série A',               tipo:'a',    pri:1 },
  72:  { nome:'Série B',               tipo:'b',    pri:2 },
  // Copa do Mundo
  1:   { nome:'Copa do Mundo',         tipo:'copa', pri:3 },
  // Copas internacionais
  13:  { nome:'Libertadores',          tipo:'copa', pri:4 },
  11:  { nome:'Sul-Americana',         tipo:'copa', pri:4 },
  3:   { nome:'Europa League',         tipo:'copa', pri:4 },
  2:   { nome:'Champions League',      tipo:'copa', pri:4 },
  // Grandes ligas europeias (pri 5 com times Champions, pri 6 sem)
  135: { nome:'Serie A 🇮🇹',           tipo:'it',   pri:5 },
  140: { nome:'La Liga 🇪🇸',            tipo:'es',   pri:5 },
  39:  { nome:'Premier League',        tipo:'eu',   pri:5 },
  78:  { nome:'Bundesliga',            tipo:'eu',   pri:5 },
  61:  { nome:'Ligue 1',               tipo:'eu',   pri:5 },
  94:  { nome:'Liga Portugal',         tipo:'eu',   pri:5 },
  // Eliminatórias Copa do Mundo (só seleções campeãs) — entre pri6 e sul-americanas
  29:  { nome:'Eliminatórias CONMEBOL',tipo:'copa', pri:65, selecaoCampea:true },
  34:  { nome:'Eliminatórias UEFA',    tipo:'copa', pri:65, selecaoCampea:true },
  // Amistosos internacionais (só seleções campeãs)
  10:  { nome:'Amistoso Internacional',tipo:'copa', pri:66, selecaoCampea:true },
};

// IDs a ignorar explicitamente (ligas brasileiras que NÃO são prioritárias)
const LIGAS_IGNORAR = new Set([
  75, 76,      // Série C e Série D
  1098,        // Paulista Série B
  851,         // Carioca A2
  936, 614, 619, 620, 613, // Estaduais div 2
  1073, 1076, 1086, 1100, 1107, 1128, 1069, 1071, // Sub-20 e U17
  1148, 1158, 1096, 1097,  // Copas regionais
  1146, 1143,  // Alagoano-2, Estadual Junior
  // Competições internacionais sub-categorias
  921, 928, 914, 973, // UEFA U17, ASEAN U19, Tournoi Revello, CAF U17
]);

// Países com ligas muito fracas — evitar como complementar
// Só os piores — manter lista pequena para não bloquear demais em dias fracos
const PAISES_IGNORAR_COMP = new Set([
  'aruba','andorra','san marino','gibraltar','liechtenstein',
  'timor-leste','fyr macedonia',
]);

// Filtro adicional por nome para ligas regionais brasileiras que escapam pelo ID
function ligaBrasileiraNaoRelevante(ligaNome, pais) {
  if (pais !== 'Brazil' && pais !== 'Brasil') return false;
  const l = ligaNome?.toLowerCase() || '';
  return (
    l.includes('alagoano') || l.includes('baiano') || l.includes('carioca') ||
    l.includes('cearense') || l.includes('catarinense') || l.includes('gaúcho') ||
    l.includes('gaucho') || l.includes('goiano') || l.includes('maranhense') ||
    l.includes('matogrossense') || l.includes('mineiro') || l.includes('paraense') ||
    l.includes('paranaense') || l.includes('paulista') || l.includes('pernambucano') ||
    l.includes('potiguar') || l.includes('rondoniense') || l.includes('roraimense') ||
    l.includes('sergipano') || l.includes('tocantinense') || l.includes('capixaba') ||
    l.includes('piauiense') || l.includes('amazonense') || l.includes('acreano') ||
    l.includes('estadual') || l.includes('copa espirito') || l.includes('copa gaucha') ||
    l.includes('- 2') || l.includes('serie d') || l.includes('serie c')
  );
}

// Times europeus de segunda linha (Champions/Europa participantes)
// Quando um desses times aparecer, prioridade sobre sul-americanos
const TIMES_EUROPA_B = new Set([
  // Holanda
  'ajax','psv','psv eindhoven','feyenoord',
  // Bélgica
  'club brugge','anderlecht','genk',
  // Turquia
  'galatasaray','fenerbahce','fenerbahçe','besiktas','beşiktaş',
  // Escócia
  'celtic','rangers',
  // Áustria
  'red bull salzburg','salzburg','sturm graz',
  // Suíça
  'basel','young boys','bsc young boys',
  // Dinamarca
  'copenhagen','fc copenhagen','midtjylland','fc midtjylland',
  // Sérvia
  'red star belgrade','crvena zvezda','partizan',
  // Ucrânia
  'dynamo kyiv','shakhtar donetsk','shakhtar',
  // Noruega
  'bodo/glimt','bodø/glimt','rosenborg',
  // Croácia
  'dinamo zagreb',
]);

function isTimesEuropaB(timeCasa, timeFora) {
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
  const nc = n(timeCasa), nf = n(timeFora);
  return TIMES_EUROPA_B.has(nc) || TIMES_EUROPA_B.has(nf) ||
    [...TIMES_EUROPA_B].some(t => nc?.includes(t) || nf?.includes(t));
}

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

// ─── Monitor de custos Anthropic ─────────────────────────────
// Preços aproximados por 1M tokens (mai/2026)
const CUSTO_SONNET_INPUT  = 3.00;  // USD por 1M tokens input
const CUSTO_SONNET_OUTPUT = 15.00; // USD por 1M tokens output
const CUSTO_HAIKU_INPUT   = 0.80;  // USD por 1M tokens input
const CUSTO_HAIKU_OUTPUT  = 4.00;  // USD por 1M tokens output
const ALERTA_CUSTO_DIA    = 0.50;  // USD — alertar se passar disso no dia

let custoHoje = 0;
let custoDia = '';
let chamadas = { sonnet: 0, haiku: 0, webSearch: 0 };

function registrarCusto(modelo, inputTokens, outputTokens) {
  const hoje = hojeStr();
  if (custoDia !== hoje) { custoDia = hoje; custoHoje = 0; chamadas = { sonnet: 0, haiku: 0, webSearch: 0 }; }

  let custo = 0;
  if (modelo.includes('sonnet')) {
    custo = (inputTokens / 1e6) * CUSTO_SONNET_INPUT + (outputTokens / 1e6) * CUSTO_SONNET_OUTPUT;
    chamadas.sonnet++;
  } else {
    custo = (inputTokens / 1e6) * CUSTO_HAIKU_INPUT + (outputTokens / 1e6) * CUSTO_HAIKU_OUTPUT;
    chamadas.haiku++;
  }
  custoHoje += custo;

  const custoFmt = custoHoje.toFixed(4);
  console.log(`💸 Custo estimado hoje: $${custoFmt} (Sonnet: ${chamadas.sonnet}x, Haiku: ${chamadas.haiku}x)`);

  if (custoHoje > ALERTA_CUSTO_DIA) {
    console.warn(`🚨 ALERTA: Custo diário alto! $${custoFmt} — dia atípico detectado!`);
  }
}

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

// ─── Múltiplas ───────────────────────────────────────────────
async function dbSaveMultiplas(data, multiplas) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ multiplas })
    });
  } catch(e) { console.error('Erro dbSaveMultiplas:', e.message); }
}

async function dbSaveResultadosMultiplas(data, resultados_multiplas) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultados_multiplas })
    });
  } catch(e) { console.error('Erro dbSaveResultadosMultiplas:', e.message); }
}

async function dbGetComMultiplas(data) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}&select=apostas,resultados,multiplas,resultados_multiplas`,
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

async function dbGetCalibracaoPorPeriodo(tipo, periodoInicio) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.${tipo}&periodo_inicio=eq.${periodoInicio}&select=id,relatorio,assertividade`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows.length > 0 ? rows[0] : null;
  } catch(e) { return null; }
}

async function dbSaveCalibracao(tipo, periodoInicio, periodoFim, relatorio, assertividade) {
  try {
    // Verificar se já existe relatório para este período
    const existente = await dbGetCalibracaoPorPeriodo(tipo, periodoInicio);

    if (existente) {
      // Complementar com IA: mesclar relatório antigo + novo
      console.log(`🔄 Complementando relatório ${tipo} de ${periodoInicio}...`);
      const promptComplementar = `Você é um analista de apostas esportivas. Você tem um relatório de calibração existente e um novo relatório com informações adicionais. Sua tarefa é COMPLEMENTAR o relatório existente com as novas informações, gerando um relatório único mais completo e atualizado.

RELATÓRIO EXISTENTE (assertividade: ${existente.assertividade}%):
${existente.relatorio}

NOVAS INFORMAÇÕES (assertividade atual: ${assertividade}%):
${relatorio}

Gere um único relatório complementado que:
1. Mantenha os padrões já identificados no relatório anterior
2. Adicione os novos padrões e informações encontrados
3. Atualize a análise com base na assertividade atual (${assertividade}%)
4. Seja mais completo que ambos os relatórios separados
5. Mantenha o mesmo estilo técnico e objetivo

Retorne APENAS o texto do relatório complementado, sem títulos extras.`;

      const relatorioComplementado = await chamarIA(promptComplementar, 3000);
      const relatorioFinal = relatorioComplementado || relatorio;
      const assertividadeFinal = assertividade; // usar a mais recente

      // Atualizar registro existente
      await fetch(`${SUPABASE_URL}/rest/v1/calibracao?id=eq.${existente.id}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ relatorio: relatorioFinal, assertividade: assertividadeFinal, periodo_fim: periodoFim })
      });
      console.log(`✅ Relatório ${tipo} complementado`);
    } else {
      // Criar novo relatório
      await fetch(`${SUPABASE_URL}/rest/v1/calibracao`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo, periodo_inicio: periodoInicio, periodo_fim: periodoFim, relatorio, assertividade })
      });
      console.log(`✅ Relatório ${tipo} criado`);
    }
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

    // Log de seleções/amistosos para descobrir IDs
    // Log de TODAS as ligas internacionais
    const ligasInternacionais = [...new Set(
      fixtures.filter(f => {
        const nome = f.league?.name?.toLowerCase() || '';
        const pais = f.league?.country?.toLowerCase() || '';
        return pais === 'world' || pais === '' ||
               nome.includes('world cup') || nome.includes('qualification') ||
               nome.includes('friendly') || nome.includes('amistoso') ||
               nome.includes('nations') || nome.includes('eliminat') ||
               nome.includes('international') || nome.includes('copa do mundo');
      }).map(f => `ID:${f.league?.id} — ${f.league?.name} (${f.league?.country}) | ${f.teams?.home?.name} x ${f.teams?.away?.name} | ${new Date(f.fixture?.timestamp*1000).toISOString()}`)
    )];
    if (ligasInternacionais.length) console.log(`🌍 Ligas internacionais encontradas:\n  ${ligasInternacionais.join('\n  ')}`);
    else console.log('🌍 Nenhuma liga internacional encontrada nos fixtures');

    // Log específico: buscar Brasil e Alemanha independente do dia
    const selFocus = fixtures.filter(f => {
      const h = f.teams?.home?.name?.toLowerCase() || '';
      const a = f.teams?.away?.name?.toLowerCase() || '';
      return ['brazil','germany','france','argentina','spain','italy','england','uruguay'].some(s => h.includes(s) || a.includes(s));
    });
    if (selFocus.length) console.log(`⚽ Seleções encontradas:\n  ${selFocus.map(f => `ID_LIGA:${f.league?.id} [${f.league?.name}] ${f.teams?.home?.name} x ${f.teams?.away?.name} | ${new Date(f.fixture?.timestamp*1000).toISOString()}`).join('\n  ')}`);
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
      if (!json.error) {
        console.log(`✅ Modelo: ${modelo}`);
        // Registrar custo
        const usage = json.usage || {};
        registrarCusto(modelo, usage.input_tokens || 2000, usage.output_tokens || 500);
        return (json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
      }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

// ─── IA com busca web (para estatísticas reais) ─────────────
async function chamarIAComBusca(prompt, maxTokens = 8000) {
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
        // Registrar custo
        const usage = json.usage || {};
        registrarCusto(modelo, usage.input_tokens || 3000, usage.output_tokens || 800);
        chamadas.webSearch++;
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
  // Buscar todos os tipos de relatório + últimos 7 diários
  const [semestral, mensal, semanal, diarios] = await Promise.all([
    dbGetCalibracao('semestral'),
    dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'),
    dbGetCalibracoes('diario', 7)
  ]);

  let mem = '';

  // Semestral e mensal — contexto macro
  if (semestral) mem += `[SEMESTRAL ${semestral.periodo_inicio}→${semestral.periodo_fim} | ${semestral.assertividade}%]\n${semestral.relatorio.substring(0,500)}\n\n`;
  if (mensal)    mem += `[MENSAL ${mensal.periodo_inicio}→${mensal.periodo_fim} | ${mensal.assertividade}%]\n${mensal.relatorio.substring(0,500)}\n\n`;
  if (semanal)   mem += `[SEMANAL ${semanal.periodo_inicio}→${semanal.periodo_fim} | ${semanal.assertividade}%]\n${semanal.relatorio.substring(0,600)}\n\n`;

  // Todos os diários disponíveis — do mais antigo para o mais recente
  if (diarios?.length) {
    const diariosList = [...diarios].reverse(); // mais antigo primeiro
    diariosList.forEach(d => {
      mem += `[DIÁRIO ${d.periodo_inicio} | ${d.assertividade}%]\n${d.relatorio.substring(0,400)}\n\n`;
    });
  }

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

    // Ignorar ligas regionais brasileiras pelo nome
    if (ligaBrasileiraNaoRelevante(ligaNome, pais)) continue;

    // Identificar liga por ID
    const ligaMatch = LIGAS_PRIORITY[ligaId];

    if (ligaMatch) {
      let priFinal = ligaMatch.pri;

      // Copa do Mundo — sempre pri 3
      if (ligaMatch.pri === 3) priFinal = 3;

      // Grandes ligas: times Champions pri 5, outros pri 6
      else if (ligaMatch.pri === 5 && !isTimesChampions(timeCasa, timeFora)) priFinal = 6;

      // Eliminatórias e Amistosos: só seleções campeãs
      else if (ligaMatch.selecaoCampea) {
        if (!isSelecaoCampea(timeCasa, timeFora)) continue; // Ignorar se não for seleção campeã
        priFinal = ligaMatch.pri; // 7=eliminatórias, 8=amistosos
      }

      if (!jogosMap.has(key))
        jogosMap.set(key, { liga: ligaMatch.nome, tipo: ligaMatch.tipo, pri: priFinal, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
    } else {
      // Complementares — definir tipo CORRETO e prioridade pelo país
      const paisLower = pais.toLowerCase();

      // Ignorar países com ligas muito fracas
      if (PAISES_IGNORAR_COMP.has(paisLower)) continue;

      let priComp = 20;
      let tipoComp = 'other';

      const EUROPEUS = ["england","scotland","spain","italy","france","germany","portugal","netherlands","belgium","turkey","austria","switzerland","denmark","norway","croatia","serbia","ukraine","greece","russia","poland","czech-republic","finland","sweden","hungary","romania","slovakia","bulgaria","georgia","albania","armenia","estonia","latvia","lithuania","luxembourg","malta","wales","ireland","iceland","cyprus","north macedonia","montenegro","kosovo","andorra","faroe islands","gibraltar","bosnia"];
      const SUL_AMERICANOS = ["argentina","colombia","chile","uruguay","peru","venezuela","bolivia","ecuador","paraguay"];
      const AFRICA_ORIENTE = ["egypt","morocco","algeria","tunisia","saudi-arabia","uae","qatar","kuwait","jordan","iran","nigeria","ghana","senegal","ivory coast","cameroon","south africa"];

      if (EUROPEUS.includes(paisLower)) {
        tipoComp = 'eu';
        priComp = isTimesEuropaB(timeCasa, timeFora) ? 50 : 90;
      } else if (SUL_AMERICANOS.includes(paisLower)) {
        tipoComp = 'sul';
        priComp = 70;
      } else if (AFRICA_ORIENTE.includes(paisLower)) {
        tipoComp = 'af';
        priComp = 80;
      } else {
        // Todo o resto — menor prioridade possível
        priComp = 200;
      }

      if (!jogosComp.has(key))
        jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: tipoComp, pri: priComp, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
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
  // ─── Manus: buscar odds Estrela Bet + lesões + escalações ───
  let dadosManus = '';
  if (MANUS_API_KEY) {
    const listaJogosManus = jogos.map(j =>
      `${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`
    ).join('\n');

    const promptManus = `Você é analista de apostas esportivas. Para os jogos abaixo, busque na web:
1. Odds atuais na Estrela Bet para cada jogo (mercados: resultado, over/under 2.5 gols, ambas marcam)
2. Lesões e desfalques confirmados de cada time
3. Escalações prováveis se disponíveis
4. Algum contexto relevante (motivação, sequência recente, clima do clube)

JOGOS:
${listaJogosManus}

Retorne um resumo estruturado por jogo com os dados encontrados. Seja conciso e objetivo.`;

    dadosManus = await chamarManus(promptManus, 180000) || '';
    if (dadosManus) console.log(`✅ Manus: dados recebidos (${dadosManus.length} chars)`);
    else console.log('⚠️ Manus: sem dados — seguindo sem');
  }

  const memoria = await buscarMemoria();
  const blocoManus = dadosManus ? `\nDADOS WEB (Manus — odds Estrela Bet, lesões, escalações):\n${dadosManus.substring(0,3000)}\n` : '';
  const blocoMem = memoria ? `\nHISTÓRICO DE CALIBRAÇÃO (use para melhorar as apostas):\n${memoria.substring(0,3000)}\n` : '';
  if (memoria) {
    const nDiarios = (memoria.match(/\[DIÁRIO/g) || []).length;
    const temSemanal = memoria.includes('[SEMANAL');
    const temMensal = memoria.includes('[MENSAL');
    console.log(`📚 Memória carregada: ${nDiarios} diário(s)${temSemanal?' + semanal':''}${temMensal?' + mensal':''} — ${memoria.length} chars`);
  } else {
    console.log('📚 Sem memória de calibração disponível');
  }

  function montarListaJogos(lista, offsetId = 0) {
    return lista.map((j, i) => {
      const s = j._stats;
      const sc = s?.statsCasa, sf = s?.statsFora;
      return `${offsetId+i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}
   Casa: forma=${sc?.forma||'?'} gols/jogo=${sc?.mediaGols||'?'} esc=${sc?.mediaEscanteios||'?'} cart=${sc?.mediaCartoes||'?'}
   Fora: forma=${sf?.forma||'?'} gols/jogo=${sf?.mediaGols||'?'} esc=${sf?.mediaEscanteios||'?'} cart=${sf?.mediaCartoes||'?'}
   H2H: ${sc?.h2hTexto||'sem dados'}`;
    }).join('\n');
  }

  function montarPrompt(listaJogos, blocoMem, df, blocoManusParam='') {
    return `Você é um analista de apostas esportivas experiente. Para cada jogo, raciocine como um apostador profissional que busca a melhor relação entre confiança e risco.

DATA: ${df}
${blocoMem}${blocoManusParam}
JOGOS COM ESTATÍSTICAS REAIS (últimos 10 jogos de cada time):
${listaJogos}

PROCESSO DE ANÁLISE para cada jogo (raciocine internamente antes de decidir):

PASSO 1 — Entenda o perfil do jogo:
- Qual time tem vantagem clara? Existe vantagem real ou é equilibrado?
- O histórico H2H e forma recente confirmam essa vantagem?
- Use web_search para verificar lesões, escalações e contexto atual

PASSO 2 — Avalie a aposta mais natural:
- Se encontrou uma aposta clara, ela é segura o suficiente?
- Existe uma forma de manter a mesma direção com mais segurança?
  (ex: time tem vantagem mas jogo é imprevisível → dupla chance em vez de vitória simples)
  (ex: jogo deve ter poucos gols mas há incerteza → Under 3.5 em vez de Under 2.5)
  (ex: time favorito provavelmente marca → "time X marca" como segurança)

PASSO 3 — Se o jogo for imprevisível em resultado/gols:
- Analise os padrões de escanteios: ambos os times têm média consistente? O padrão é claro?
- Analise os padrões de cartões: jogos entre esses times costumam ter mais ou menos cartões?
- Se escanteios ou cartões tiverem padrão mais confiável que resultado/gols, prefira esses mercados

PASSO 4 — Decisão final:
- Escolha a aposta com maior confiança real, não a mais óbvia
- Nunca force uma aposta arriscada só para seguir o mercado mais comum
- A justificativa deve explicar POR QUE essa aposta específica foi escolhida em vez de alternativas

REGRAS:
- Série A e Série B têm análise OBRIGATÓRIA
- Preencha TODOS os campos com valores numéricos reais — nunca use "-"
- Use o histórico de calibração para evitar padrões que já erraram

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"A","time_fora":"B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"Analisei vitória do time casa mas jogo é equilibrado. Optei por dupla chance pois casa tem leve vantagem sem garantia. Escanteios também considerados mas média inconsistente (7-11 nos últimos jogos)."}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;
  }

  // Dividir em 2 lotes para não ultrapassar rate limit de tokens
  const LOTE = 8;
  const lote1 = jogos.slice(0, LOTE);
  const lote2 = jogos.slice(LOTE);

  const prompt1 = montarPrompt(montarListaJogos(lote1, 0), blocoMem, df, blocoManus);
  console.log(`\n🤖 Lote 1: ${lote1.length} jogos...`);
  const txt1 = await chamarIAComBusca(prompt1);
  
  let jogosResultado = [];
  if (txt1) {
    try {
      const s1 = txt1.indexOf('{'), e1 = txt1.lastIndexOf('}');
      if (s1 !== -1) {
        const r1 = JSON.parse(txt1.slice(s1, e1+1));
        jogosResultado = [...(r1.jogos || [])];
        console.log(`✅ Lote 1: ${jogosResultado.length} apostas geradas`);
      }
    } catch(e) { console.error('❌ Erro parse lote 1:', e.message); }
  } else {
    console.error('❌ Lote 1: sem resposta da IA');
  }

  if (lote2.length > 0) {
    console.log(`\n⏳ Aguardando 90s antes do lote 2 (rate limit)...`);
    await sleep(90000); // 90s para garantir reset do rate limit de tokens/min
    console.log(`\n🤖 Lote 2: ${lote2.length} jogos...`);
    const prompt2 = montarPrompt(montarListaJogos(lote2, LOTE), blocoMem, df, blocoManus);
    // Lote 2: tentar com web_search primeiro (mantém qualidade), fallback sem
    console.log('🤖 Lote 2: tentando com web_search...');
    let txt2 = await chamarIAComBusca(prompt2, 8000);
    if (!txt2) {
      console.log('🤖 Lote 2: fallback sem web_search...');
      txt2 = await chamarIA(prompt2, 8000);
    }

    // Se ainda falhou, dividir lote 2 em 2a e 2b
    if (!txt2) {
      console.log('⚠️ Lote 2 falhou — dividindo em sublotes 2a e 2b...');
      const lote2a = lote2.slice(0, Math.ceil(lote2.length / 2));
      const lote2b = lote2.slice(Math.ceil(lote2.length / 2));

      // Sublote 2a
      const prompt2a = montarPrompt(montarListaJogos(lote2a, LOTE), blocoMem, df);
      const txt2a = await chamarIA(prompt2a, 6000);
      if (txt2a) {
        try {
          const s = txt2a.indexOf('{'), e = txt2a.lastIndexOf('}');
          if (s !== -1) {
            const r = JSON.parse(txt2a.slice(s, e+1));
            jogosResultado = [...jogosResultado, ...(r.jogos || [])];
            console.log(`✅ Sublote 2a: ${r.jogos?.length || 0} apostas`);
          }
        } catch(e) { console.error('❌ Erro parse 2a:', e.message); }
      }

      await sleep(30000);

      // Sublote 2b
      const prompt2b = montarPrompt(montarListaJogos(lote2b, LOTE + lote2a.length), blocoMem, df);
      const txt2b = await chamarIA(prompt2b, 6000);
      if (txt2b) {
        try {
          const s = txt2b.indexOf('{'), e = txt2b.lastIndexOf('}');
          if (s !== -1) {
            const r = JSON.parse(txt2b.slice(s, e+1));
            jogosResultado = [...jogosResultado, ...(r.jogos || [])];
            console.log(`✅ Sublote 2b: ${r.jogos?.length || 0} apostas`);
          }
        } catch(e) { console.error('❌ Erro parse 2b:', e.message); }
      }
    } else {
      try {
        // Parse robusto — pega o JSON completo mesmo com texto extra
        let jsonTxt = txt2;
        const s2 = txt2.indexOf('{"jogos"');
        const e2 = txt2.lastIndexOf('}');
        if (s2 !== -1) jsonTxt = txt2.slice(s2, e2+1);
        else {
          const s2b = txt2.indexOf('{');
          if (s2b !== -1) jsonTxt = txt2.slice(s2b, e2+1);
        }
        const r2 = JSON.parse(jsonTxt);
        const jogos2 = r2.jogos || [];
        jogosResultado = [...jogosResultado, ...jogos2];
        console.log(`✅ Lote 2: ${jogos2.length} apostas geradas`);
      } catch(e) {
        console.error('❌ Erro parse lote 2:', e.message);
        // Tentar sublotes como último recurso
        console.log('⚠️ Tentando sublotes...');
        const lote2aF = lote2.slice(0, Math.ceil(lote2.length/2));
        const lote2bF = lote2.slice(Math.ceil(lote2.length/2));
        for (const [idx, sublote] of [[0, lote2aF],[lote2aF.length, lote2bF]]) {
          const pt = montarPrompt(montarListaJogos(sublote, LOTE+idx), blocoMem, df);
          const tx = await chamarIA(pt, 5000);
          if (tx) {
            try {
              const s = tx.indexOf('{'), e = tx.lastIndexOf('}');
              if (s !== -1) {
                const r = JSON.parse(tx.slice(s,e+1));
                jogosResultado = [...jogosResultado, ...(r.jogos||[])];
                console.log(`✅ Sublote: ${r.jogos?.length||0} apostas`);
              }
            } catch(err) { console.error('❌ Erro sublote:', err.message); }
            await sleep(20000);
          }
        }
      }
    }
  }

  console.log(`✅ Total apostas geradas: ${jogosResultado.length}`);
  const resultado = { jogos: jogosResultado };

  // Criar mapa de fixtureId por nome dos times (normalizado)
  const norm = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
  const fixtureMap = new Map();
  const metaMap = new Map();
  for (const jg of jogos) {
    const key = `${norm(jg.timeCasa)}|${norm(jg.timeFora)}`;
    fixtureMap.set(key, jg.fixtureId);
    metaMap.set(key, { tipo: jg.tipo, liga: jg.liga, pri: jg.pri, teamCasaId: jg.teamCasaId, teamForaId: jg.teamForaId });
  }

  // Corrigir tipo_liga, liga e recuperar fixtureId dos jogos originais
  if (resultado.jogos) {
    resultado.jogos = resultado.jogos.map((j) => {
      const key = `${norm(j.time_casa)}|${norm(j.time_fora)}`;
      const fixtureId = fixtureMap.get(key) || null;
      const meta = metaMap.get(key) || {};
      if (!fixtureId) console.log(`⚠️ Sem fixtureId: ${j.time_casa} x ${j.time_fora}`);

      return {
        ...j,
        tipo_liga: meta.tipo || j.tipo_liga || 'eu',
        liga: meta.liga || j.liga || 'Internacional',
        pri: meta.pri || 20,
        fixtureId: fixtureId || j.fixtureId || null,
        teamCasaId: meta.teamCasaId || j.teamCasaId || null,
        teamForaId: meta.teamForaId || j.teamForaId || null,
      };
    });

    // Ordenar por prioridade original
    resultado.jogos.sort((a, b) => (a.pri || 20) - (b.pri || 20));

    // Log de fixtureIds para debug
    const semFixture = resultado.jogos.filter(j => !j.fixtureId);
    if (semFixture.length) console.log(`⚠️ Jogos sem fixtureId: ${semFixture.map(j=>j.time_casa+' x '+j.time_fora).join(', ')}`);
  }

  // Buscar odds reais da The Odds API (1 chamada/dia, cached)
  console.log('\n💰 Buscando odds reais...');
  const todasOdds = await buscarOddsDia(data);

  // Enriquecer cada aposta com a odd real do mercado
  if (resultado.jogos && todasOdds) {
    for (const jogo of resultado.jogos) {
      const oddsJogo = extrairOdds(todasOdds, jogo.time_casa, jogo.time_fora, jogo.mercado);
      const oddReal = selecionarOdd(oddsJogo, jogo.aposta, jogo.time_casa, jogo.time_fora);

      if (oddReal) {
        jogo.odd_mercado = parseFloat(oddReal); // odd real do mercado
        // Se odd do mercado for muito baixa (< 1.20), alertar
        if (parseFloat(oddReal) < 1.20) {
          jogo.alerta_odd = true;
          jogo.confianca = 'baixa';
        }
      }
    }
    console.log(`✅ Odds reais aplicadas`);
  }

  return resultado;
}

// ─── Geração de Múltiplas ────────────────────────────────────
const PRIORIDADES_MULTIPLA = new Set([1,2,3,4,5,6]); // Só até pri 6

async function gerarMultiplas(data, jogosDodia) {
  // Filtrar por horário >= 13:00 (único filtro obrigatório)
  const comHorario = jogosDodia.filter(j => {
    const h = j.horario || j.hora || '00:00';
    const [hh, mm] = h.split(':').map(Number);
    const totalMin = hh * 60 + (mm || 0);
    if (totalMin < 13 * 60) {
      console.log(`  ⏰ Excluído das múltiplas (horário ${h}): ${j.time_casa||j.timeCasa} x ${j.time_fora||j.timeFora}`);
      return false;
    }
    return true;
  });

  // Preferir jogos prioritários (pri 1-6 ou tipo a/b/copa/it/es/eu)
  const prioritarios = comHorario.filter(j => {
    const tipo = j.tipo_liga || j.tipo || '';
    return PRIORIDADES_MULTIPLA.has(j.pri || 99) || ['a','b','copa','it','es','eu'].includes(tipo);
  });

  // Se tiver 4+ prioritários, usar só eles. Senão, usar todos os jogos do dia
  const jogosElegiveis = prioritarios.length >= 4 ? prioritarios : comHorario;
  console.log(`🎯 Jogos elegíveis para múltiplas: ${jogosElegiveis.length} (${prioritarios.length} prioritários, ${comHorario.length} total)`);
  if (jogosElegiveis.length < 2) {
    console.log('Poucos jogos elegíveis para múltiplas');
    return null;
  }

  const lista = jogosElegiveis.map((j,i) =>
    `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario} | pri:${j.pri}`
  ).join('\n');

  const prompt = `Você é especialista em apostas múltiplas. Analise os jogos elegíveis abaixo e monte 2 sugestões de múltiplas para a Estrela Bet.

JOGOS ELEGÍVEIS (prioridade 1-6):
${lista}

REGRAS:
- Múltipla A: odd total entre 3.50 e 4.50 (mais jogos)
- Múltipla B: odd total entre 2.50 e 3.49 (menos jogos, mais seguro)
- Use APENAS jogos da lista acima
- A aposta de cada jogo PODE ser diferente da aposta simples do dia
- Escolha o mercado com MAIOR probabilidade de acerto para cada jogo
- Não repita necessariamente os mesmos jogos nas duas múltiplas
- Prefira alta confiança em todos os jogos da múltipla
- Use web_search para verificar lesões/escalações dos jogos selecionados

Retorne SOMENTE JSON:
{
  "multipla_a": {
    "odd_total": 4.10,
    "jogos": [
      {"liga":"Série A","time_casa":"Flamengo","time_fora":"Vasco","horario":"16:00","aposta":"Flamengo marca","mercado":"gols","odd":1.60,"justificativa":"Flamengo marcou em 8 dos últimos 10 jogos em casa."}
    ]
  },
  "multipla_b": {
    "odd_total": 3.10,
    "jogos": [
      {"liga":"Série A","time_casa":"Flamengo","time_fora":"Vasco","horario":"16:00","aposta":"Over 1.5 gols","mercado":"gols","odd":1.35,"justificativa":"Últimos 10 jogos tiveram mais de 1.5 gols em 9 deles."}
    ]
  }
}`;

  // Múltiplas não precisam de web_search — dados já vêm das estatísticas
  const txt = await chamarIA(prompt, 4000);
  if (!txt) return null;
  try {
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s === -1) return null;
    return JSON.parse(txt.slice(s, e+1));
  } catch(err) {
    console.error('Erro parse múltiplas:', err.message);
    return null;
  }
}

// Validar resultado de uma múltipla
async function validarMultipla(multipla, resultadosApostas) {
  if (!multipla?.jogos?.length) return null;

  const resultadosJogos = multipla.jogos.map(j => {
    // Buscar resultado do jogo nos resultados do dia
    const res = resultadosApostas.find(r =>
      r.time_casa === j.time_casa && r.time_fora === j.time_fora
    );
    if (!res || res.resultado_aposta === 'pendente') return 'pendente';

    // Verificar se a aposta específica da múltipla bateu
    if (!res.placar) return 'pendente';
    const partes = res.placar.split('-');
    const golsCasa = parseInt(partes[0]) || 0;
    const golsFora = parseInt(partes[1]) || 0;

    const jogoFake = { ...j, time_casa: j.time_casa, time_fora: j.time_fora };
    const resultado = verificarAposta(jogoFake, golsCasa, golsFora, null);
    return resultado;
  });

  const todosGreen = resultadosJogos.every(r => r === 'green');
  const algumRed = resultadosJogos.some(r => r === 'red');
  const temPendente = resultadosJogos.some(r => r === 'pendente');

  return {
    resultado: algumRed ? 'red' : todosGreen ? 'green' : 'pendente',
    jogos_resultado: multipla.jogos.map((j, i) => ({
      ...j,
      resultado: resultadosJogos[i]
    }))
  };
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
    console.log(`    📊 Status fixture ${fixtureId}: ${status}`);
    if (!['FT','AET','PEN'].includes(status)) {
      console.log(`    ⏳ Jogo não finalizado (${status}) — pendente`);
      return null;
    }
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

    if (aposta.includes('empate') && !aposta.includes('vence') && !aposta.includes('dupla')) return empate ? 'green' : 'red';
    if (aposta.includes('ou empat') || aposta.includes('vence ou empat') || aposta.includes('dupla chance') || aposta.includes('x2') || aposta.includes('1x') || aposta.includes('12')) {
      if (aposta.includes('x2') || apostaMencFora) return (foraVence || empate) ? 'green' : 'red';
      if (aposta.includes('1x') || apostaMencCasa) return (casaVence || empate) ? 'green' : 'red';
      if (aposta.includes('12')) return (casaVence || foraVence) ? 'green' : 'red';
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

  // Se já validado, verificar se tem pendentes para revalidar
  if (row.resultados) {
    const pendentes = row.resultados.apostas?.filter(r => r.resultado_aposta === 'pendente') || [];
    if (pendentes.length === 0) {
      console.log('Já validado completamente — sem pendentes');
      return;
    }
    console.log(`Revalidando ${pendentes.length} apostas pendentes...`);
  }

  const jogos = row.apostas.jogos;
  // Manter resultados já confirmados e revalidar apenas pendentes
  const resultadosExistentes = row.resultados?.apostas || [];
  const resultados = [];
  let cacheFixtures = null;

  for (const jogo of jogos) {
    // Se foi corrigido manualmente, nunca revalidar
    const resExistente = resultadosExistentes.find(r => r.jogo_id === jogo.id);
    if (resExistente?.corrigido_manualmente) {
      console.log(`  ✏️ Mantendo correção manual: ${jogo.time_casa} x ${jogo.time_fora} → ${resExistente.resultado_aposta.toUpperCase()}`);
      resultados.push(resExistente);
      continue;
    }
    // Se já tem resultado confirmado (green/red), manter e pular
    if (resExistente && resExistente.resultado_aposta !== 'pendente') {
      console.log(`  ✅ Mantendo: ${jogo.time_casa} x ${jogo.time_fora} → ${resExistente.resultado_aposta.toUpperCase()}`);
      resultados.push(resExistente);
      continue;
    }

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
          const casaMatch = hN?.includes(nCasa?.split(' ')[0]) || nCasa?.includes(hN?.split(' ')[0]);
          const foraMatch = aN?.includes(nFora?.split(' ')[0]) || nFora?.includes(aN?.split(' ')[0]);
          if (casaMatch && foraMatch) {
            console.log(`    📊 Match: ${f.teams?.home?.name} x ${f.teams?.away?.name} | ${status}`);
          }
          return casaMatch && foraMatch;
        });

        if (fixture) {
          golsCasa = fixture.goals?.home;
          golsFora = fixture.goals?.away;
          placar = `${golsCasa}-${golsFora}`;
          fixtureIdUsado = fixture.fixture?.id || fixtureIdUsado;
          console.log(`    ✅ Placar encontrado via nome: ${placar}`);
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
        console.log(`    ✅ ${placar} | mercado:${jogo.mercado} | aposta:${jogo.aposta} → ${resultado.toUpperCase()}`);
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

  // Manus: buscar todos os pendentes de uma vez
  const pendentes = resultados.filter(r => r.resultado_aposta === 'pendente');
  if (pendentes.length > 0 && MANUS_API_KEY) {
    try {
      const lista = pendentes.map(r => `${r.time_casa} x ${r.time_fora}`).join(', ');
      console.log(`🔍 Manus: buscando ${pendentes.length} resultados pendentes...`);
      const resposta = await chamarManus(
        `Busque o placar final dos seguintes jogos do dia ${data}. Para cada jogo retorne no formato "Time Casa X-Y Time Fora" ou "pendente" se ainda não terminou.

Jogos: ${lista}`,
        120000
      );
      if (resposta) {
        for (const pend of pendentes) {
          const nCasa = pend.time_casa?.split(' ')[0]?.toLowerCase();
          const nFora = pend.time_fora?.split(' ')[0]?.toLowerCase();
          const regex = new RegExp(`${nCasa}[^\d]*(\d+)[^\d]+(\d+)`, 'i');
          const match = resposta.toLowerCase().match(regex);
          if (match) {
            const gC = parseInt(match[1]), gF = parseInt(match[2]);
            const placarM = `${gC}-${gF}`;
            const jogo = jogos.find(j => j.time_casa === pend.time_casa);
            if (jogo) {
              const res = verificarAposta(jogo, gC, gF, null);
              const idx = resultados.findIndex(r => r.jogo_id === pend.jogo_id);
              if (idx !== -1) {
                resultados[idx] = { ...resultados[idx], placar: placarM, resultado_aposta: res, motivo: `Via Manus: ${pend.time_casa} ${gC} x ${gF} ${pend.time_fora}` };
                console.log(`    ✅ Manus: ${pend.time_casa} x ${pend.time_fora} → ${placarM} → ${res.toUpperCase()}`);
              }
            }
          }
        }
      }
    } catch(e) { console.error('❌ Manus validação:', e.message); }
  }

  await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: resultados });
  const g = resultados.filter(r=>r.resultado_aposta==='green').length;
  const r = resultados.filter(r=>r.resultado_aposta==='red').length;
  const p = resultados.filter(r=>r.resultado_aposta==='pendente').length;
  console.log(`✅ Validação: ${g} green, ${r} red, ${p} pendente`);

  // Validar múltiplas automaticamente
  const rowMultiplas = await dbGetComMultiplas(data);
  if (rowMultiplas?.multiplas) {
    console.log('🎯 Validando múltiplas...');
    const resA = await validarMultipla(rowMultiplas.multiplas.multipla_a, resultados);
    const resB = await validarMultipla(rowMultiplas.multiplas.multipla_b, resultados);
    if (resA || resB) {
      await dbSaveResultadosMultiplas(data, {
        validado_em: new Date().toISOString(),
        multipla_a: resA,
        multipla_b: resB
      });
      console.log(`✅ Múltiplas: A=${resA?.resultado||'?'} B=${resB?.resultado||'?'}`);
    }
  }
}

// Calcular quais mercados alternativos teriam dado green num jogo red
function calcularAlternativas(jogo, placar, stats) {
  if (!placar) return [];
  const partes = placar.split('-');
  if (partes.length !== 2) return [];
  const golsCasa = parseInt(partes[0]) || 0;
  const golsFora = parseInt(partes[1]) || 0;
  const totalGols = golsCasa + golsFora;
  const alternativas = [];

  // Só calcula para jogos RED
  const jGols = { ...jogo, mercado: 'gols' };
  const jRes  = { ...jogo, mercado: 'resultado' };
  const jEsc  = { ...jogo, mercado: 'escanteios' };
  const jCart = { ...jogo, mercado: 'cartoes' };

  // Mercado gols — verificar Over/Under
  if (totalGols > 2.5) alternativas.push(`Over 2.5 gols (${totalGols} gols no jogo)`);
  if (totalGols < 2.5) alternativas.push(`Under 2.5 gols (${totalGols} gols no jogo)`);
  if (totalGols > 1.5) alternativas.push(`Over 1.5 gols`);
  if (golsCasa > 0 && golsFora > 0) alternativas.push('Ambos marcam - Sim');
  if (golsCasa === 0 || golsFora === 0) alternativas.push('Ambos marcam - Não');

  // Mercado resultado
  if (golsCasa > golsFora) alternativas.push(`${jogo.time_casa} vence (${placar})`);
  if (golsFora > golsCasa) alternativas.push(`${jogo.time_fora} vence (${placar})`);
  if (golsCasa === golsFora) alternativas.push(`Empate (${placar})`);

  // Mercado escanteios (se tiver stats)
  if (stats?.escanteiosTotal) {
    const esc = stats.escanteiosTotal;
    if (esc > 9.5) alternativas.push(`Over 9.5 escanteios (${esc} no jogo)`);
    if (esc < 9.5) alternativas.push(`Under 9.5 escanteios (${esc} no jogo)`);
  }

  // Mercado cartões (se tiver stats)
  if (stats?.cartoesTotal) {
    const cart = stats.cartoesTotal;
    if (cart > 3.5) alternativas.push(`Over 3.5 cartões (${cart} no jogo)`);
    if (cart < 3.5) alternativas.push(`Under 3.5 cartões (${cart} no jogo)`);
  }

  return alternativas;
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

  // Montar detalhes com alternativas para jogos RED
  const detalhes = resultados.map(r => {
    const a = apostas.find(x=>x.id===r.jogo_id);
    let linha = `- ${r.time_casa} x ${r.time_fora}: ${a?.aposta||r.aposta} → ${r.resultado_aposta?.toUpperCase()} (${r.placar||'-'}) | ${r.motivo}`;

    // Para jogos RED, calcular mercados alternativos que teriam dado green
    if (r.resultado_aposta === 'red' && r.placar) {
      const alts = calcularAlternativas(a || r, r.placar, null);
      // Remover a aposta que já foi feita das alternativas
      const apostaFeita = (a?.aposta || r.aposta || '').toLowerCase();
      const altsFiltradas = alts.filter(alt => !apostaFeita.includes(alt.split(' ')[0].toLowerCase()));
      if (altsFiltradas.length > 0) {
        linha += `\n  💡 Alternativas que dariam GREEN: ${altsFiltradas.slice(0,3).join(' | ')}`;
      }
    }
    return linha;
  }).join('\n');

  // Identificar jogos com confiança baixa (potenciais red flags)
  const baixaConfianca = apostas.filter(a => a.confianca === 'baixa').map(a => `${a.time_casa} x ${a.time_fora}`);

  const promptDiario = `Analise as apostas do dia ${data}. Assertividade: ${assert}% (${g} green, ${r} red).

RESULTADOS:
${detalhes}

${baixaConfianca.length > 0 ? `JOGOS COM BAIXA CONFIANÇA (red flags): ${baixaConfianca.join(', ')}` : ''}

INSTRUÇÕES:
1. Identifique padrões de erro nos jogos RED
2. Para os jogos RED que tiveram alternativas disponíveis, analise quais mercados (escanteios, cartões, resultado) seriam mais seguros
3. Sugira: em jogos com dificuldade de aposta segura, quais mercados têm mais histórico de acerto?
4. Registre padrões de "red flag" — situações em que é melhor ir para mercados alternativos
Máx 400 palavras.`;

  // Incluir resultado das múltiplas no relatório
  const rowM = await dbGetComMultiplas(data);
  let blocoMultiplas = '';
  if (rowM?.resultados_multiplas) {
    const rm = rowM.resultados_multiplas;
    const rA = rm.multipla_a;
    const rB = rm.multipla_b;
    blocoMultiplas = `\nMÚLTIPLAS DO DIA:
- Múltipla A (odd ~${rowM.multiplas?.multipla_a?.odd_total||'?'}): ${rA?.resultado?.toUpperCase()||'PENDENTE'}
  Jogos: ${rA?.jogos_resultado?.map(j=>`${j.time_casa} x ${j.time_fora} (${j.aposta}) → ${j.resultado?.toUpperCase()||'?'}`).join(', ')||'-'}
- Múltipla B (odd ~${rowM.multiplas?.multipla_b?.odd_total||'?'}): ${rB?.resultado?.toUpperCase()||'PENDENTE'}
  Jogos: ${rB?.jogos_resultado?.map(j=>`${j.time_casa} x ${j.time_fora} (${j.aposta}) → ${j.resultado?.toUpperCase()||'?'}`).join(', ')||'-'}`;
  }

  // Manus gera relatório paralelo com contexto web
  let relatorioManus = '';
  if (MANUS_API_KEY) {
    const greens = resultados.filter(r=>r.resultado_aposta==='green').map(r=>`✅ ${r.time_casa} x ${r.time_fora} (${r.placar})`).join('\n');
    const reds = resultados.filter(r=>r.resultado_aposta==='red').map(r=>`❌ ${r.time_casa} x ${r.time_fora} (${r.placar})`).join('\n');
    const promptManus = `Você é analista de apostas esportivas. Analise os resultados do dia ${data} e gere um relatório conciso.

GREENS (${g}):
${greens || 'nenhum'}

REDS (${r}):
${reds || 'nenhum'}

Assertividade: ${assert}%

Para cada jogo RED, busque na web o que aconteceu (lesões, arbitragem, contexto) que pode explicar o resultado inesperado.
Para os jogos GREEN, confirme o que foi acertado na análise.
Identifique padrões: quais tipos de aposta/liga estão performando melhor ou pior?
Máx 300 palavras.`;

    relatorioManus = await chamarManus(promptManus, 120000) || '';
    if (relatorioManus) console.log('✅ Manus: relatório diário gerado');
  }

  // Consolidar relatórios Anthropic + Manus
  const promptFinal = relatorioManus
    ? `${promptDiario}${blocoMultiplas}\n\nRELATÓRIO DA MANUS (contexto web):\n${relatorioManus}\n\nConsolide os dois relatórios em um único. Máx 500 palavras.`
    : `${promptDiario}${blocoMultiplas}\n\nSe as múltiplas deram RED, identifique qual jogo quebrou e sugira alternativa de mercado para próximas múltiplas.`;

  const relatorio = await chamarIA(promptFinal, 3000);
  if (!relatorio) return;
  await dbSaveCalibracao('diario', data, data, relatorio, parseFloat(assert));
  console.log(`✅ Relatório diário — ${assert}%`);
}

async function agentSemanal() {
  const hoje = hojeStr();
  // Buscar TODOS os diários disponíveis
  const diarios = await dbGetCalibracoes('diario', 100);
  if (!diarios.length) return;
  console.log(`📊 Semanal: consolidando ${diarios.length} diário(s)...`);
  const media = (diarios.reduce((s,d)=>s+(parseFloat(d.assertividade)||0),0)/diarios.length).toFixed(2);
  const inicio = diarios[diarios.length-1].periodo_inicio;
  const textos = diarios.map((d,i)=>`Dia ${i+1} (${d.periodo_inicio}) — ${d.assertividade}%:\n${d.relatorio}`).join('\n---\n');
  const relatorio = await chamarIA(`Consolide relatórios diários em semanal. Período: ${inicio} a ${hoje} | Média: ${media}%\n\n${textos}\n\nPatterns, recomendações. Máx 400 palavras.`, 2000);
  if (!relatorio) return;
  await dbSaveCalibracao('semanal', inicio, hoje, relatorio, parseFloat(media));
  // Diários apagados na rotina de terça (1 dia depois)
  console.log(`✅ Semanal — ${media}% (${diarios.length} dias consolidados)`);
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
  // Semanais apagados na rotina do dia 02 (1 dia depois)
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
  // Mensais apagados na rotina do dia 02 do mês seguinte (1 dia depois)
  console.log(`✅ Semestral — ${media}%`);
}

async function rotinaNoturna() {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);
  const diaDaSemana = diaSemana(hoje); // 0=dom, 1=seg, 2=ter...
  const diaDoMes = parseInt(hoje.substring(8,10));
  console.log(`\n🌙 Rotina noturna — ${hoje}`);

  // 1. Validar e gerar relatório do dia anterior
  await agentValidar(ontem);
  await agentDiario(ontem);

  // 2. Semanal: rodar na rotina de domingo→segunda (diaSemana===1 = segunda)
  if (diaDaSemana === 1) {
    console.log('📅 Segunda-feira — gerando semanal...');
    await agentSemanal();
  }

  // 3. Apagar diários: na terça, apagar apenas os da semana anterior (antes de segunda)
  if (diaDaSemana === 2) {
    console.log('🗑️ Terça-feira — apagando diários da semana anterior...');
    const segunda = diaOffset(hoje, -1); // segunda = ontem
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.diario&periodo_inicio=lt.${segunda}`,
        { method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' } }
      );
      console.log(`✅ Diários anteriores a ${segunda} apagados`);
    } catch(e) { console.error('Erro ao apagar diários:', e.message); }
  }

  // 4. Mensal: no último dia do mês
  const ultimoDia = ultimoDiaMes(hoje);
  if (hoje.substring(8,10) === ultimoDia) {
    console.log('📅 Último dia do mês — gerando mensal...');
    await agentMensal();
  }

  // 5. Apagar semanais: dia 02 do mês (1 dia após o mensal do último dia)
  if (diaDoMes === 2) {
    console.log('🗑️ Dia 02 — apagando semanais consolidados...');
    await dbDeleteCalibracaoAntiga('semanal');
  }

  // 6. Semestral: após 6 mensais disponíveis
  const mensais = await dbGetCalibracoes('mensal', 100);
  if (mensais.length >= 6) {
    console.log('📅 6 mensais disponíveis — gerando semestral...');
    await agentSemestral();
  }

  // 7. Apagar mensais: 1 dia após o semestral (dia 02 do mês após semestral)
  // O semestral é gerado no último dia do 6º mês, então apagar no dia 02 do 7º mês
  // Reusa a condição do dia 02 mas só se já tiver semestral
  if (diaDoMes === 2) {
    const semestral = await dbGetCalibracao('semestral');
    if (semestral) {
      console.log('🗑️ Dia 02 — apagando mensais consolidados no semestral...');
      await dbDeleteCalibracaoAntiga('mensal');
    }
  }

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
  req_hoje: reqHoje, limite: LIMITE_SEGURO,
  custo_hoje_usd: parseFloat(custoHoje.toFixed(4)),
  chamadas_ia: chamadas,
  alerta_custo: custoHoje > ALERTA_CUSTO_DIA
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
    if (SUPABASE_URL && SUPABASE_KEY) {
      // Verificar fixtureIds antes de salvar
      const comFix = resultado.jogos?.filter(j => j.fixtureId)?.length || 0;
      const semFix = resultado.jogos?.filter(j => !j.fixtureId)?.length || 0;
      console.log(`💾 Salvando: ${comFix} jogos com fixtureId, ${semFix} sem`);
      if (semFix > 0) console.log(`⚠️ Sem fixtureId: ${resultado.jogos?.filter(j=>!j.fixtureId).map(j=>j.time_casa+' x '+j.time_fora).join(', ')}`);
      await dbSave(data, resultado);
      console.log('✅ Salvo no banco');

      // Gerar múltiplas com os jogos do dia
      console.log('\n🎯 Gerando múltiplas... aguardando 90s (rate limit)');
      await sleep(90000); // Aguardar rate limit resetar após lotes 1 e 2
      // Gerar múltiplas em background — não bloqueia a resposta
      setTimeout(async () => {
        try {
          console.log('\n🎯 Gerando múltiplas em background...');
          const multiplas = await gerarMultiplas(data, resultado.jogos);
          if (multiplas) {
            await dbSaveMultiplas(data, multiplas);
            console.log(`✅ Múltiplas salvas — A: ${multiplas.multipla_a?.odd_total} | B: ${multiplas.multipla_b?.odd_total}`);
          }
        } catch(e) { console.error('❌ Erro múltiplas:', e.message); }
      }, 30000); // 30s depois — sem web_search, tokens menores
    }
    res.json({ ...resultado, multiplas: resultado.multiplas });
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

// Validar hoje em tempo real — atualiza pendentes sem bloquear já validados
app.post('/validar-agora', async (req, res) => {
  const data = hojeStr();
  const forcar = req.query.forcar === 'true' || req.body?.forcar === true;
  const row = await dbGet(data);
  if (!row?.apostas?.jogos) {
    return res.json({ mensagem: 'Sem apostas para hoje ainda.', data });
  }

  res.json({ mensagem: `Atualizando resultados de ${data}...${forcar?' (forçado)':''}`, data });

  // Se forçar, limpar todos os resultados e revalidar do zero
  if (forcar) {
    console.log('🔄 Revalidação forçada — limpando todos os resultados');
    await dbSaveResultados(data, null);
  }

  agentValidar(data).catch(console.error);
});

// ─── Rotinas automáticas de validação ────────────────────────

// Rotina das 15h e 18h — valida jogos do dia que já terminaram
app.post('/validar-parcial', async (req, res) => {
  const data = hojeStr();
  const row = await dbGet(data);
  if (!row?.apostas?.jogos) {
    return res.json({ mensagem: 'Sem apostas para hoje.', data });
  }

  res.json({ mensagem: `Validação parcial de ${data} iniciada...`, data });

  // Sempre revalida — mantém confirmados e atualiza pendentes
  if (row.resultados) {
    const pendentes = row.resultados.apostas?.filter(r => r.resultado_aposta === 'pendente') || [];
    if (pendentes.length === 0) {
      console.log(`✅ Rotina parcial ${data}: todos já validados`);
      return;
    }
    console.log(`🔄 Rotina parcial ${data}: ${pendentes.length} pendentes para validar`);
  }

  // agentValidar já mantém confirmados e revalida apenas pendentes
  agentValidar(data).catch(console.error);
});

// Rotina das 3h — verifica ontem e hoje por pendentes
app.post('/validar-pendentes', async (req, res) => {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);
  res.json({ mensagem: 'Verificação de pendentes iniciada', hoje, ontem });

  // Verificar ontem
  const rowOntem = await dbGet(ontem);
  if (rowOntem?.apostas?.jogos) {
    const pendentesOntem = rowOntem.resultados?.apostas?.filter(r => r.resultado_aposta === 'pendente') || [];
    const semResultado = !rowOntem.resultados;
    if (semResultado || pendentesOntem.length > 0) {
      console.log(`🔄 Pendentes ontem (${ontem}): ${semResultado ? 'sem validação' : pendentesOntem.length + ' pendentes'}`);
      await agentValidar(ontem);
      await agentDiario(ontem);
    } else {
      console.log(`✅ Ontem (${ontem}): todos validados`);
    }
  }

  // Verificar hoje
  const rowHoje = await dbGet(hoje);
  if (rowHoje?.apostas?.jogos) {
    const pendentesHoje = rowHoje.resultados?.apostas?.filter(r => r.resultado_aposta === 'pendente') || [];
    const semResultado = !rowHoje.resultados;
    if (semResultado || pendentesHoje.length > 0) {
      console.log(`🔄 Pendentes hoje (${hoje}): ${semResultado ? 'sem validação' : pendentesHoje.length + ' pendentes'}`);
      await agentValidar(hoje);
    } else {
      console.log(`✅ Hoje (${hoje}): todos validados`);
    }
  }
});

// Corrigir resultado de uma aposta manualmente
app.post('/corrigir-resultado', async (req, res) => {
  const { data, jogo_id, resultado } = req.body;
  if (!data || !jogo_id || !['green','red','pendente'].includes(resultado)) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }
  const row = await dbGet(data);
  if (!row?.resultados?.apostas) return res.status(404).json({ error: 'Sem resultados para esta data' });

  const apostas = row.resultados.apostas.map(a => {
    if (a.jogo_id === jogo_id) {
      console.log(`✏️ Corrigindo ${a.time_casa} x ${a.time_fora}: ${a.resultado_aposta} → ${resultado}`);
      return { ...a, resultado_aposta: resultado, corrigido_manualmente: true };
    }
    return a;
  });

  await dbSaveResultados(data, { ...row.resultados, apostas });
  res.json({ ok: true, mensagem: `Resultado corrigido para ${resultado}` });
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

// Gerar múltiplas para data que já tem apostas salvas
app.post('/gerar-multiplas/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });

  const row = await dbGet(data);
  if (!row?.apostas?.jogos) return res.status(404).json({ error: 'Sem apostas para esta data.' });

  res.json({ mensagem: `Gerando múltiplas para ${data}...` });

  try {
    // Reconstruir lista de jogos com prioridade a partir das apostas salvas
    const jogosComPri = row.apostas.jogos.map(j => ({
      ...j,
      timeCasa: j.time_casa,
      timeFora: j.time_fora,
      pri: j.tipo_liga === 'a' ? 1 : j.tipo_liga === 'b' ? 2 : j.tipo_liga === 'copa' ? 3 : j.tipo_liga === 'it' ? 4 : j.tipo_liga === 'es' ? 4 : j.tipo_liga === 'eu' ? 5 : 6
    }));

    const multiplas = await gerarMultiplas(data, jogosComPri);
    if (multiplas) {
      await dbSaveMultiplas(data, multiplas);
      console.log(`✅ Múltiplas geradas para ${data} — A: ${multiplas.multipla_a?.odd_total} | B: ${multiplas.multipla_b?.odd_total}`);
    }
  } catch(e) { console.error('Erro gerar-multiplas:', e.message); }
});

// Endpoint para buscar múltiplas do dia
app.get('/multiplas/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });
  try {
    const row = await dbGetComMultiplas(data);
    if (!row) return res.json({ data, multiplas: null, resultados_multiplas: null });
    return res.json({
      data,
      multiplas: row.multiplas || null,
      resultados_multiplas: row.resultados_multiplas || null
    });
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
