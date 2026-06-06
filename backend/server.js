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

  const normalizar = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
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
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
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
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
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
  const n = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
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
  // Usar horário de Brasília (UTC-3)
  const d = new Date();
  const brasilia = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return `${brasilia.getUTCFullYear()}-${String(brasilia.getUTCMonth()+1).padStart(2,'0')}-${String(brasilia.getUTCDate()).padStart(2,'0')}`;
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

// ─── Banco de ligas conhecidas ───────────────────────────────
const cacheLigas = new Map(); // Cache em memória para evitar requisições repetidas

async function dbGetLiga(nomeLiga) {
  if (cacheLigas.has(nomeLiga)) return cacheLigas.get(nomeLiga);
  try {
    const nome = encodeURIComponent(nomeLiga);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ligas_conhecidas?nome=eq.${nome}&select=liga_id,pais`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (rows?.length > 0) {
      cacheLigas.set(nomeLiga, rows[0]);
      return rows[0];
    }
    return null;
  } catch(e) { return null; }
}

async function dbSaveLiga(nomeLiga, ligaId, pais) {
  if (!nomeLiga || !ligaId) return;
  cacheLigas.set(nomeLiga, { liga_id: ligaId, pais });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ligas_conhecidas`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ nome: nomeLiga, liga_id: ligaId, pais })
    });
  } catch(e) { console.error('Erro dbSaveLiga:', e.message); }
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
async function gerarApostas(data, horaMin, metaJogos, timesIgnorar = new Set()) {
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
        // Salvar liga no banco automaticamente
        dbSaveLiga(ligaMatch.nome, ligaId, pais).catch(()=>{});
        jogosMap.set(key, { liga: ligaMatch.nome, tipo: ligaMatch.tipo, pri: priFinal, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId: ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
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
        // Salvar liga complementar no banco automaticamente
        dbSaveLiga(`${ligaNome} (${pais})`, ligaId, pais).catch(()=>{});
        jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: tipoComp, pri: priComp, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId: ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
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

  // Filtrar times já selecionados (para complemento)
  if (timesIgnorar.size > 0) {
    const antes = jogos.length;
    jogos = jogos.filter(j =>
      !timesIgnorar.has(j.timeCasa?.toLowerCase()) &&
      !timesIgnorar.has(j.timeFora?.toLowerCase())
    );
    if (antes !== jogos.length) console.log(`🚫 ${antes - jogos.length} jogos filtrados (duplicatas)`);
    jogos = jogos.slice(0, metaJogos);
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
  const memoria = await buscarMemoria();
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

  function montarPrompt(listaJogos, blocoMem, df) {
    return `Você é um analista de apostas esportivas experiente. Para cada jogo, raciocine como um apostador profissional que busca a melhor relação entre confiança e risco.

DATA: ${df}
${blocoMem}
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

  const prompt1 = montarPrompt(montarListaJogos(lote1, 0), blocoMem, df);
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
    const prompt2 = montarPrompt(montarListaJogos(lote2, LOTE), blocoMem, df);
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
    metaMap.set(key, { tipo: jg.tipo, liga: jg.liga, pri: jg.pri, ligaId: jg.ligaId, teamCasaId: jg.teamCasaId, teamForaId: jg.teamForaId });
  }

  // Corrigir tipo_liga, liga e recuperar fixtureId dos jogos originais
  if (resultado.jogos) {
    resultado.jogos = resultado.jogos.map((j) => {
      const key = `${norm(j.time_casa)}|${norm(j.time_fora)}`;
      const fixtureId = fixtureMap.get(key) || null;
      const meta = metaMap.get(key) || {};
      if (!fixtureId) {
    console.log(`⚠️ Sem fixtureId: ${j.time_casa} x ${j.time_fora} | key buscada: ${key}`);
    // Tentar match parcial — primeira palavra de cada time
    const keyAlt = jogos.find(jg => {
      const nc = norm(jg.timeCasa), nf = norm(jg.timeFora);
      const jc = norm(j.time_casa), jf = norm(j.time_fora);
      return (nc?.split(' ')[0] === jc?.split(' ')[0]) && (nf?.split(' ')[0] === jf?.split(' ')[0]);
    });
    if (keyAlt) {
      console.log(`  → Match parcial encontrado: ${keyAlt.timeCasa} x ${keyAlt.timeFora} | fixtureId:${keyAlt.fixtureId} ligaId:${keyAlt.ligaId}`);
      fixtureId = keyAlt.fixtureId;
      meta.ligaId = keyAlt.ligaId;
    }
  }

      return {
        ...j,
        tipo_liga: meta.tipo || j.tipo_liga || 'eu',
        liga: meta.liga || j.liga || 'Internacional',
        pri: meta.pri || 20,
        fixtureId: fixtureId || j.fixtureId || null,
        ligaId: meta.ligaId || j.ligaId || null,
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

  const lista = jogosElegiveis.map((j,i) => {
    const casa = j.time_casa || j.timeCasa || '?';
    const fora = j.time_fora || j.timeFora || '?';
    return `${i+1}. ${j.liga} | ${casa} x ${fora} | ${j.horario} | pri:${j.pri}`;
  }).join('\n');

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

  // Normalização limpa sem regex corrompido
  const nm = s => {
    if (!s) return '';
    let r = s.toLowerCase();
    r = r.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return r.trim();
  };
  // Remove sufixos estaduais
  const ss = s => nm(s).replace(/-[a-z]{2}$/, '').trim();
  // Palavras com 5+ letras
  const pw = s => nm(s).split(' ').filter(p => p.length >= 5);
  // Verifica match entre dois times
  const match = (a, b) => {
    const na = nm(a), nb = nm(b);
    if (na === nb) return true;
    if (ss(na) === ss(nb)) return true;
    const pa = pw(a), pb = pw(b);
    if (pa.length && pb.length) {
      if (pa.every(p => nb.includes(p))) return true;
      if (pb.every(p => na.includes(p))) return true;
    }
    return false;
  };

  const resultadosJogos = [...multipla.jogos.map(j => {
    // Buscar por casa+fora OU fora+casa (ordem pode variar)
    const res = resultadosApostas.find(r =>
      match(r.time_casa, j.time_casa) && match(r.time_fora, j.time_fora)
    ) || resultadosApostas.find(r =>
      match(r.time_fora, j.time_casa) && match(r.time_casa, j.time_fora)
    );
    if (!res) {
      console.log(`  ⚠️ Não encontrado: "${j.time_casa}" x "${j.time_fora}"`);
      return 'nao_encontrado';
    }
    if (res.resultado_aposta === 'cancelado') return 'cancelado';
    if (res.resultado_aposta === 'pendente' || !res.placar) return 'pendente';
    const [gC, gF] = res.placar.split('-').map(Number);
    // Inferir mercado pela aposta quando não está definido
    const inferirMercado = (aposta) => {
      const a = aposta?.toLowerCase() || '';
      if (a.includes('over') || a.includes('under') ||
          a.includes('marca') || a.includes('ambas') || a.includes('ambos') ||
          a.includes('btts') || a.includes('menos de') || a.includes('mais de')) return 'gols';
      if (a.includes('escanteio') || a.includes('canto') || a.includes('corner')) return 'escanteios';
      if (a.includes('cartão') || a.includes('cartao') || a.includes('amarelo')) return 'cartoes';
      // dupla chance, vence, não perde, empate = mercado resultado
      return 'resultado';
    };
    // Normalizar mercado — dupla chance = resultado
    const normalizarMercado = m => {
      if (!m) return inferirMercado(j.aposta);
      const ml = m.toLowerCase();
      if (ml.includes('dupla') || ml.includes('chance') || ml.includes('resultado') || ml.includes('vence') || ml.includes('empate')) return 'resultado';
      if (ml.includes('gol') || ml.includes('over') || ml.includes('under') || ml.includes('marca')) return 'gols';
      if (ml.includes('escanteio') || ml.includes('canto')) return 'escanteios';
      if (ml.includes('cartao') || ml.includes('cartão')) return 'cartoes';
      return m;
    };
    const mercadoFinal = normalizarMercado(j.mercado);
    const jogoComMercado = {...j, mercado: mercadoFinal};
    const resultado = verificarAposta(jogoComMercado, gC, gF, null);
    console.log(`  📊 Múltipla: ${j.time_casa} x ${j.time_fora} | ${res.placar} | mercado:${j.mercado||'resultado'} | ${j.aposta} → ${resultado.toUpperCase()}`);
    return resultado;
  })];

  // Buscar via web search para jogos não encontrados
  // Web search individual para cada jogo não encontrado
  for (let idx = 0; idx < multipla.jogos.length; idx++) {
    if (resultadosJogos[idx] !== 'nao_encontrado') continue;
    const j = multipla.jogos[idx];
    try {
      console.log(`  🔍 Web search múltipla: ${j.time_casa} x ${j.time_fora}`);
      const txt = await chamarIAComBusca(
        `Placar final do jogo ${j.time_casa} x ${j.time_fora}. Responda apenas X-Y ou "cancelado".`,
        300
      );
      if (txt) {
        if (/cancelado|adiado|suspens/i.test(txt)) {
          resultadosJogos[idx] = 'cancelado';
        } else {
          const m = txt.match(/(\d+)\s*[-x]\s*(\d+)/);
          if (m) {
            const gC = parseInt(m[1]), gF = parseInt(m[2]);
            resultadosJogos[idx] = verificarAposta({...j}, gC, gF, null);
            console.log(`  ✅ Web search: ${j.time_casa} x ${j.time_fora} → ${gC}-${gF} → ${resultadosJogos[idx].toUpperCase()}`);
          }
        }
      }
    } catch(e) { console.log(`  ⚠️ Web search falhou: ${e.message}`); }
  }

  // Converter nao_encontrado restantes para pendente
  const resultadosFinais = resultadosJogos.map(r => r === 'nao_encontrado' ? 'pendente' : r);
  // Cancelados não contam — filtrar para o cálculo
  const paraCalculo = resultadosFinais.filter(r => r !== 'cancelado');
  const todosGreen = paraCalculo.length > 0 && paraCalculo.every(r => r === 'green');
  const algumRed = paraCalculo.some(r => r === 'red');
  const temPendente = paraCalculo.some(r => r === 'pendente');

  return {
    resultado: algumRed ? 'red' : todosGreen ? 'green' : temPendente ? 'pendente' : paraCalculo.length === 0 ? 'cancelado' : 'pendente',
    jogos_resultado: multipla.jogos.map((j, i) => ({
      ...j,
      resultado: resultadosFinais[i]
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
      const corners = stats.find(s => s.type === 'Corner Kicks')?.value;
      const yellowCards = stats.find(s => s.type === 'Yellow Cards')?.value;
      const redCards = stats.find(s => s.type === 'Red Cards')?.value;
      const goals = stats.find(s => s.type === 'Goals')?.value;
      // "null" string da API deve virar 0
      const parseVal = v => (v === null || v === 'null' || v === undefined) ? 0 : parseInt(v) || 0;

      // Cartão vermelho = 2 cartões (amarelo já computado antes do vermelho na maioria dos casos)
      const yellow = parseVal(yellowCards);
      const red = parseVal(redCards);
      const cartoesTime = yellow + (red * 2);
      if (teams.indexOf(team) === 0) {
        escanteiosCasa = parseVal(corners);
        cartoesCasa = cartoesTime;
        if (parseVal(goals) > 0) ambosM = true;
      } else {
        escanteiosFora = parseVal(corners);
        cartoesFora = cartoesTime;
        if (parseVal(goals) > 0) ambosM = true;
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
  // Inferir mercado pela aposta — evita erro quando mercado salvo está errado
  const inferirMercadoVerif = (m, a) => {
    const al = (a||'').toLowerCase();
    if (al.includes('marca') || al.includes('to score') || al.includes('anytime') ||
        al.includes('over') || al.includes('under') || al.includes('ambas') ||
        al.includes('ambos') || al.includes('btts') || al.includes('menos de') ||
        al.includes('mais de')) return 'gols';
    if (al.includes('escanteio') || al.includes('corner')) return 'escanteios';
    if (al.includes('cartao') || al.includes('cartao') || al.includes('amarelo')) return 'cartoes';
    return m || 'resultado';
  };
  const mercado = inferirMercadoVerif(jogo.mercado?.toLowerCase(), jogo.aposta);
  const casaVence = golsCasa > golsFora;
  const foraVence = golsFora > golsCasa;
  const empate = golsCasa === golsFora;

  // Helper: verificar over/under genérico
  const checkOverUnder = (valor, linha) => {
    const n = parseFloat(linha);
    // usar apostaNorm para evitar problemas de acentuação — declarada abaixo mas hoisted via let
    const ap = (typeof apostaNorm !== 'undefined' ? apostaNorm : aposta);
    if (ap.includes(`over ${linha}`) || ap.includes(`mais de ${linha}`)) return valor > n ? 'green' : 'red';
    if (ap.includes(`under ${linha}`) || ap.includes(`menos de ${linha}`)) return valor < n ? 'green' : 'red';
    return null;
  };

  // Helper: palavras do time (funciona com siglas curtas como CRB, ADT, CSA)
  const normStr = s => { if (!s) return ''; let r = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); return r.trim(); };
  const equiv = {
    'brazil':'brasil','brasil':'brazil','germany':'alemanha','alemanha':'germany',
    'france':'franca','franca':'france','spain':'espanha','espanha':'spain',
    'england':'inglaterra','inglaterra':'england','italy':'italia','italia':'italy',
  };
  const palavrasDoTime = (nome) => {
    const n = normStr(nome);
    const todas = n.split(' ').filter(p => p.length >= 2);
    const temLonga = todas.some(p => p.length > 3);
    const ps = temLonga ? todas.filter(p => p.length > 3) : todas;
    return [...new Set([...ps, ...ps.map(p => equiv[p]).filter(Boolean)])];
  };
  const apostaNorm = normStr(aposta);
  const palavrasCasa = palavrasDoTime(jogo.time_casa);
  const palavrasFora = palavrasDoTime(jogo.time_fora);

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
    if (apostaNorm.includes('marca') || apostaNorm.includes('to score') || apostaNorm.includes('anytime')) {
      // Mandante/visitante genérico
      if (apostaNorm.includes('visitante') || apostaNorm.includes('away team') || apostaNorm.includes('away to score')) return golsFora > 0 ? 'green' : 'red';
      if (apostaNorm.includes('mandante') || apostaNorm.includes('home team') || apostaNorm.includes('home to score')) return golsCasa > 0 ? 'green' : 'red';
      // Por nome do time
      if (palavrasCasa.some(p => apostaNorm.includes(p))) return golsCasa > 0 ? 'green' : 'red';
      if (palavrasFora.some(p => apostaNorm.includes(p))) return golsFora > 0 ? 'green' : 'red';
    }
  }

  // ── MERCADO ESCANTEIOS ────────────────────────────────────
  const isEscanteios = mercado === 'escanteios' ||
    apostaNorm.includes('escanteio') || apostaNorm.includes('corner') || apostaNorm.includes('canto');
  if (isEscanteios && stats) {
    const esc = stats.escanteiosTotal;
    console.log(`    🔍 Stats escanteios: total=${esc} casa=${stats.escanteiosCasa} fora=${stats.escanteiosFora}`);
    // Se stats zeradas, API não tem dados para essa liga — needs manual review
    if (esc === 0 && stats.escanteiosCasa === 0 && stats.escanteiosFora === 0) {
      console.log(`    ⚠️ Stats escanteios zeradas — liga sem cobertura de stats, correção manual necessária`);
      return 'sem_stats';
    }
    // Linhas completas — de 4.5 a 14.5
    for (const linha of ['4.5','5.5','6.5','7.5','8.5','9.5','10.5','11.5','12.5','13.5','14.5']) {
      const r = checkOverUnder(esc, linha);
      if (r) return r;
    }
    // Escanteios por time
    if (apostaNorm.includes('escanteios casa') || apostaNorm.includes('cantos casa') || apostaNorm.includes('corner home')) {
      for (const linha of ['2.5','3.5','4.5','5.5','6.5','7.5']) {
        const r = checkOverUnder(stats.escanteiosCasa, linha);
        if (r) return r;
      }
    }
    if (apostaNorm.includes('escanteios fora') || apostaNorm.includes('cantos fora') || apostaNorm.includes('corner away')) {
      for (const linha of ['2.5','3.5','4.5','5.5','6.5','7.5']) {
        const r = checkOverUnder(stats.escanteiosFora, linha);
        if (r) return r;
      }
    }
  }

  // ── MERCADO CARTÕES ───────────────────────────────────────
  const isCartoes = mercado === 'cartoes' ||
    apostaNorm.includes('cartao') || apostaNorm.includes('cartão') ||
    apostaNorm.includes('amarelo') || apostaNorm.includes('card') ||
    apostaNorm.includes('yellow');
  if (isCartoes && stats) {
    const cart = stats.cartoesTotal;
    // Se stats zeradas, API não tem dados para essa liga — needs manual review
    if (cart === 0 && stats.cartoesCasa === 0 && stats.cartoesFora === 0) {
      console.log(`    ⚠️ Stats cartões zeradas — liga sem cobertura de stats, correção manual necessária`);
      return 'sem_stats';
    }
    // Linhas completas — de 0.5 a 7.5
    for (const linha of ['0.5','1.5','2.5','3.5','4.5','5.5','6.5','7.5']) {
      const r = checkOverUnder(cart, linha);
      if (r) return r;
    }
    // Cartões por time — usar palavrasCasa/palavrasFora já calculadas e apostaNorm
    if (palavrasCasa.some(p => apostaNorm.includes(p))) {
      for (const linha of ['0.5','1.5','2.5','3.5']) {
        const r = checkOverUnder(stats.cartoesCasa, linha);
        if (r) return r;
      }
    }
    if (palavrasFora.some(p => apostaNorm.includes(p))) {
      for (const linha of ['0.5','1.5','2.5','3.5']) {
        const r = checkOverUnder(stats.cartoesFora, linha);
        if (r) return r;
      }
    }
  }

  // ── MERCADO RESULTADO ─────────────────────────────────────
  if (mercado === 'resultado') {
    const apostaMencCasa = palavrasCasa.some(p => apostaNorm.includes(p));
    const apostaMencFora = !apostaMencCasa && palavrasFora.some(p => apostaNorm.includes(p));

    if (aposta.includes('empate') && !aposta.includes('vence') && !aposta.includes('dupla')) return empate ? 'green' : 'red';
    if (aposta.includes('ou empat') || aposta.includes('vence ou empat') || aposta.includes('dupla chance') || aposta.includes('nao perde') || aposta.includes('não perde') || aposta.includes('x2') || aposta.includes('1x') || aposta.includes('12')) {
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

async function agentValidar(data, opcoes = {}) {
  const forcarWebSearch = opcoes.forcarWebSearch || false;
  console.log(`\n🔍 Validando ${data}`);
  const row = await dbGet(data);
  if (!row?.apostas?.jogos) { console.log('Sem apostas'); return; }

  // Se já validado, verificar se tem pendentes para revalidar
  if (row.resultados) {
    const pendentes = row.resultados.apostas?.filter(r =>
      r.resultado_aposta === 'pendente' || r.resultado_aposta === 'pendente_ws'
    ) || [];
    if (pendentes.length === 0 && !forcarWebSearch) {
      console.log('Já validado completamente — sem pendentes');
      // Mesmo sem pendentes, verificar se múltiplas precisam ser validadas
      const rowM = await dbGetComMultiplas(data);
      const resMultExistente = rowM?.resultados_multiplas;
      const multPendente = !resMultExistente ||
        resMultExistente?.multipla_a?.resultado === 'pendente' ||
        resMultExistente?.multipla_b?.resultado === 'pendente';
      if (rowM?.multiplas && multPendente) {
        console.log('🎯 Validando múltiplas pendentes...');
        const resA = await validarMultipla(rowM.multiplas.multipla_a, row.resultados.apostas || []);
        const resB = await validarMultipla(rowM.multiplas.multipla_b, row.resultados.apostas || []);
        if (resA || resB) {
          await dbSaveResultadosMultiplas(data, {
            validado_em: new Date().toISOString(),
            multipla_a: resA,
            multipla_b: resB
          });
          console.log(`✅ Múltiplas: A=${resA?.resultado||'?'} B=${resB?.resultado||'?'}`);
        }
      }
      return;
    }
    if (forcarWebSearch && pendentes.length === 0) {
      console.log(`🔄 forcarWebSearch=true — revalidando todos os jogos com web search`);
    } else {
      console.log(`Revalidando ${pendentes.length} apostas pendentes...`);
    }
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
    // cancelado pode ser revalidado — jogo suspenso pode retomar
    if (resExistente && resExistente.resultado_aposta !== 'pendente' && resExistente.resultado_aposta !== 'cancelado') {
      console.log(`  ✅ Mantendo: ${jogo.time_casa} x ${jogo.time_fora} → ${resExistente.resultado_aposta.toUpperCase()}`);
      resultados.push(resExistente);
      continue;
    }

    console.log(`  Verificando: ${jogo.time_casa} x ${jogo.time_fora} | fixtureId:${jogo.fixtureId||'?'} ligaId:${jogo.ligaId||'?'}`);
    let placar = null, golsCasa = null, golsFora = null, fixtureIdUsado = jogo.fixtureId || null;

    try {
      let jogoEncontradoNaAPI = false; // Declarar no escopo externo

      // Tentar pelo fixtureId salvo
      if (jogo.fixtureId) {
        const res = await buscarResultadoFixture(jogo.fixtureId);
        if (res) {
          placar = res.placar; golsCasa = res.golsCasa; golsFora = res.golsFora;
        } else {
          // fixtureId existe mas jogo não terminou — API encontrou o jogo
          jogoEncontradoNaAPI = true;
          // Verificar se foi adiado/suspenso
          try {
            const resRaw = await fetch(`https://v3.football.api-sports.io/fixtures?id=${jogo.fixtureId}`,
              { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
            const rawJson = await resRaw.json();
            const f = rawJson.response?.[0];
            const statusShort = f?.fixture?.status?.short;
            const statusLong = f?.fixture?.status?.long || '';
            if (['PST','CANC','ABD','AWD','WO','SUSP','INT'].includes(statusShort)) {
              console.log(`    ⚠️ Jogo adiado/cancelado: ${statusShort} — ${statusLong}`);
              resultados.push({ encontrado: false, placar: null, resultado_aposta: 'cancelado', motivo: `Jogo ${statusShort}: ${statusLong}`, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
              continue;
            }
          } catch(e) {}
        }
        await sleep(300);
      }

      // Fallback: buscar pelo nome dos times
      if (golsCasa === null) {
        // Recarregar fixtures a cada 30 min para pegar jogos que terminaram
        const agora = Date.now();
        if (!cacheFixtures || !cacheFixtures._ts || (agora - cacheFixtures._ts) > 30 * 60 * 1000) {
          if (!contarRequisicao()) { resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: 'limite API', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora }); continue; }
          const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`, { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
          const json = await res.json();
          cacheFixtures = json.response || [];
          cacheFixtures._ts = agora; // Timestamp para controle de recarregamento
          console.log(`📊 Fixtures carregados: ${cacheFixtures.length} jogos | Req: ${reqHoje}/${LIMITE_SEGURO}`);
          await sleep(300);
        }

        const normalizar = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
        const nCasa = normalizar(jogo.time_casa), nFora = normalizar(jogo.time_fora);
        // 1. Resolver ligaId — do jogo ou do banco de ligas conhecidas
        let ligaIdResolvido = jogo.ligaId;
        if (!ligaIdResolvido && jogo.liga) {
          const ligaConhecida = await dbGetLiga(jogo.liga);
          if (ligaConhecida?.liga_id) {
            ligaIdResolvido = ligaConhecida.liga_id;
            console.log(`    🗂️ Liga resolvida do banco: ${jogo.liga} → ID ${ligaIdResolvido}`);
          }
        }

        const matchTime = (f, nc, nf) => {
          const hN = normalizar(f.teams?.home?.name), aN = normalizar(f.teams?.away?.name);
          const casaMatch = hN?.includes(nc?.split(' ')[0]) || nc?.includes(hN?.split(' ')[0]);
          const foraMatch = aN?.includes(nf?.split(' ')[0]) || nf?.includes(aN?.split(' ')[0]);
          return casaMatch && foraMatch;
        };

        // 2. Tentar pelo ligaId — busca em todos os status (inclusive em andamento)
        let fixture = null;
        if (ligaIdResolvido) {
          const fixturasLiga = cacheFixtures.filter(f => f.league?.id === ligaIdResolvido);
          // Primeiro tenta FT
          fixture = fixturasLiga.find(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short) && matchTime(f, nCasa, nFora));
          // Se não encontrou FT, verifica se está em andamento
          if (!fixture) {
            const emAndamento = fixturasLiga.find(f => matchTime(f, nCasa, nFora));
            if (emAndamento) {
              jogoEncontradoNaAPI = true;
              console.log(`    ⏳ Jogo em andamento/não iniciado via ligaId: ${emAndamento.teams?.home?.name} x ${emAndamento.teams?.away?.name} | ${emAndamento.fixture?.status?.short}`);
            }
          } else {
            console.log(`    📊 Match via ligaId ${ligaIdResolvido}: ${fixture.teams?.home?.name} x ${fixture.teams?.away?.name} | ${fixture.fixture?.status?.short}`);
          }
        }

        // 3. Pool geral — excluindo sub-categorias
        if (!fixture && !jogoEncontradoNaAPI) {
          // Primeiro tenta FT
          fixture = cacheFixtures.find(f => {
            if (!['FT','AET','PEN'].includes(f.fixture?.status?.short)) return false;
            if (LIGAS_IGNORAR.has(f.league?.id)) return false;
            const nomeH = f.teams?.home?.name?.toLowerCase() || '';
            const nomeA = f.teams?.away?.name?.toLowerCase() || '';
            if (nomeH.match(/u\d{2}|sub-?\d{2}|junior|juvenil/) || nomeA.match(/u\d{2}|sub-?\d{2}|junior|juvenil/)) return false;
            if (matchTime(f, nCasa, nFora)) {
              console.log(`    📊 Match pool geral: ${f.teams?.home?.name} x ${f.teams?.away?.name} | liga:${f.league?.id} | ${f.fixture?.status?.short}`);
              return true;
            }
            return false;
          });
          // Se não encontrou FT, verifica em andamento
          if (!fixture) {
            const emAndamento = cacheFixtures.find(f => {
              if (LIGAS_IGNORAR.has(f.league?.id)) return false;
              const nomeH = f.teams?.home?.name?.toLowerCase() || '';
              const nomeA = f.teams?.away?.name?.toLowerCase() || '';
              if (nomeH.match(/u\d{2}|sub-?\d{2}|junior|juvenil/) || nomeA.match(/u\d{2}|sub-?\d{2}|junior|juvenil/)) return false;
              return matchTime(f, nCasa, nFora);
            });
            if (emAndamento) {
              jogoEncontradoNaAPI = true;
              console.log(`    ⏳ Jogo em andamento/não iniciado pool geral: ${emAndamento.teams?.home?.name} x ${emAndamento.teams?.away?.name} | ${emAndamento.fixture?.status?.short}`);
            }
          }
        }

        if (fixture) {
          golsCasa = fixture.goals?.home;
          golsFora = fixture.goals?.away;
          placar = `${golsCasa}-${golsFora}`;
          fixtureIdUsado = fixture.fixture?.id || fixtureIdUsado;
          console.log(`    ✅ Placar encontrado: ${placar}`);
        }
      }

      // Web search: só se não encontrou na API E jogo deveria ter terminado
      // Se a API encontrou o jogo (mesmo em andamento), não usa web search
      if (golsCasa === null) {
        const horario = jogo.horario || '00:00';
        const [hh, mm] = horario.split(':').map(Number);
        const minutos = hh * 60 + (mm || 0);
        const horaAtual = new Date(new Date().getTime() - 3*60*60*1000).getUTCHours();
        const ehRotina03h = horaAtual >= 2 && horaAtual <= 4;
        const limiteMinutos = horaAtual <= 1 ? 21 * 60 + 30 : 23 * 60 + 59;

        // Web search na rotina 03h OU quando forçado
        if ((ehRotina03h || forcarWebSearch) && !jogoEncontradoNaAPI && minutos <= limiteMinutos) {
          resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente_ws', motivo: 'aguardando web search em lote', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta, mercado: jogo.mercado });
          continue;
        }
      }


      if (golsCasa !== null && golsFora !== null) {
        // Inferir mercado pela aposta antes de buscar stats
        const inferirMercadoPre = (m, a) => {
          const al = (a||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
          if (al.includes('escanteio') || al.includes('corner') || al.includes('canto')) return 'escanteios';
          if (al.includes('cartao') || al.includes('amarelo') || al.includes('card') || al.includes('yellow')) return 'cartoes';
          return m || '';
        };
        const mercadoEfetivo = inferirMercadoPre(jogo.mercado?.toLowerCase(), jogo.aposta);

        // Buscar stats detalhadas se precisar (cartões/escanteios)
        let stats = null;
        if (['escanteios','cartoes'].includes(mercadoEfetivo) && fixtureIdUsado) {
          console.log(`    📊 Buscando stats para mercado: ${mercadoEfetivo}`);
          stats = await buscarStatsFixture(fixtureIdUsado);
          if (!stats) console.log(`    ⚠️ Stats não encontradas para fixtureId: ${fixtureIdUsado}`);
          await sleep(300);
        }
        const resultado = verificarAposta(jogo, golsCasa, golsFora, stats);
        console.log(`    ✅ ${placar} | mercado:"${jogo.mercado}" | aposta:"${jogo.aposta}" | casa:"${jogo.time_casa}" | fora:"${jogo.time_fora}" → ${resultado.toUpperCase()}`);

        // Se verificarAposta retornou pendente (ex: stats zeradas), mandar para web search na rotina 03h
        if (resultado === 'sem_stats') {
          // Stats zeradas — marcar pendente_ws com placar para web search buscar escanteios/cartões
          console.log(`    ⚠️ Stats zeradas — pendente_ws para web search buscar escanteios/cartões`);
          resultados.push({ encontrado: true, placar, placar_conhecido: placar, resultado_aposta: 'pendente_ws', motivo: 'stats zeradas — web search buscará escanteios/cartões', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta, mercado: jogo.mercado });
        } else {
          resultados.push({ encontrado: true, placar, resultado_aposta: resultado, motivo: `${jogo.time_casa} ${golsCasa} x ${golsFora} ${jogo.time_fora}`, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
        }
      } else {
        console.log(`    ⏳ Resultado não encontrado`);
        resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: 'resultado não encontrado', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
      }
    } catch(err) {
      console.log(`    ❌ Erro: ${err.message}`);
      resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: err.message, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
    }
  }

  // Web search em lote para todos os pendentes_ws de uma vez
  const pendentesWS = resultados.filter(r => r.resultado_aposta === 'pendente_ws');
  console.log(`
📋 Resumo: ${resultados.filter(r=>r.resultado_aposta==='green').length}G ${resultados.filter(r=>r.resultado_aposta==='red').length}R ${resultados.filter(r=>r.resultado_aposta==='pendente').length}P ${pendentesWS.length}WS`);
  if (pendentesWS.length > 0) {
    try {
      // Separar normais de stats (escanteios/cartões)
      const pendentesStats = pendentesWS.filter(r =>
        ['escanteios','cartoes'].includes((r.mercado||'').toLowerCase()) ||
        (r.aposta||'').toLowerCase().includes('escanteio') ||
        (r.aposta||'').toLowerCase().includes('corner') ||
        (r.aposta||'').toLowerCase().includes('cartao'));
      const lista = pendentesWS.map(r => {
        const isStats = pendentesStats.includes(r);
        return isStats ? `${r.time_casa} x ${r.time_fora} (incluir total escanteios e total cartoes)` : `${r.time_casa} x ${r.time_fora}`;
      }).join(', ');
      console.log(`\n🔍 Web search em lote: ${pendentesWS.length} jogos (${pendentesStats.length} precisam de stats)`);
      const txt = await chamarIAComBusca(
        `Busque o resultado final dos seguintes jogos de futebol do dia ${data}. Para cada jogo responda: placar no formato 'Time1 N-M Time2'. Se pedido, inclua tambem 'escanteios: X' e 'cartoes: Y' (total do jogo). Se cancelado escreva 'cancelado'. Se nao encontrou nao inclua.\n\nJogos:\n${lista}`,
        800
      );
      if (txt) {
        for (const pend of pendentesWS) {
          const nc = pend.time_casa.split(' ')[0].toLowerCase();
          const nf = pend.time_fora.split(' ')[0].toLowerCase();
          // Verificar cancelado/adiado
          const linhaJogo = txt.toLowerCase().split('\n').find(l => l.includes(nc) && l.includes(nf));
          // Só marcar cancelado se explicitamente informado — "ainda não ocorreu" = pendente
          if (linhaJogo && (linhaJogo.includes('cancelado') || linhaJogo.includes('adiado') || linhaJogo.includes('suspens')) &&
              !linhaJogo.includes('ainda') && !linhaJogo.includes('not yet') && !linhaJogo.includes('nao ocorreu')) {
            pend.resultado_aposta = 'cancelado';
            pend.motivo = 'Jogo cancelado/adiado (web search)';
            console.log(`    ⚠️ Cancelado: ${pend.time_casa} x ${pend.time_fora}`);
            continue;
          }
          // Se já tem placar conhecido (stats zeradas), usar direto
          let gC, gF;
          if (pend.placar_conhecido) {
            const partes = pend.placar_conhecido.split('-');
            gC = parseInt(partes[0]); gF = parseInt(partes[1]);
            console.log(`    📋 Placar já conhecido: ${pend.placar_conhecido} — buscando stats no web search`);
            console.log(`    📄 Texto web search: ${txt.substring(0, 300)}`);
          } else {
            const m = txt.match(new RegExp(nc + '[^\n]*?([0-9]{1,2})[-x]([0-9]{1,2})', 'i'))
                    || txt.match(new RegExp('([0-9]{1,2})[-x]([0-9]{1,2})[^\n]*' + nf, 'i'));
            if (m) { gC = parseInt(m[1]); gF = parseInt(m[2]); }
          }
          if (gC !== undefined && gF !== undefined) {
            const jogoOriginal = jogos.find(j => j.time_casa === pend.time_casa && j.time_fora === pend.time_fora);
            if (jogoOriginal) {
              let statsWS = null;
              const escMatch = txt.match(/escanteios?[: ]+(\d+)/i);
              const cartMatch = txt.match(/cart[oe][es]?[: ]+(\d+)/i);
              if (escMatch || cartMatch) {
                const esc = escMatch ? parseInt(escMatch[1]) : 0;
                const cart = cartMatch ? parseInt(cartMatch[1]) : 0;
                statsWS = { escanteiosTotal: esc, escanteiosCasa: 0, escanteiosFora: 0, cartoesTotal: cart, cartoesCasa: 0, cartoesFora: 0 };
                console.log(`    📊 Stats via web search: escanteios=${esc} cartões=${cart}`);
              }
              const res = verificarAposta(jogoOriginal, gC, gF, statsWS);
              pend.placar = `${gC}-${gF}`;
              // Se ainda pendente após web search (stats não encontradas), marcar cancelado/reembolso
              if (res === 'pendente' || res === 'sem_stats') {
                if (!statsWS) {
                  console.log(`    ↩️ Stats não encontradas no web search — marcando reembolso`);
                  pend.resultado_aposta = 'cancelado';
                  pend.motivo = 'Stats de escanteios/cartões indisponíveis — reembolso automático';
                } else {
                  pend.resultado_aposta = 'pendente';
                }
              } else {
                pend.resultado_aposta = res;
              }
              pend.motivo = `${pend.time_casa} ${gC} x ${gF} ${pend.time_fora} (web search)`;
              pend.encontrado = true;
              console.log(`    ✅ ${pend.time_casa} x ${pend.time_fora} → ${gC}-${gF} → ${res.toUpperCase()}`);
            }
          } else {
            pend.resultado_aposta = 'pendente';
            pend.motivo = 'resultado não encontrado';
          }
        }
      } else {
        pendentesWS.forEach(p => { p.resultado_aposta = 'pendente'; p.motivo = 'web search sem resposta'; });
      }
    } catch(e) {
      console.log(`⚠️ Web search em lote falhou: ${e.message}`);
      pendentesWS.forEach(p => { p.resultado_aposta = 'pendente'; p.motivo = 'web search falhou'; });
    }
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
  const p = resultados.filter(r=>r.resultado_aposta==='pendente').length;
  const c = resultados.filter(r=>r.resultado_aposta==='cancelado').length;
  const total = g + r; // cancelados não entram no cálculo
  const assert = total > 0 ? ((g/total)*100).toFixed(2) : 0;

  // Só incluir jogos validados no relatório — pendentes não têm resultado para analisar
  const resultadosValidados = resultados.filter(r => ['green','red','cancelado'].includes(r.resultado_aposta));

  // Calcular mercados alternativos para TODOS os jogos (não só RED)
  // Isso gera padrões por liga
  const padroesPorLiga = {};
  const detalhes = resultadosValidados.map(r => {
    const a = apostas.find(x=>x.id===r.jogo_id);
    let linha = `- ${r.time_casa} x ${r.time_fora} [${a?.liga||'?'}]: ${a?.aposta||r.aposta} → ${r.resultado_aposta?.toUpperCase()} (${r.placar||'-'})`;

    if (r.placar) {
      const alts = calcularAlternativas(a || r, r.placar, null);
      const apostaFeita = (a?.aposta || r.aposta || '').toLowerCase();
      const altsFiltradas = alts.filter(alt => !apostaFeita.includes(alt.split(' ')[0].toLowerCase()));

      // Acumular padrões por liga
      const liga = a?.liga || 'Outras';
      if (!padroesPorLiga[liga]) padroesPorLiga[liga] = { mercados: {}, total: 0 };
      padroesPorLiga[liga].total++;
      alts.forEach(alt => {
        const mercado = alt.split(' ').slice(0,3).join(' ');
        padroesPorLiga[liga].mercados[mercado] = (padroesPorLiga[liga].mercados[mercado] || 0) + 1;
      });

      if (r.resultado_aposta === 'red' && altsFiltradas.length > 0) {
        linha += `\n  💡 Teria dado GREEN: ${altsFiltradas.slice(0,3).join(' | ')}`;
      }
    }
    return linha;
  }).join('\n');

  // Padrões identificados por liga (mercados que mais dariam green)
  const padroesTexto = Object.entries(padroesPorLiga)
    .filter(([,v]) => v.total >= 1)
    .map(([liga, v]) => {
      const top = Object.entries(v.mercados)
        .sort((a,b) => b[1]-a[1])
        .slice(0,3)
        .map(([m,n]) => `${m} (${n}/${v.total} jogos)`);
      return `  ${liga}: ${top.join(' | ')}`;
    }).join('\n');

  // Identificar jogos com confiança baixa (potenciais red flags)
  const baixaConfianca = apostas.filter(a => a.confianca === 'baixa').map(a => `${a.time_casa} x ${a.time_fora}`);

  const promptDiario = `Analise as apostas do dia ${data}. Assertividade: ${assert}% (${g} green, ${r} red${p>0?`, ${p} ainda pendentes`:''}). Analise apenas os jogos já validados.

RESULTADOS (com mercados alternativos que teriam dado GREEN):
${detalhes}

${padroesTexto ? `PADRÕES IDENTIFICADOS POR LIGA (mercados que mais dariam GREEN hoje):\n${padroesTexto}` : ''}

${baixaConfianca.length > 0 ? `JOGOS COM BAIXA CONFIANÇA: ${baixaConfianca.join(', ')}` : ''}

INSTRUÇÕES:
1. Para cada liga com jogos RED, identifique qual mercado teria sido mais seguro
2. Destaque padrões recorrentes: ex. "Liga X tem historicamente Under 2.5 em 3/3 jogos hoje"
3. Para apostas de confiança baixa, sugira o mercado alternativo mais seguro baseado nos padrões
4. Identifique red flags: ligas ou tipos de jogo onde é melhor pivotar para mercados alternativos
5. Seja específico com números — ex. "Over 2.5 gols daria GREEN em 5 dos 7 jogos hoje"
Máx 500 palavras.`;

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

  const relatorio = await chamarIA(`${promptDiario}${blocoMultiplas}\n\nSe as múltiplas deram RED, identifique qual jogo quebrou e sugira alternativa de mercado para próximas múltiplas.`, 3000);
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
  await agentValidar(ontem, { forcarWebSearch: true });
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

// ─── Rotinas automáticas 04h e 05h ──────────────────────────

async function rotina04h() {
  const hoje = hojeStr();
  const amanha = diaOffset(hoje, 1);
  console.log(`\n⏰ Rotina 04h — verificando ${hoje} e ${amanha}`);

  for (const diaAlvo of [hoje, amanha]) {
    const row = await dbGet(diaAlvo);
    const jogosExistentes = row?.apostas?.jogos || [];
    const total = jogosExistentes.length;

    if (total >= 15) {
      console.log(`✅ ${diaAlvo}: já tem ${total} jogos — pulando`);
      continue;
    }

    const faltam = 15 - total;
    console.log(`🔄 ${diaAlvo}: tem ${total} jogos, faltam ${faltam}`);

    // Times já selecionados — não repetir
    const timesJaSelecionados = new Set(
      jogosExistentes.flatMap(j => [
        j.time_casa?.toLowerCase(), j.time_fora?.toLowerCase()
      ]).filter(Boolean)
    );

    console.log(`🚫 Times já selecionados: ${[...timesJaSelecionados].join(', ')}`);

    // Gerar apostas passando os times já selecionados para evitar duplicatas
    const resultado = await gerarApostas(diaAlvo, '13:00', faltam, timesJaSelecionados);
    if (!resultado?.jogos?.length) {
      console.log(`⚠️ ${diaAlvo}: não foi possível gerar novos jogos`);
      continue;
    }

    if (total === 0) {
      // Primeiro preenchimento — salvar normalmente
      await dbSave(diaAlvo, resultado);
      console.log(`✅ ${diaAlvo}: ${resultado.jogos.length} jogos salvos`);
    } else {
      // Complemento — mesclar com jogos existentes
      const jogosCompletos = {
        jogos: [...jogosExistentes, ...resultado.jogos.map((j, i) => ({
          ...j,
          id: total + i + 1 // Continuar a numeração
        }))]
      };
      await dbSave(diaAlvo, jogosCompletos);
      console.log(`✅ ${diaAlvo}: complementado para ${jogosCompletos.jogos.length} jogos`);
    }

    // Gerar múltiplas em background
    setTimeout(async () => {
      try {
        const rowAtual = await dbGet(diaAlvo);
        const multiplas = await gerarMultiplas(diaAlvo, rowAtual?.apostas?.jogos || []);
        if (multiplas) {
          await dbSaveMultiplas(diaAlvo, multiplas);
          console.log(`✅ ${diaAlvo}: múltiplas geradas — A:${multiplas.multipla_a?.odd_total} B:${multiplas.multipla_b?.odd_total}`);
        }
      } catch(e) { console.error(`❌ ${diaAlvo}: erro ao gerar múltiplas:`, e.message); }
    }, 90000);
  }
}

async function rotina05h() {
  const hoje = hojeStr();
  const amanha = diaOffset(hoje, 1);
  console.log(`\n⏰ Rotina 05h — verificando integridade de ${hoje} e ${amanha}`);

  for (const diaAlvo of [hoje, amanha]) {
    const row = await dbGetComMultiplas(diaAlvo);
    const jogos = row?.apostas?.jogos || [];
    const multiplas = row?.multiplas;

    // 1. Verificar jogos
    if (jogos.length < 15) {
      console.log(`⚠️ ${diaAlvo}: apenas ${jogos.length}/15 jogos — acionando complemento`);
      const timesJaSelecionados = new Set(
        jogos.flatMap(j => [j.time_casa?.toLowerCase(), j.time_fora?.toLowerCase()]).filter(Boolean)
      );
      const faltam = 15 - jogos.length;
      const resultado = await gerarApostas(diaAlvo, '13:00', faltam, timesJaSelecionados);
      if (resultado?.jogos?.length) {
        const jogosCompletos = {
          jogos: [...jogos, ...resultado.jogos.map((j, i) => ({...j, id: jogos.length + i + 1}))]
        };
        await dbSave(diaAlvo, jogosCompletos);
        console.log(`✅ ${diaAlvo}: complementado para ${jogosCompletos.jogos.length} jogos`);
      }
    } else {
      console.log(`✅ ${diaAlvo}: ${jogos.length} jogos OK`);
    }

    // 2. Verificar múltiplas
    if (!multiplas?.multipla_a || !multiplas?.multipla_b) {
      console.log(`⚠️ ${diaAlvo}: múltiplas ausentes — gerando`);
      const rowAtual = await dbGet(diaAlvo);
      const novasMultiplas = await gerarMultiplas(diaAlvo, rowAtual?.apostas?.jogos || []);
      if (novasMultiplas) {
        await dbSaveMultiplas(diaAlvo, novasMultiplas);
        console.log(`✅ ${diaAlvo}: múltiplas OK — A:${novasMultiplas.multipla_a?.odd_total} B:${novasMultiplas.multipla_b?.odd_total}`);
      }
    } else {
      console.log(`✅ ${diaAlvo}: múltiplas OK — A:${multiplas.multipla_a?.odd_total} B:${multiplas.multipla_b?.odd_total}`);
    }

    // 3. Verificar e corrigir fixtureId e ligaId ausentes
    const semFixtureId = jogos.filter(j => !j.fixtureId);
    const semLigaId = jogos.filter(j => !j.ligaId);

    if (semFixtureId.length > 0) {
      console.log(`⚠️ ${diaAlvo}: ${semFixtureId.length} jogos sem fixtureId — buscando na API...`);
      // Buscar fixtures do dia para recuperar IDs
      const fixtures = await buscarFixturesPorData(diaAlvo);
      const norm = s => s?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim() || '';
      let corrigidos = 0;
      const jogosAtualizados = jogos.map(j => {
        if (j.fixtureId) return j;
        // Buscar fixture pelo nome dos times
        const f = fixtures.find(fx => {
          const hN = norm(fx.teams?.home?.name), aN = norm(fx.teams?.away?.name);
          const nc = norm(j.time_casa), nf = norm(j.time_fora);
          return (hN.includes(nc.split(' ')[0]) || nc.includes(hN.split(' ')[0])) &&
                 (aN.includes(nf.split(' ')[0]) || nf.includes(aN.split(' ')[0]));
        });
        if (f) {
          corrigidos++;
          return { ...j, fixtureId: f.fixture?.id, ligaId: f.league?.id || j.ligaId };
        }
        return j;
      });
      if (corrigidos > 0) {
        await dbSave(diaAlvo, { jogos: jogosAtualizados });
        // Salvar ligas novas no banco
        for (const j of jogosAtualizados.filter(j => j.ligaId && j.liga)) {
          await dbSaveLiga(j.liga, j.ligaId, '').catch(()=>{});
        }
        console.log(`✅ ${diaAlvo}: ${corrigidos} fixtureIds corrigidos`);
      }
    } else {
      console.log(`✅ ${diaAlvo}: todos os jogos com fixtureId`);
    }

    if (semLigaId.length > 0) {
      console.log(`⚠️ ${diaAlvo}: ${semLigaId.length} jogos sem ligaId`);
    }
  }

  console.log('✅ Rotina 05h concluída');
}

// ─── Endpoints ───────────────────────────────────────────────
// ─── OddLab público ──────────────────────────────────────────
app.post('/oddlab/registrar', async (req, res) => {
  const { nome, device_id } = req.body;
  if (!nome || !device_id) return res.status(400).json({ error: 'Nome e device_id obrigatórios' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/oddlab_usuarios`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ device_id, nome, acessos: 1, primeiro_acesso: new Date().toISOString(), ultimo_acesso: new Date().toISOString() })
    });
    res.json({ ok: true, nome });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/oddlab/usuario/:device_id', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/oddlab_usuarios?device_id=eq.${req.params.device_id}&select=nome,acessos,primeiro_acesso,ultimo_acesso`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const rows = await r.json();
    if (rows?.length > 0) {
      // Atualizar último acesso e contador
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/oddlab_usuarios?device_id=eq.${req.params.device_id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ ultimo_acesso: new Date().toISOString(), acessos: rows[0].acessos + 1 })
      });
      if (!patch.ok) console.error(`❌ OddLab PATCH erro: ${patch.status}`);
      res.json({ ok: true, ...rows[0] });
    } else {
      res.json({ ok: false });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

async function rotinaMultiplas() {
  const hoje = hojeStr();
  const amanha = diaOffset(hoje, 1);
  console.log(`\n⏰ Rotina 05h (múltiplas) — verificando ${hoje} e ${amanha}`);

  for (const diaAlvo of [hoje, amanha]) {
    const row = await dbGetComMultiplas(diaAlvo);
    const jogos = row?.apostas?.jogos || [];

    if (!jogos.length) {
      console.log(`⚠️ ${diaAlvo}: sem jogos — pulando múltiplas`);
      continue;
    }

    const multiplas = row?.multiplas;
    const mA = multiplas?.multipla_a, mB = multiplas?.multipla_b;
    // Verificar se odds são válidas E se os jogos são reais (não indefinidos/nulos)
    const jogoValido = j => j?.time_casa && j?.time_fora && j?.aposta && j?.odd > 0 &&
      j.time_casa !== 'undefined' && j.time_fora !== 'undefined';
    const mAValida = mA?.odd_total > 0 && mA?.jogos?.length > 0 && mA.jogos.every(jogoValido);
    const mBValida = mB?.odd_total > 0 && mB?.jogos?.length > 0 && mB.jogos.every(jogoValido);
    const validas = mAValida && mBValida;

    if (validas) {
      console.log(`✅ ${diaAlvo}: múltiplas OK — A:${mA.odd_total} B:${mB.odd_total}`);
      continue;
    }

    // Log detalhado do problema
    if (!mAValida) console.log(`⚠️ ${diaAlvo}: Múltipla A inválida — odd:${mA?.odd_total||0} jogos:${mA?.jogos?.length||0}`);
    if (!mBValida) console.log(`⚠️ ${diaAlvo}: Múltipla B inválida — odd:${mB?.odd_total||0} jogos:${mB?.jogos?.length||0}`);

    console.log(`🔄 ${diaAlvo}: ${!multiplas ? 'sem múltiplas' : 'múltiplas inválidas'} — gerando...`);
    try {
      const novasMultiplas = await gerarMultiplas(diaAlvo, jogos);
      if (novasMultiplas?.multipla_a?.odd_total > 0) {
        await dbSaveMultiplas(diaAlvo, novasMultiplas);
        console.log(`✅ ${diaAlvo}: múltiplas geradas — A:${novasMultiplas.multipla_a.odd_total} B:${novasMultiplas.multipla_b?.odd_total}`);
      } else {
        console.log(`⚠️ ${diaAlvo}: não foi possível gerar múltiplas válidas`);
      }
    } catch(e) {
      console.error(`❌ ${diaAlvo}: erro ao gerar múltiplas:`, e.message);
    }
  }

  console.log('✅ Rotina de múltiplas concluída');
}

app.post('/rotina-04h', async (req, res) => {
  res.json({ mensagem: 'Rotina 04h iniciada' });
  rotina04h().catch(console.error);
});

app.post('/rotina-04h30', async (req, res) => {
  res.json({ mensagem: 'Rotina 04h30 iniciada' });
  rotina05h().catch(console.error);
});

app.post('/rotina-05h', async (req, res) => {
  res.json({ mensagem: 'Rotina 05h (múltiplas) iniciada' });
  rotinaMultiplas().catch(console.error);
});

app.post('/rotina-noturna', async (req, res) => {
  res.json({ mensagem: 'Rotina iniciada' });
  rotinaNoturna().catch(console.error);
});

app.post('/validar/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });
  const forcar = req.query.forcar === 'true' || req.body?.forcar === true;
  res.json({ mensagem: `Validação de ${data} iniciada${forcar?' (forçado)':''}` });
  if (forcar) {
    console.log(`🔄 Validação forçada de ${data} — limpando resultados`);
    await dbSaveResultados(data, null).catch(()=>{});
  }
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
    } else {
      console.log(`🔄 Rotina parcial ${data}: ${pendentes.length} pendentes para validar`);
    }
  }

  // agentValidar já mantém confirmados e revalida apenas pendentes
  // Após validar apostas simples, valida múltiplas também
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
      await agentValidar(ontem, { forcarWebSearch: true });
      // Atualizar relatório após validação
      await agentDiario(ontem);
      console.log(`✅ Relatório de ${ontem} atualizado`);
    } else {
      // Mesmo todos validados, garantir que relatório existe e está atualizado
      const calOntem = await dbGetCalibracaoPorPeriodo('diario', ontem).catch(()=>null);
      if (!calOntem) {
        console.log(`📝 Relatório de ${ontem} ausente — gerando...`);
        await agentDiario(ontem);
        console.log(`✅ Relatório de ${ontem} gerado`);
      } else {
        console.log(`✅ Ontem (${ontem}): todos validados e relatório OK`);
      }
    }
  }

  // Não valida hoje — jogos ainda não começaram às 03h
  console.log(`ℹ️  Hoje (${hoje}): jogos ainda não iniciados — sem validação`);
});

// Corrigir resultado de uma aposta manualmente
app.post('/corrigir-resultado', async (req, res) => {
  const { data, jogo_id, placar } = req.body;
  if (!data || !jogo_id) return res.status(400).json({ error: 'Parâmetros inválidos' });

  const row = await dbGet(data);
  if (!row?.resultados?.apostas) return res.status(404).json({ error: 'Sem resultados para esta data' });

  // Encontrar aposta e jogo correspondente
  const apostaRes = row.resultados.apostas.find(a => a.jogo_id === jogo_id);
  const jogo = row.apostas?.jogos?.find(j => j.id === jogo_id);
  if (!apostaRes) return res.status(404).json({ error: 'Aposta não encontrada' });

  let novoResultado = apostaRes.resultado_aposta;
  let novoPlacar = apostaRes.placar;

  // Se forneceu placar, recalcular green/red
  if (placar && placar.match(/^\d+-\d+$/)) {
    const partes = placar.split('-');
    const gC = parseInt(partes[0]), gF = parseInt(partes[1]);
    novoPlacar = placar;
    if (jogo) {
      novoResultado = verificarAposta(jogo, gC, gF, null);
    }
    console.log(`✏️ Corrigindo placar ${apostaRes.time_casa} x ${apostaRes.time_fora}: ${apostaRes.placar} → ${placar} | ${apostaRes.resultado_aposta} → ${novoResultado}`);
  }

  const apostas = row.resultados.apostas.map(a => {
    if (a.jogo_id === jogo_id) {
      return { ...a, placar: novoPlacar, resultado_aposta: novoResultado, corrigido_manualmente: true };
    }
    return a;
  });

  await dbSaveResultados(data, { ...row.resultados, apostas });
  res.json({ ok: true, mensagem: `Corrigido: ${novoPlacar} → ${novoResultado}`, resultado: novoResultado, placar: novoPlacar });
});

app.get('/calibracao', async (req, res) => {
  const [semestral, mensal, semanal, diario] = await Promise.all([
    dbGetCalibracao('semestral'), dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'), dbGetCalibracao('diario')
  ]);
  res.json({ semestral, mensal, semanal, diario });
});

// Endpoint para buscar TODOS os relatórios de calibração (para aba Relatórios)
// Informar stats manualmente (escanteios/cartões) para apostas pendentes
app.post('/informar-stats', async (req, res) => {
  const { data, jogo_id, escanteios, cartoes } = req.body;
  if (!data || !jogo_id) return res.status(400).json({ error: 'data e jogo_id obrigatórios' });
  try {
    const row = await dbGet(data);
    if (!row?.apostas?.jogos) return res.status(404).json({ error: 'Sem apostas para essa data' });

    const jogo = row.apostas.jogos.find(j => j.id === jogo_id);
    if (!jogo) return res.status(404).json({ error: 'Jogo não encontrado' });

    const resultadosExistentes = row.resultados?.apostas || [];
    const resExistente = resultadosExistentes.find(r => r.jogo_id === jogo_id);
    if (!resExistente?.placar) return res.status(400).json({ error: 'Jogo sem placar — valide o placar primeiro' });

    const [gC, gF] = resExistente.placar.split('-').map(Number);
    const statsInformadas = {
      escanteiosTotal: escanteios || 0,
      escanteiosCasa: 0, escanteiosFora: 0,
      cartoesTotal: cartoes || 0,
      cartoesCasa: 0, cartoesFora: 0,
    };

    const resultado = verificarAposta(jogo, gC, gF, statsInformadas);
    const novosResultados = resultadosExistentes.map(r =>
      r.jogo_id === jogo_id
        ? { ...r, resultado_aposta: resultado, motivo: `Stats informadas manualmente: esc=${escanteios||0} cart=${cartoes||0}`, corrigido_manualmente: true }
        : r
    );

    await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: novosResultados });
    console.log(`📊 Stats informadas: ${jogo.time_casa} x ${jogo.time_fora} | esc=${escanteios} cart=${cartoes} → ${resultado}`);
    res.json({ ok: true, resultado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/calibracao/diario/:data', async (req, res) => {
  const cal = await dbGetCalibracaoPorPeriodo('diario', req.params.data);
  if (cal) res.json(cal);
  else res.status(404).json({ erro: 'Relatório não encontrado' });
});

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
