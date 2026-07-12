﻿const express = require('express');
const cors = require('cors');
const telegramAgendaRoutes = require('./routes/telegram-agenda');
const { agendarCronTelegram } = require('./crons/telegram-crons');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/telegram', telegramAgendaRoutes);

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
const ODDS_LIMITE = 25; // legado The Odds API

// Cache por fixture — API-Football /odds (sem limite extra, usa o limite geral de 1000/dia)
const oddsFixtureCache = new Map(); // "YYYY-MM-DD|fixtureId" → odds estruturadas

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

// Bookmakers preferidos para cálculo de odds (casas confiáveis + brasileiras)
// Bet365=8, Betfair=3, 1xBet=11, Bwin=6, Betway=24, Betano=32, Pinnacle=4
const BOOKMAKERS_PREFERIDOS = new Set([8, 3, 11, 6, 24, 32, 4]);

// Converte lista de bookmakers da API em mapa normalizado de odds (média entre casas)
function parsearBookmakersOdds(bookmakers) {
  const normStr = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const preferidos = bookmakers.filter(bm => BOOKMAKERS_PREFERIDOS.has(bm.id));
  const fonte = preferidos.length > 0 ? preferidos : bookmakers;
  const acum = {};
  for (const bm of fonte) {
    for (const bet of bm.bets || []) {
      const betNome = normStr(bet.name);
      for (const v of bet.values || []) {
        const val = normStr(v.value);
        const odd = parseFloat(v.odd);
        if (!odd || isNaN(odd)) continue;
        const chave = `${betNome}|${val}`;
        if (!acum[chave]) acum[chave] = [];
        acum[chave].push(odd);
      }
    }
  }
  const odds = {};
  for (const [chave, vals] of Object.entries(acum)) {
    odds[chave] = parseFloat((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2));
  }
  return Object.keys(odds).length ? odds : null;
}

// ─── API-Football /odds — por fixture ────────────────────────────────────────
async function buscarOddsFixture(fixtureId, data, forcarAtualizar = false) {
  if (!fixtureId) return null;
  const cacheKey = `${data}|${fixtureId}`;
  if (!forcarAtualizar && oddsFixtureCache.has(cacheKey)) return oddsFixtureCache.get(cacheKey);
  if (!contarRequisicao()) return null;

  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    if (!res.ok) { console.log(`⚠️ Odds fixture ${fixtureId}: HTTP ${res.status}`); return null; }
    const json = await res.json();
    const bookmakers = json.response?.[0]?.bookmakers || [];
    if (!bookmakers.length) {
      if (!forcarAtualizar) oddsFixtureCache.set(cacheKey, null); // só cacheia null na primeira vez
      return null;
    }

    const odds = parsearBookmakersOdds(bookmakers);
    oddsFixtureCache.set(cacheKey, odds);
    return odds;
  } catch(e) {
    console.error(`Erro odds fixture ${fixtureId}:`, e.message);
    return null;
  }
}

// Seleciona a odd correta do mapa retornado por buscarOddsFixture
function selecionarOddFixture(odds, aposta, mercado, timeCasa, timeFora) {
  if (!odds) return null;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const a = norm(aposta);

  // Extrai linha numérica da aposta (ex: "Over 2.5" → 2.5)
  const linhaMatch = a.match(/(\d+\.?\d*)/);
  const linha = linhaMatch ? linhaMatch[1] : null;

  // Helper 1: busca exata por lista de nomes conhecidos
  const buscar = (betNomes, valor) => {
    for (const bn of betNomes) {
      const v = odds[`${bn}|${valor}`];
      if (v !== undefined) return v;
    }
    return null;
  };

  // Helper 2: fallback — varre TODAS as chaves procurando por palavras-chave + valor
  // Usado quando o nome do bet na API não coincide com nenhum nome conhecido
  // Nota: odds só tem dados das casas preferidas (Bet365/Betano/Betfair/1xBet/Bwin/Betway)
  // → se encontrado aqui, mercado está disponível nessas casas = proxy da Estrela Bet
  // Mercados excluídos do fallback de jogo completo
  const PARCIAIS = ['first half','second half','1st half','2nd half','half time','halftime','1h','2h'];
  const TEAM_SPECIFIC = ['total - home','total - away','home team','away team','home total','away total',
    'home score','away score','home goals','away goals','home team score','away team score',
    'home team total','away team total','team to score','home exact','away exact'];
  const buscarPorPalavras = (palavrasChave, valor, excluirTeamSpecific = true) => {
    for (const chave of Object.keys(odds)) {
      const [betNome, betValor] = chave.split('|');
      if (PARCIAIS.some(p => betNome.includes(p))) continue;
      if (excluirTeamSpecific && TEAM_SPECIFIC.some(p => betNome.includes(p))) continue;
      const nomeOk = palavrasChave.some(p => betNome.includes(p));
      const valorOk = betValor === valor || betValor?.includes(valor);
      if (nomeOk && valorOk) return odds[chave];
    }
    return null;
  };

  // ── GOLS (inclui mercados de tempo parcial quando mencionados explicitamente) ──
  if (mercado === 'gols') {
    if (a.includes('ambos') || a.includes('ambas') || a.includes('btts') || a.includes('both teams')) {
      return buscar(['goals scored','both teams to score','both teams score','btts'], 'yes')
          || buscarPorPalavras(['both teams','btts','goals scored'], 'yes');
    }
    if (linha) {
      const dir = (a.includes('over') || a.includes('mais')) ? 'over' : 'under';

      // Tempo parcial mencionado explicitamente na aposta
      const isPrimTempo = a.includes('primeiro tempo') || a.includes('1o tempo') || a.includes('1º tempo') || a.includes('1st half') || a.includes('first half') || a.includes('ht');
      const isSegTempo  = a.includes('segundo tempo')  || a.includes('2o tempo') || a.includes('2º tempo') || a.includes('2nd half') || a.includes('second half');

      if (isPrimTempo) {
        const r1 = Object.entries(odds).find(([k]) => (k.includes('first half') || k.includes('1st half')) && k.includes(dir) && k.includes(linha));
        return buscar(['goals over/under first half','goals over/under - first half','first half goals','ht goals'], `${dir} ${linha}`)
            || (r1 ? r1[1] : null);
      }
      if (isSegTempo) {
        const r2 = Object.entries(odds).find(([k]) => (k.includes('second half') || k.includes('2nd half')) && k.includes('|'+dir+' '+linha));
        return buscar(['goals over/under - second half','goals over/under second half','second half goals'], `${dir} ${linha}`)
            || (r2 ? r2[1] : null);
      }

      // Jogo completo — fallback exclui parciais (comportamento original)
      return buscar(['goals over/under','total goals','over/under','total - goals','over/under goals'], `${dir} ${linha}`)
          || buscarPorPalavras(['goal','over/under','total'], `${dir} ${linha}`);
    }
  }

  // ── RESULTADO ─────────────────────────────────────────────────────────────
  if (mercado === 'resultado') {
    const ncasa = norm(timeCasa), nfora = norm(timeFora);
    const pcasa = ncasa.split(' ')[0], pfora = nfora.split(' ')[0];
    const mencCasa = pcasa.length > 2 && a.includes(pcasa);
    const mencFora = pfora.length > 2 && a.includes(pfora);

    if (a.includes('dupla') || a.includes('double')) {
      if (a.includes('1x') || a.includes('home/draw') || mencCasa)
        return buscar(['double chance'], 'home/draw') || buscar(['double chance'], '1x')
            || buscarPorPalavras(['double chance','double'], 'home/draw');
      if (a.includes('x2') || a.includes('draw/away') || mencFora)
        return buscar(['double chance'], 'draw/away') || buscar(['double chance'], 'x2')
            || buscarPorPalavras(['double chance','double'], 'draw/away');
      if (a.includes('12') || a.includes('home/away'))
        return buscar(['double chance'], 'home/away') || buscarPorPalavras(['double chance'], 'home/away');
    }
    if (a.includes('empate') || a === 'draw' || a === 'x')
      return buscar(['match winner','1x2','home/draw/away'], 'draw')
          || buscarPorPalavras(['match winner','1x2','result','winner'], 'draw');
    if (mencCasa || a.includes('casa vence') || a.includes('home wins') || a.includes('home'))
      return buscar(['match winner','1x2','home/draw/away'], 'home')
          || buscarPorPalavras(['match winner','1x2','result','winner'], 'home');
    if (mencFora || a.includes('fora vence') || a.includes('away wins') || a.includes('away'))
      return buscar(['match winner','1x2','home/draw/away'], 'away')
          || buscarPorPalavras(['match winner','1x2','result','winner'], 'away');
  }

  // ── ESCANTEIOS ────────────────────────────────────────────────────────────
  if (mercado === 'escanteios' && linha) {
    const dir = (a.includes('over') || a.includes('mais')) ? 'over' : 'under';
    return buscar(['corners over/under','total corners','corner kicks over/under','total - corners'], `${dir} ${linha}`)
        || buscarPorPalavras(['corner','escanteio'], `${dir} ${linha}`);
  }

  // ── CARTÕES ───────────────────────────────────────────────────────────────
  if (mercado === 'cartoes' && linha) {
    const dir = (a.includes('over') || a.includes('mais')) ? 'over' : 'under';
    return buscar(['cards over/under','total cards','bookings','total bookings'], `${dir} ${linha}`)
        || buscarPorPalavras(['card','booking','cartao'], `${dir} ${linha}`);
  }

  // ── COMBO (resultado + gols / resultado + BTTS) ───────────────────────────
  if (mercado === 'combo') {
    const ncasa = norm(timeCasa), nfora = norm(timeFora);
    const pcasa = ncasa.split(' ')[0], pfora = nfora.split(' ')[0];
    const mencCasa = pcasa.length > 2 && a.includes(pcasa);
    const mencFora = pfora.length > 2 && a.includes(pfora);
    const temCasa = mencCasa || a.includes('home') || a.includes('casa');
    const temFora = mencFora || a.includes('away') || a.includes('fora');
    const temEmpate = a.includes('empat') || a.includes('draw');

    const ladoResult = temEmpate ? 'draw' : temFora ? 'away' : 'home';

    // Combo resultado + Over/Under gols
    if (linha) {
      const dirCombo = (a.includes('over') || a.includes('mais')) ? 'over' : 'under';
      const comboVal = `${ladoResult} & ${dirCombo} ${linha}`;
      const rc = Object.entries(odds).find(([k,v]) => v >= ODD_MINIMA &&
        (k.includes('result') && (k.includes('total') || k.includes('goal'))) &&
        k.includes(`${dirCombo} ${linha}`) && k.includes(ladoResult));
      const found = buscar(['result/total goals','match result and total goals','result & total goals','double result'], comboVal)
          || (rc ? rc[1] : null);
      if (found) return found;
    }

    // Combo resultado + BTTS
    if (a.includes('btts') || a.includes('ambos') || a.includes('both teams')) {
      const comboVal = `${ladoResult} & yes`;
      const rb = Object.entries(odds).find(([k,v]) => v >= ODD_MINIMA &&
        (k.includes('btts') || k.includes('both teams')) && k.includes('result') && k.includes('yes') && k.includes(ladoResult));
      return buscar(['result/both teams score','match result and btts','result & btts'], comboVal)
          || (rb ? rb[1] : null);
    }
  }

  // ── 1º TEMPO RESULTADO ───────────────────────────────────────────────────
  if (mercado === 'resultado_1t' || (mercado === 'resultado' && (a.includes('primeiro tempo') || a.includes('1o tempo') || a.includes('1st half') || a.includes('halftime') || a.includes('ht ')))) {
    const ncasa = norm(timeCasa); const pfora = norm(timeFora).split(' ')[0];
    const lado = a.includes('empat') || a.includes('draw') ? 'draw'
               : (pfora.length > 2 && a.includes(pfora)) || a.includes('away') ? 'away'
               : 'home';
    const r1t = Object.entries(odds).find(([k,v]) => v >= ODD_MINIMA &&
      ((k.includes('first half') || k.includes('1st half') || k.includes('halftime') || k.includes('half time')) &&
       (k.includes('result') || k.includes('winner')) && k.includes(lado)));
    return buscar(['1st half winner','first half result','halftime result','half time result','1st half - match result'], lado)
        || buscar(['1st half winner','first half result','halftime result','half time result'], lado === 'home' ? '1' : lado === 'draw' ? 'x' : '2')
        || (r1t ? r1t[1] : null);
  }

  // ── 2º TEMPO RESULTADO ───────────────────────────────────────────────────
  if (mercado === 'resultado_2t') {
    const pfora = norm(timeFora).split(' ')[0];
    const lado = a.includes('empat') || a.includes('draw') ? 'draw'
               : (pfora.length > 2 && a.includes(pfora)) || a.includes('away') ? 'away'
               : 'home';
    const r2t = Object.entries(odds).find(([k,v]) => v >= ODD_MINIMA &&
      (k.includes('second half') || k.includes('2nd half')) && (k.includes('result') || k.includes('winner')) && k.includes(lado));
    return buscar(['2nd half winner','second half result','2nd half - match result'], lado)
        || buscar(['2nd half winner','second half result'], lado === 'home' ? '1' : lado === 'draw' ? 'x' : '2')
        || (r2t ? r2t[1] : null);
  }

  return null;
}

// Odd mínima global — mercado precisa ter odd real ≥ 1.25 para ser aceito
const ODD_MINIMA = 1.25;

// Gera justificativa pública limpa após pivô (remove termos internos)
function gerarJustificativaPosPivot(aposta, mercado, razao, jogo) {
  const termos = [/calibra[çc][aã]o\b/gi, /assertividade\b/gi, /LigaMedia\b/gi, /pivotad[ao]\b/gi, /nosso modelo\b/gi, /hist[oó]rico do sistema\b/gi, /especialista\b/gi, /agente\b/gi];
  let base = (razao || '').trim();
  for (const t of termos) base = base.replace(t, '');
  base = base.replace(/^[:\s—–-]+/, '').trim();
  if (!base) return `Análise dos dados recentes aponta ${aposta} como a opção mais consistente para este jogo.`;
  return base.charAt(0).toUpperCase() + base.slice(1) + (base.endsWith('.') ? '' : '.');
}
// Dia com muitos jogos disponíveis — não reutiliza descartados
const LIMITE_JOGOS_MUITOS = 20;

// Teto de jogos ativos por dia — excedente é descartado por prioridade (pri menor = mais importante)
function aplicarTetoAtivos(jogos, teto = 15) {
  // Slots ocupados = ativos + analisando (ambos contam para o teto)
  const ocupados = jogos.filter(j => !j.descartado);
  if (ocupados.length <= teto) return jogos;
  // Prioridade de corte: analisando primeiro (sem odd confirmada), depois menor pri
  ocupados.sort((a, b) => {
    if (a.analisando !== b.analisando) return a.analisando ? 1 : -1; // analisando corta primeiro
    return (a.pri || 99) - (b.pri || 99);
  });
  const manter = new Set(ocupados.slice(0, teto).map(j => j.id));
  let cortados = 0;
  const resultado = jogos.map(j => {
    if (!j.descartado && !manter.has(j.id)) {
      cortados++;
      return { ...j, descartado: true, analisando: false, descartado_motivo: 'excede_meta_jogos' };
    }
    return j;
  });
  if (cortados > 0) console.log(`✂️ aplicarTetoAtivos: ${ocupados.length} ocupados → cortando ${cortados} (excede teto ${teto})`);
  return resultado;
}

/**
 * Aplica odds reais ao jogo e pivota para a melhor alternativa.
 * Para ligas prioritárias (pri < 60): NUNCA descarta — aceita media se não houver alta.
 * Para complementares: exige confiança alta.
 * Retorna motivo de descarte apenas para complementares sem opção válida.
 */
function aplicarOddsEPivotar(jogo, oddsFixture) {
  // Liga prioritária = Série A/B, Copa do Mundo, Libertadores, Champions, grandes ligas
  const isPrioritario = jogo.pri != null && jogo.pri < 60;

  const tentarAposta = (aposta, mercado, confianca, aceitarMedia = false) => {
    const odd = selecionarOddFixture(oddsFixture, aposta, mercado, jogo.time_casa, jogo.time_fora);
    const oddNum = odd ? parseFloat(odd) : null;
    const confOk = confianca === 'alta' || (aceitarMedia && confianca === 'media');
    if (oddNum && oddNum >= ODD_MINIMA && confOk) return oddNum;
    return null;
  };

  // Coleta todas as alternativas que têm odd confirmada na API (usada pelo pool de múltiplas)
  const coletarOddsConfirmadas = () => {
    jogo.odds_confirmadas = [{ aposta: jogo.aposta, mercado: jogo.mercado, odd: jogo.odd_mercado }];
    for (const alt of (jogo.alternativas || []).filter(a => a.aposta && a.mercado)) {
      if (alt.aposta === jogo.aposta && alt.mercado === jogo.mercado) continue;
      const oddV = selecionarOddFixture(oddsFixture, alt.aposta, alt.mercado, jogo.time_casa, jogo.time_fora);
      const oddN = oddV ? parseFloat(oddV) : null;
      if (oddN && oddN >= ODD_MINIMA) jogo.odds_confirmadas.push({ aposta: alt.aposta, mercado: alt.mercado, odd: oddN });
    }
  };

  // Caso 1: aposta principal com odd ≥ mínima e confiança alta
  const oddPrincipal = tentarAposta(jogo.aposta, jogo.mercado, jogo.confianca);
  if (oddPrincipal) {
    jogo.odd_mercado = oddPrincipal;
    jogo.descartado = false;
    coletarOddsConfirmadas();
    console.log(`  ✅ ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} @ ${oddPrincipal} (alta)`);
    return null;
  }

  // Motivo do problema na principal
  const oddBruta = selecionarOddFixture(oddsFixture, jogo.aposta, jogo.mercado, jogo.time_casa, jogo.time_fora);
  const oddBrutaNum = oddBruta ? parseFloat(oddBruta) : null;
  let motivoPrincipal;
  if (!oddBrutaNum) motivoPrincipal = `mercado "${jogo.aposta}" indisponível na API`;
  else if (oddBrutaNum < ODD_MINIMA) motivoPrincipal = `odd ${oddBrutaNum} < mínima ${ODD_MINIMA}`;
  else motivoPrincipal = `confiança "${jogo.confianca}" não é alta`;

  console.log(`  ⚠️ ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} → ${motivoPrincipal} — buscando alternativa`);

  // Caso 2: alternativas com confiança alta e odd ≥ mínima
  const todasAlts = (jogo.alternativas || []).filter(a => a.aposta && a.mercado);
  for (const alt of todasAlts.filter(a => a.confianca === 'alta')) {
    const oddAlt = tentarAposta(alt.aposta, alt.mercado, alt.confianca);
    if (oddAlt) {
      console.log(`  ⚡ Pivotando → ${alt.aposta} (${alt.mercado}) @ ${oddAlt} (alta)`);
      jogo.aposta_original = jogo.aposta_original || jogo.aposta;
      jogo.mercado_original = jogo.mercado_original || jogo.mercado;
      jogo.aposta = alt.aposta; jogo.mercado = alt.mercado;
      jogo.odd_mercado = oddAlt; jogo.confianca = 'alta';
      jogo.descartado = false;
      jogo.justificativa = gerarJustificativaPosPivot(alt.aposta, alt.mercado, alt.razao || '', jogo);
      const proxAlt = todasAlts.find(a => a.aposta !== jogo.aposta);
      if (proxAlt) { jogo.aposta_backup = proxAlt.aposta; jogo.mercado_backup = proxAlt.mercado; }
      coletarOddsConfirmadas();
      return null;
    }
  }

  // Caso 2.5: liga PRIORITÁRIA — aceita confiança media se não há alta disponível
  if (isPrioritario) {
    for (const alt of todasAlts.filter(a => a.confianca === 'media')) {
      const oddAlt = tentarAposta(alt.aposta, alt.mercado, alt.confianca, true);
      if (oddAlt) {
        console.log(`  ⚡ [PRIORITÁRIO] Pivotando → ${alt.aposta} (${alt.mercado}) @ ${oddAlt} (media)`);
        jogo.aposta_original = jogo.aposta_original || jogo.aposta;
        jogo.mercado_original = jogo.mercado_original || jogo.mercado;
        jogo.aposta = alt.aposta; jogo.mercado = alt.mercado;
        jogo.odd_mercado = oddAlt; jogo.confianca = 'media';
        jogo.descartado = false;
        jogo.justificativa = gerarJustificativaPosPivot(alt.aposta, alt.mercado, alt.razao || '', jogo);
        const proxAlt = todasAlts.find(a => a.aposta !== jogo.aposta);
        if (proxAlt) { jogo.aposta_backup = proxAlt.aposta; jogo.mercado_backup = proxAlt.mercado; }
        coletarOddsConfirmadas();
        return null;
      }
    }
    // Caso 2.6: se ainda não achou nada nas alternativas, tentar aposta principal com media
    const oddPrincipalMedia = tentarAposta(jogo.aposta, jogo.mercado, jogo.confianca, true);
    if (oddPrincipalMedia) {
      jogo.odd_mercado = oddPrincipalMedia;
      jogo.descartado = false;
      coletarOddsConfirmadas();
      console.log(`  ✅ [PRIORITÁRIO] ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} @ ${oddPrincipalMedia} (media aceita)`);
      return null;
    }
  }

  // Caso 3: agente entregou aposta mas confirmação falhou em tudo
  // Para qualquer jogo com odds disponíveis: pegar o melhor mercado direto da lista — sem mais IA
  if (oddsFixture) {
    // Prioridade de mercados: gols > resultado > escanteios > cartões > outros
    const MERCADOS_PREF = [
      'goals over/under|','goals over/under first half|','goals over/under - second half|',
      'goal line|','match winner|','double chance|','both teams score|',
      'corners over under|','cards over/under|',
    ];
    // Filtrar mercados relevantes e válidos, ordenados por preferência e melhor odd
    const candidatos = [];
    for (const [chave, oddVal] of Object.entries(oddsFixture)) {
      if (oddVal < ODD_MINIMA || oddVal > 5) continue; // entre 1.25 e 5.00
      const pref = MERCADOS_PREF.findIndex(p => chave.startsWith(p));
      if (pref === -1) continue; // só mercados conhecidos
      const [betNome, betValor] = chave.split('|');
      // Excluir apostas de times individuais ou exóticos
      if (betNome.includes('total - home') || betNome.includes('total - away') || betNome.includes('exact score') || betNome.includes('correct score')) continue;
      candidatos.push({ chave, betNome, betValor, odd: oddVal, pref });
    }
    // Ordenar: primeiro por preferência, depois pela odd mais atraente (> 1.40 é melhor que 1.25)
    candidatos.sort((a, b) => {
      if (a.pref !== b.pref) return a.pref - b.pref;
      const scoreA = Math.abs(a.odd - 1.70); // ideal próximo de 1.70
      const scoreB = Math.abs(b.odd - 1.70);
      return scoreA - scoreB;
    });
    if (candidatos.length > 0) {
      const melhor = candidatos[0];
      // Mapear betNome para mercado interno
      const mercadoMap = melhor.betNome.includes('corner') ? 'escanteios'
        : melhor.betNome.includes('card') ? 'cartoes'
        : (melhor.betNome.includes('winner') || melhor.betNome.includes('double chance') || melhor.betNome.includes('both teams')) ? 'resultado'
        : 'gols';
      // Formatar aposta legível
      const apostaFinal = melhor.betNome.includes('first half') ? `${melhor.betValor.charAt(0).toUpperCase()}${melhor.betValor.slice(1)} - Primeiro Tempo`
        : melhor.betNome.includes('second half') ? `${melhor.betValor.charAt(0).toUpperCase()}${melhor.betValor.slice(1)} - Segundo Tempo`
        : `${melhor.betValor.charAt(0).toUpperCase()}${melhor.betValor.slice(1)}`;
      jogo.aposta_original = jogo.aposta_original || jogo.aposta;
      jogo.mercado_original = jogo.mercado_original || jogo.mercado;
      jogo.aposta = apostaFinal;
      jogo.mercado = mercadoMap;
      jogo.odd_mercado = melhor.odd;
      jogo.confianca = melhor.odd >= 1.50 ? 'alta' : 'media';
      jogo.descartado = false; jogo.analisando = false; jogo.descartado_motivo = null;
      jogo.justificativa = `Mercado disponível confirmado na API com odd ${melhor.odd}.`;
      coletarOddsConfirmadas();
      console.log(`  🎯 [FALLBACK] ${jogo.time_casa} x ${jogo.time_fora} → ${apostaFinal} (${mercadoMap}) @ ${melhor.odd}`);
      return null;
    }
  }

  // Sem nenhum mercado disponível na API
  const motivo = `${motivoPrincipal} | sem alternativa com odd ≥ ${ODD_MINIMA}${isPrioritario ? ' (prioritário)' : ' e confiança alta'}`;
  if (isPrioritario) {
    jogo.descartado = false;
    jogo.analisando = true;
    jogo.descartado_motivo = motivo;
    jogo.odd_mercado = null;
    console.log(`  ⏳ [PRIORITÁRIO] ${jogo.time_casa} x ${jogo.time_fora} → analisando: ${motivo}`);
    return null;
  }
  jogo.descartado = true;
  jogo.descartado_motivo = motivo;
  console.log(`  ❌ Descartando ${jogo.time_casa} x ${jogo.time_fora}: ${motivo}`);
  return motivo;
}

/**
 * Verifica se um fixture tem ao menos 1 mercado apostável confirmável.
 * Usa os MESMOS critérios do fallback em aplicarOddsEPivotar (MERCADOS_PREF)
 * para garantir que pré-validação e fallback estejam alinhados.
 */
const MERCADOS_APOSTAVEL = [
  'goals over/under|', 'goals over/under first half|', 'goals over/under - second half|',
  'goal line|', 'match winner|', 'double chance|', 'both teams score|',
  'corners over under|', 'cards over/under|',
];
function temMercadoApostavel(oddsFixture) {
  if (!oddsFixture) return false;
  return Object.entries(oddsFixture).some(([k, v]) =>
    v >= ODD_MINIMA && v <= 5 &&
    MERCADOS_APOSTAVEL.some(p => k.startsWith(p)) &&
    !k.includes('total - home') && !k.includes('total - away')
  );
}

/**
 * Formata todos os mercados disponíveis de um fixture para apresentar ao agente.
 * Retorna string formatada com: mercado | aposta | odd
 */
function formatarMercadosDisponiveisParaIA(oddsFixture) {
  if (!oddsFixture) return 'Nenhum mercado disponível na API.';
  // Mercados relevantes — inclui tempo parcial, combos e handicap asiático
  const RELEVANTES = [
    'goals over/under','total goals','over/under',
    'match winner','1x2','home/draw/away',
    'double chance',
    'both teams','btts','goals scored',
    'corners','corner',
    'cards','booking',
    'first half','second half','1st half','2nd half','halftime','half time',
    'result/total goals','result & total','match result and total',
    'asian handicap','handicap',
    'winning margin',
    'to score','anytime',
  ];
  const linhas = [];
  for (const [chave, odd] of Object.entries(oddsFixture).sort()) {
    const [betNome, valor] = chave.split('|');
    if (odd >= ODD_MINIMA && odd <= 10 && RELEVANTES.some(r => betNome.includes(r))) {
      linhas.push(`  ${betNome} → ${valor}: ${odd}`);
    }
  }
  return linhas.length ? linhas.join('\n') : 'Nenhum mercado com odd ≥ 1.25.';
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
  // Irlanda — ligas com bom histórico de odds, melhor que pri=90 genérico europeu
  357: { nome:'Liga Premier Irlanda',      tipo:'eu', pri:68 },
  358: { nome:'Primeira Divisão Irlanda',  tipo:'eu', pri:69 },
  // Peru — Liga 1 com boas odds, melhor que pri=70 genérico sul-americano
  284: { nome:'Liga 1 Peru',               tipo:'sul', pri:68 },
  // Copa Peru (competição de copa, não liga principal)
  485: { nome:'Copa Peru',                 tipo:'sul', pri:72 },
  // Amistosos femininos — aceitar todas as seleções adultas
  666: { nome:'Amistoso Feminino',tipo:'copa', pri:95 },
  // Qualificação Copa do Mundo feminina
  880: { nome:'Eliminatórias Copa Feminina',tipo:'copa', pri:92 },
  1206:{ nome:'Nations League Feminina CONMEBOL',tipo:'copa', pri:92 },
};

// IDs a ignorar explicitamente (ligas brasileiras que NÃO são prioritárias)
const LIGAS_IGNORAR = new Set([
  // 75 Série C removido — tem odds apostáveis na API (65-115 mercados) e serve como complementar
  // 76 Série D removido — tem odds apostáveis na API e serve como complementar em dias fracos
  1098,        // Paulista Série B
  851,         // Carioca A2
  936, 614, 619, 620, 613, // Estaduais div 2
  1073, 1076, 1086, 1100, 1107, 1128, 1069, 1071, // Sub-20 e U17
  1148, 1158, 1096, 1097,  // Copas regionais
  1146, 1143,  // Alagoano-2, Estadual Junior
  // Competições internacionais sub-categorias
  921, 928, 914, 973, // UEFA U17, ASEAN U19, Tournoi Revello, CAF U17
  // Ligas sem cobertura de odds na API-Football (sempre descartados)
  1232, 1229,  // Copa De La Liga Peru, Liga Women Peru
  711,         // Segunda División Chile — mercados indisponíveis na API
  1113,        // Copa Venezuela — sem cobertura de odds
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
    l.includes('- 2') // serie c e serie d removidos — têm odds apostáveis na API
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
const LIMITE_SEGURO = 7500; // limite real da API-Football por dia
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

// Outputs brutos dos agentes especializados (Gols/Resultado/Escanteios/Cartões) por data
// Uso interno do Agente de Múltiplas — nunca persistido no banco
const _agentesRawCache = new Map();

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

// ─── Atualizar stats de liga ─────────────────────────────────
// Encontra o resultado (green/red) de uma alternativa de texto dentro do dicionário mercadosResult
function calcularResultadoAlternativaTexto(apostaTexto, mercadoResultDict) {
  if (!apostaTexto || !mercadoResultDict) return null;
  const apNorm = apostaTexto.trim().toLowerCase();
  for (const [chave, res] of Object.entries(mercadoResultDict)) {
    if (apNorm.includes(chave.toLowerCase()) || chave.toLowerCase().includes(apNorm)) return res;
  }
  return null;
}

async function dbUpdateLigaStats(ligaId, green, red, mercado, valorEscanteios = null, valorCartoes = null) {
  if (!ligaId) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=eq.${ligaId}&select=green,red,total,mercados,media_escanteios,media_cartoes,amostras_escanteios,amostras_cartoes`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows?.length) return;
    const atual = rows[0];
    const novoGreen = (atual.green || 0) + green;
    const novoRed   = (atual.red   || 0) + red;
    const novoTotal = (atual.total || 0) + green + red;
    // Atualizar mercados jsonb
    const mercados = atual.mercados || {};
    if (mercado) {
      if (!mercados[mercado]) mercados[mercado] = { green: 0, red: 0 };
      mercados[mercado].green += green;
      mercados[mercado].red   += red;
    }

    const body = { green: novoGreen, red: novoRed, total: novoTotal, mercados };

    // Atualizar média incremental de escanteios (média móvel ponderada por amostras)
    if (valorEscanteios !== null && valorEscanteios >= 0) {
      const amostrasAnt = atual.amostras_escanteios || 0;
      const mediaAnt = atual.media_escanteios || 0;
      const novaAmostra = amostrasAnt + 1;
      body.media_escanteios = ((mediaAnt * amostrasAnt) + valorEscanteios) / novaAmostra;
      body.amostras_escanteios = novaAmostra;
    }
    // Atualizar média incremental de cartões
    if (valorCartoes !== null && valorCartoes >= 0) {
      const amostrasAnt = atual.amostras_cartoes || 0;
      const mediaAnt = atual.media_cartoes || 0;
      const novaAmostra = amostrasAnt + 1;
      body.media_cartoes = ((mediaAnt * amostrasAnt) + valorCartoes) / novaAmostra;
      body.amostras_cartoes = novaAmostra;
    }

    await fetch(`${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=eq.${ligaId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch(e) { console.error('Erro dbUpdateLigaStats:', e.message); }
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
    const existing = await dbGet(data);
    if (existing) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ apostas })
      });
      if (!res.ok) { const err = await res.text(); console.error(`❌ dbSave PATCH erro ${res.status}: ${err}`); }
      else console.log(`💾 dbSave PATCH OK — ${data} | ${apostas?.jogos?.length || 0} jogos`);
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ data, apostas })
      });
      if (!res.ok) { const err = await res.text(); console.error(`❌ dbSave POST erro ${res.status}: ${err}`); }
      else console.log(`💾 dbSave POST OK — ${data} | ${apostas?.jogos?.length || 0} jogos`);
    }
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

      const relatorioComplementado = await chamarIA(promptComplementar, 1500);
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
  let totalEscanteios = 0, totalCartoes = 0, countStats = 0, countCartoes = 0;
  for (const f of ultimosJogos) {
    if (f.statistics) {
      const statsTime = f.statistics.find(s => s.team?.id === teamId);
      if (statsTime) {
        const esc = statsTime.statistics?.find(s => s.type === 'Corner Kicks')?.value;
        const cart = statsTime.statistics?.find(s => s.type === 'Yellow Cards')?.value;
        if (esc) { totalEscanteios += parseInt(esc) || 0; countStats++; }
        if (cart) { totalCartoes += parseInt(cart) || 0; countCartoes++; }
      }
    }
  }

  return {
    forma,
    mediaGols,
    mediaEscanteios: countStats > 0 ? (totalEscanteios / countStats).toFixed(1) : '-',
    mediaCartoes: countCartoes > 0 ? (totalCartoes / countCartoes).toFixed(1) : '-',
    h2hTexto: h2h.slice(0,5).map(f => {
      const data = (f.fixture?.date||'').substring(0,10);
      const gh = f.goals?.home ?? '-', ga = f.goals?.away ?? '-';
      const totalGols = (typeof gh === 'number' && typeof ga === 'number') ? ` (${gh+ga}g)` : '';
      const home = f.teams?.home?.name || '?', away = f.teams?.away?.name || '?';
      return `${data} ${home} ${gh}-${ga} ${away}${totalGols}`;
    }).join(' | ') || 'Sem H2H'
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
  const modelos = ['claude-sonnet-4-5', 'claude-haiku-4-5'];
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
        const usage = json.usage || {};
        registrarCusto(modelo, usage.input_tokens || 3000, usage.output_tokens || 800);
        chamadas.webSearch++;
        const txt = (json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        return txt;
      }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo} busca: ${e.message}`); }
  }
  return chamarIA(prompt, maxTokens);
}

// ─── Memória de calibração ────────────────────────────────────
async function buscarMemoria() {
  // Mensal (visão macro) + Semanal (tendência recente) + último diário (ontem)
  const [mensal, semanal, diarios] = await Promise.all([
    dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'),
    dbGetCalibracoes('diario', 1)
  ]);

  let mem = '';

  // Mensal — padrões consolidados de longo prazo
  if (mensal) mem += `[MENSAL ${mensal.periodo_inicio}→${mensal.periodo_fim} | assertividade: ${mensal.assertividade}%]\n${mensal.relatorio.substring(0, 600)}\n\n`;

  // Semanal — tendência da semana atual
  if (semanal) mem += `[SEMANAL ${semanal.periodo_inicio}→${semanal.periodo_fim} | assertividade: ${semanal.assertividade}%]\n${semanal.relatorio.substring(0, 600)}\n\n`;

  // Último diário — o que aconteceu ontem especificamente
  const ultimoDiario = diarios?.[0];
  if (ultimoDiario) mem += `[DIÁRIO ${ultimoDiario.periodo_inicio} | assertividade: ${ultimoDiario.assertividade}%]\n${ultimoDiario.relatorio.substring(0, 500)}\n\n`;

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
    const subRegex = /\bU(1[7-9]|20)\b/i;
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

      if (!jogosMap.has(key)) {
        // Salvar liga no banco automaticamente
        dbSaveLiga(ligaMatch.nome, ligaId, pais).catch(()=>{});
        jogosMap.set(key, { liga: ligaMatch.nome, tipo: ligaMatch.tipo, pri: priFinal, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId: ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
      }
    } else {
      // Complementares — definir tipo CORRETO e prioridade pelo país
      // Para ligas "World", tentar inferir pelo nome da liga ou aceitar como amistoso
      const paisLower = pais.toLowerCase();
      const isWorldLeague = paisLower === 'world';

      // Ignorar países com ligas muito fracas (não aplicar a ligas World)
      if (!isWorldLeague && PAISES_IGNORAR_COMP.has(paisLower)) continue;

      // Ligas World sem ID mapeado — separar amistosos masculinos de seleção dos demais
      if (isWorldLeague) {
        const ligaLowerW = ligaNome.toLowerCase();
        const isAmistososMasc = ligaLowerW.includes('friendly') || ligaLowerW.includes('international') || ligaLowerW.includes('amistoso');
        // Amistosos masculinos de seleção: pri 85 (depois das africanas/oriente médio pri 80, antes do resto pri 200)
        const priWorld = isAmistososMasc ? 85 : 150;
        if (!jogosComp.has(key)) {
          jogosComp.set(key, { liga: `${ligaNome}`, tipo: 'copa', pri: priWorld, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId: ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
        }
        continue;
      }

      let priComp = 20;
      let tipoComp = 'other';

      const EUROPEUS = ["england","scotland","spain","italy","france","germany","portugal","netherlands","belgium","turkey","austria","switzerland","denmark","norway","croatia","serbia","ukraine","greece","russia","poland","czech-republic","finland","sweden","hungary","romania","slovakia","bulgaria","georgia","albania","armenia","estonia","latvia","lithuania","luxembourg","malta","wales","ireland","iceland","cyprus","north macedonia","montenegro","kosovo","andorra","faroe islands","gibraltar","bosnia"];
      const SUL_AMERICANOS = ["argentina","colombia","chile","uruguay","peru","venezuela","bolivia","ecuador","paraguay"];
      const AFRICA_ORIENTE = ["egypt","morocco","algeria","tunisia","saudi-arabia","uae","qatar","kuwait","jordan","iran","nigeria","ghana","senegal","ivory coast","cameroon","south africa"];
      const CONCACAF = ["canada","usa","mexico","costa rica","honduras","el salvador","guatemala","panama","jamaica","trinidad and tobago"];

      if (EUROPEUS.includes(paisLower)) {
        tipoComp = 'eu';
        priComp = isTimesEuropaB(timeCasa, timeFora) ? 50 : 90;
      } else if (SUL_AMERICANOS.includes(paisLower)) {
        tipoComp = 'sul';
        priComp = 70;
      } else if (CONCACAF.includes(paisLower)) {
        tipoComp = 'concacaf';
        priComp = 75;
      } else if (AFRICA_ORIENTE.includes(paisLower)) {
        tipoComp = 'af';
        priComp = 80;
      } else if (paisLower === 'brazil' || paisLower === 'brasil') {
        // Ligas brasileiras complementares — Série C pri=60, Série D após Africa/Oriente (pri=82)
        tipoComp = 'b';
        priComp = (ligaId === 76) ? 82 : 60;
      } else {
        // Todo o resto — menor prioridade possível
        priComp = 200;
      }

      if (!jogosComp.has(key)) {
        // Salvar liga complementar no banco automaticamente
        dbSaveLiga(`${ligaNome} (${pais})`, ligaId, pais).catch(()=>{});
        jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: tipoComp, pri: priComp, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId: ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id });
      }
    }
  }

  // Buscar assertividade por liga E por mercado para enriquecer prompt e complemento
  const todasLigaIdsComp = [...new Set([...jogosComp.values()].map(j => j.ligaId).filter(Boolean))];
  // Também buscar ligas dos jogos prioritários para injetar no prompt
  const todasLigaIdsPri = [...new Set([...jogosMap.values()].map(j => j.ligaId).filter(Boolean))];
  const todasLigaIds = [...new Set([...todasLigaIdsComp, ...todasLigaIdsPri])];
  const ligaStatsMap = new Map(); // ligaId → { green, red, total, mercados, assertividade }
  if (todasLigaIds.length > 0) {
    try {
      const ids = todasLigaIds.join(',');
      const resL = await fetch(
        `${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=in.(${ids})&select=liga_id,nome,green,red,total,mercados,media_escanteios,media_cartoes,amostras_escanteios,amostras_cartoes`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rowsL = await resL.json();
      for (const row of (rowsL || [])) {
        if (row.total >= 3) {
          const assert = Math.round((row.green / row.total) * 100);
          ligaStatsMap.set(row.liga_id, { ...row, assertividade: assert });
        }
      }
    } catch(e) { /* silencioso */ }
  }

  // Memória de calibração — declarada antes para poder ser enriquecida com assertividade por liga
  const memoria = await buscarMemoria();
  let blocoMem = memoria ? `\nHISTÓRICO DE CALIBRAÇÃO (use para melhorar as apostas):\n${memoria.substring(0,3000)}\n` : '';

  // Montar bloco de assertividade por liga para injetar no prompt
  if (ligaStatsMap.size > 0) {
    let blocoLigas = '\nASSERTIVIDADE HISTÓRICA POR LIGA (use para escolher mercado):\n';
    for (const [ligaId, st] of ligaStatsMap) {
      const mercadosTexto = Object.entries(st.mercados || {})
        .filter(([, m]) => (m.green + m.red) >= 2)
        .map(([mercado, m]) => {
          const tot = m.green + m.red;
          const pct = Math.round((m.green / tot) * 100);
          return `${mercado}: ${pct}% (${m.green}G/${m.red}R)`;
        }).join(' | ');
      blocoLigas += `  Liga ${ligaId} (${st.nome||'?'}): geral ${st.assertividade}%${mercadosTexto ? ' — ' + mercadosTexto : ''}
`;
    }
    blocoMem = (blocoMem || '') + blocoLigas;
    console.log(`📊 Assertividade de ${ligaStatsMap.size} liga(s) injetada no prompt`);
  }

  // Enriquecer complementares com assertividade real da liga (se disponível)
  const ligaIds = todasLigaIdsComp;
  const assertividadeLigas = new Map();
  if (ligaIds.length > 0) {
    try {
      const ids = ligaIds.join(',');
      const resL = await fetch(
        `${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=in.(${ids})&select=liga_id,green,red,total`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rowsL = await resL.json();
      for (const row of (rowsL || [])) {
        if (row.total >= 3) { // mínimo 3 apostas para considerar o histórico
          const assert = Math.round((row.green / row.total) * 100);
          assertividadeLigas.set(row.liga_id, assert);
        }
      }
    } catch(e) { /* silencioso — fallback para pri fixa */ }
  }

  // Ajustar pri dos complementares com base na assertividade real
  for (const [key, jogo] of jogosComp) {
    const st = ligaStatsMap.get(jogo.ligaId);
    if (st) {
      const assert = st.assertividade;
      if (assert >= 80)      jogo.pri = Math.min(jogo.pri, 60);
      else if (assert >= 70) jogo.pri = Math.min(jogo.pri, 70);
      else if (assert >= 60) jogo.pri = Math.min(jogo.pri, 80);
      else if (assert < 40 && st.total >= 5) jogo.pri = Math.max(jogo.pri, 180); // rebaixar ligas fracas
    }
  }

  // 1. Prioritários ordenados por prioridade
  let jogos = Array.from(jogosMap.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

  // 2. Filtrar times já selecionados ANTES de decidir se precisamos de complementares
  if (timesIgnorar.size > 0) {
    const antes = jogos.length;
    jogos = jogos.filter(j => {
      const casa = j.timeCasa?.toLowerCase();
      const fora = j.timeFora?.toLowerCase();
      return !timesIgnorar.has(casa) && !timesIgnorar.has(fora);
    });
    const filtrados = antes - jogos.length;
    if (filtrados > 0) console.log(`🚫 ${filtrados} jogos filtrados (duplicatas) da lista prioritária`);
  }

  // 3. Se ainda falta, buscar em complementares (já excluindo times ignorados)
  if (jogos.length < metaJogos) {
    const compOrdenado = Array.from(jogosComp.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));
    let cont13h = 0;
    const compFiltrado = [];
    for (const j of compOrdenado) {
      const casa = j.timeCasa?.toLowerCase();
      const fora = j.timeFora?.toLowerCase();
      // Ignorar duplicatas também nos complementares
      if (timesIgnorar.size > 0 && (timesIgnorar.has(casa) || timesIgnorar.has(fora))) continue;
      if (j.horario === '13:00') {
        cont13h++;
        if (cont13h <= 4) compFiltrado.push(j);
      } else {
        compFiltrado.push(j);
      }
    }
    const faltam = metaJogos - jogos.length;
    console.log(`📋 Buscando ${faltam} jogo(s) em ligas complementares → ${compFiltrado.length} candidatos disponíveis`);
    jogos = [...jogos, ...compFiltrado.slice(0, faltam * 3)];
  }

  if (jogos.length < metaJogos) console.log(`⚠️ Apenas ${jogos.length} jogos únicos disponíveis após todos os filtros`);

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
  if (memoria) {
    const nDiarios = (memoria.match(/\[DIÁRIO/g) || []).length;
    const temSemanal = memoria.includes('[SEMANAL');
    const temMensal = memoria.includes('[MENSAL');
    console.log(`📚 Memória carregada: ${nDiarios} diário(s)${temSemanal?' + semanal':''}${temMensal?' + mensal':''} — ${memoria.length} chars`);
  } else {
    console.log('📚 Sem memória de calibração disponível');
  }

  function montarListaJogos(lista, offsetId = 0, reduzido = false) {
    return lista.map((j, i) => {
      const s = j._stats;
      const sc = s?.statsCasa, sf = s?.statsFora;
      // Assertividade por mercado dessa liga (se disponível) — só no modo completo
      let ligaPerf = '';
      if (!reduzido) {
        const st = ligaStatsMap?.get(j.ligaId);
        if (st?.mercados) {
          const mercPerf = Object.entries(st.mercados)
            .filter(([, m]) => (m.green + m.red) >= 2)
            .map(([mercado, m]) => {
              const tot = m.green + m.red;
              const pct = Math.round((m.green / tot) * 100);
              return `${mercado}:${pct}%(${m.green}G/${m.red}R)`;
            }).join(' ');
          if (mercPerf) ligaPerf = `\n   LigaPerf: ${mercPerf}`;
        }
        // Médias reais de escanteios/cartões da liga (calibração de linha)
        if (st?.media_escanteios || st?.media_cartoes) {
          const partes = [];
          if (st.media_escanteios) partes.push(`escanteios média real ${st.media_escanteios.toFixed(1)} (${st.amostras_escanteios||0} jogos)`);
          if (st.media_cartoes) partes.push(`cartões média real ${st.media_cartoes.toFixed(1)} (${st.amostras_cartoes||0} jogos)`);
          ligaPerf += `\n   LigaMedia: ${partes.join(' | ')}`;
        }
      }
      if (reduzido) {
        // Modo reduzido para lote 2 — só essencial, sem H2H completo
        return `${offsetId+i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}
   Casa: forma=${sc?.forma||'?'} gols=${sc?.mediaGols||'?'} esc=${sc?.mediaEscanteios||'?'} cart=${sc?.mediaCartoes||'?'}
   Fora: forma=${sf?.forma||'?'} gols=${sf?.mediaGols||'?'} esc=${sf?.mediaEscanteios||'?'} cart=${sf?.mediaCartoes||'?'}`;
      }
      return `${offsetId+i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}
   Casa: forma=${sc?.forma||'?'} gols/jogo=${sc?.mediaGols||'?'} esc=${sc?.mediaEscanteios||'?'} cart=${sc?.mediaCartoes||'?'}
   Fora: forma=${sf?.forma||'?'} gols/jogo=${sf?.mediaGols||'?'} esc=${sf?.mediaEscanteios||'?'} cart=${sf?.mediaCartoes||'?'}
   H2H: ${sc?.h2hTexto||'sem dados'}${ligaPerf}`;
    }).join('\n');
  }

  function montarPromptReduzido(listaJogos, df) {
    return `Analista de apostas. DATA: ${df}
JOGOS:
${listaJogos}

Para cada jogo avalie gols, resultado, escanteios e cartões pelos dados.
Escolha a aposta mais confiável. Nunca retorne confiança baixa como principal.
Escanteios alta: média combinada ≥ 10.0. Cartões alta: média combinada ≥ 5.5.

Retorne SOMENTE JSON:
{"jogos":[{"id":1,"liga":"Liga","tipo_liga":"eu","time_casa":"A","time_fora":"B","horario":"15:00","aposta":"Over 2.5 gols","mercado":"gols","aposta_backup":"Over 1.5 gols","mercado_backup":"gols","razao_escolha":"média 3.1 gols","odd_sugerida":"1.80","confianca":"alta","media_gols_casa":"1.6","media_gols_fora":"1.5","media_escanteios":"9.2","media_cartoes":"3.8","forma_casa":"VVDEV","forma_fora":"DEVVD","justificativa":"Análise.","alternativas":[{"mercado":"gols","aposta":"Over 2.5","confianca":"alta","razao":"média alta"},{"mercado":"resultado","aposta":"Casa vence","confianca":"media","razao":"boa forma"},{"mercado":"escanteios","aposta":"Over 8.5","confianca":"media","razao":"média 9.2"},{"mercado":"cartoes","aposta":"Over 3.5","confianca":"baixa","razao":"média baixa"}]}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;
  }

  function montarPrompt(listaJogos, blocoMem, df) {
    const blocoHistorico = blocoMem ? `HISTÓRICO DE CALIBRAÇÃO:
Use este histórico para calibrar suas apostas de hoje. Mantenha o que está dando green, corrija o que está dando red.
- O que está funcionando: reforce esses padrões de mercado e liga
- O que está falhando: evite repetir o mesmo tipo de aposta nessas ligas/mercados
- Assertividade é o guia: acima de 70% o padrão está bom, abaixo disso precisa corrigir o mercado escolhido

${blocoMem}` : '';

    return `Você é um analista de apostas esportivas experiente. Para cada jogo, avalie TODOS os mercados antes de decidir.

DATA: ${df}
${blocoHistorico}
JOGOS COM ESTATÍSTICAS REAIS (últimos 10 jogos de cada time):
${listaJogos}

PROCESSO OBRIGATÓRIO para cada jogo:

REGRA DE ODD MÍNIMA (CRÍTICO):
- O sistema só aceita apostas com odd real ≥ 1.25 verificada nas casas de apostas
- Prefira SEMPRE mercados com odds que costumam ficar entre 1.40–2.50 (zona de valor)
- Sugira MÚLTIPLAS alternativas em mercados diferentes — o sistema vai buscar a odd real e escolher a disponível
- Evite linhas muito óbvias (ex: Over 0.5 gols) que terão odd < 1.25

PASSO 1 — Consulte o histórico de calibração:
- Qual mercado está performando melhor NESSA LIGA especificamente?
- Se gols está com red histórico nessa liga, priorize escanteios, cartões ou resultado

PASSO 2 — Avalie CADA mercado separadamente com os dados disponíveis:
- GOLS: média combinada casa+fora, H2H gols, padrão Over/Under nos últimos jogos
- RESULTADO: força relativa, forma recente, H2H vencedor, vantagem clara?
- ESCANTEIOS: some média escanteios casa + fora. Se ≥ 9.0 → Over 8.5 é confiável. Se ≥ 11.0 → Over 10.5 é alta confiança. Escanteios dependem menos do resultado — são mais previsíveis.
- CARTÕES: some média cartões casa + fora. Se ≥ 4.5 → Over 3.5 é confiável. Se ≥ 6.0 → Over 4.5 é alta confiança. Rivalidades, jogos diretos e ligas físicas aumentam cartões.
- Use web_search para lesões, escalações e contexto atual

CALIBRAÇÃO DE LINHA COM LigaMedia (se disponível para a liga do jogo):
- LigaMedia mostra a média REAL de escanteios/cartões observada em jogos dessa liga que já validamos — mesmo com poucas amostras, é um dado real e vale mais que a projeção genérica da API
- Compare a linha que você ia escolher (baseada na média do jogo) com o LigaMedia da liga
- Se a média do jogo aponta para uma linha (ex: Over 9.5) mas o LigaMedia é menor (ex: 7.8), PREFIRA a linha mais conservadora (ex: Over 7.5) — a amostra real da liga é mais confiável que a projeção do jogo específico
- Exemplo: jogo sugere escanteios combinados 9.2 → Over 8.5. Mas LigaMedia = 7.0 (3 jogos). Prefira Over 6.5, mais alinhado com o que a liga realmente entrega
- Se não houver LigaMedia para a liga, use normalmente a média do jogo

PASSO 3 — Classifique os mercados por confiança (alta/media/baixa/nao_recomendado)
CRITÉRIO OBJETIVO para alta confiança em escanteios/cartões:
- Escanteios alta: média combinada ≥ 10.0 OU histórico H2H consistente com muitos escanteios
- Cartões alta: média combinada ≥ 5.5 OU rivalidade intensa OU jogo de pressão (rebaixamento, título)
- Nunca classifique como baixa escanteios/cartões apenas por ser mercado menos comum — avalie os dados

PASSO 4 — Escolha o mercado com maior confiança E coerente com a análise.
REGRA CRÍTICA: a justificativa DEVE explicar por que escolheu ESSE mercado e não outro.
Se escrever "Under 2.5 é confiável" mas apostar Over 1.5, está ERRADO — seja coerente.
NUNCA retorne confiança baixa como aposta principal — se o melhor disponível é baixa, pivote para o segundo melhor.

REGRA DE MERCADO PARA FAVORITOS ABSOLUTOS (Copa do Mundo e grandes seleções):
- Se um time é favorito com odd de vitória simples < 1.40, NÃO escolha Dupla Chance ou vitória simples como aposta principal — a odd real será < 1.25 e o jogo será descartado.
- Nesses casos, PRIORIZE: Over 2.5 gols (favorito forte marca muito), escanteios (favorito domina posse), ou Over 3.5 gols se os dados apontarem.
- Dupla Chance X2 com favorito claro = aposta sem valor, sempre resultará em descarte.

CAMPO justificativa — REGRAS OBRIGATÓRIAS:
- É o texto exibido ao PÚBLICO FINAL. Escreva como um especialista em apostas explicando sua análise, em português natural.
- JAMAIS use os termos: "calibração", "assertividade", "LigaMedia", "pivotado", "nosso modelo", "histórico do sistema", "histórico mostra X%", "sistema identificou". Esses termos são internos e nunca devem aparecer no texto público.
- Mencione apenas fatores esportivos observáveis: forma recente, H2H, média de gols/escanteios/cartões, contexto do jogo (pressão por título/rebaixamento), qualidade dos times, padrão observado nos últimos jogos.
- O campo justificativa DEVE ser coerente com o mercado e aposta FINAL escolhidos. Se a aposta é "Over 9.5 escanteios", a justificativa fala de escanteios — nunca de gols.
- 2 a 3 frases, direto ao ponto.

REGRAS:
- Série A e Série B têm análise OBRIGATÓRIA
- Preencha TODOS os campos com valores numéricos reais
- alternativas: listar TODOS os 4 mercados com aposta, confiança e razão

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"A","time_fora":"B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","razao_escolha":"Média combinada 3.1 gols, H2H 4/5 com Over 2.5, histórico da liga 70% green em gols","aposta_backup":"Over 1.5 gols","mercado_backup":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"VVEDV","forma_fora":"DEVVD","justificativa":"Análise completa do jogo.","alternativas":[{"mercado":"gols","aposta":"Over 2.5 gols","confianca":"alta","razao":"média 3.1 gols, H2H favorável"},{"mercado":"resultado","aposta":"Casa vence","confianca":"media","razao":"forma recente melhor em casa"},{"mercado":"escanteios","aposta":"Over 8.5 escanteios","confianca":"media","razao":"média 9.2 escanteios combinados"},{"mercado":"cartoes","aposta":"Over 3.5 cartões","confianca":"baixa","razao":"média 3.1, jogo sem rivalidade"}]}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca da aposta principal: alta/media/baixa (NUNCA nao_recomendado — se nenhum mercado presta, escolha o menos ruim com baixa). confianca nas alternativas: alta/media/baixa/nao_recomendado.
razao_escolha: frase curta explicando por que esse mercado e não outro.
alternativas: OBRIGATÓRIO — todos os 4 mercados avaliados, ordenados do mais ao menos confiável.`;
  }

  // Margem de reserva: quanto maior, mais candidatos analisados → menor risco de faltar jogos
  // Com Copa Chile/Paraguay (~35% falha em odds), precisamos de buffer generoso
  // Custo extra: ~$0.003 por jogo adicional no Haiku — vale a pena vs faltar jogos
  // ── PRÉ-VALIDAÇÃO DE ODDS: filtrar candidatos sem cobertura na API ──────────
  // Verifica rapidamente quais fixtures têm odds disponíveis antes de enviar à IA
  // Garante que jogos como Rangers/Nublense (sem odds) nunca ocupem slots
  console.log(`\n🔍 Pré-validando odds para ${jogos.length} candidatos...`);
  const jogosComOdds = [];
  const jogosSemOdds = [];

  for (const j of jogos) {
    if (!j.fixtureId) { jogosSemOdds.push(j); continue; }
    // Jogos prioritários (pri < 10): aceitar mesmo sem odds confirmadas (tentar na análise)
    const isPriAlta = j.pri != null && j.pri < 10;
    const odds = await buscarOddsFixture(j.fixtureId, data);
    // Alinhado com fallback: exige mercado do grupo MERCADOS_APOSTAVEL com odd 1.25–5.00
    const temMercadoValido = odds && temMercadoApostavel(odds);
    if (temMercadoValido) {
      j._odds = odds; // armazena para reutilizar sem depender de lookup por nome no post-IA
      jogosComOdds.push(j);
    } else if (isPriAlta) {
      // Série A, Série B e Copa do Mundo sempre entram, odds ou não
      console.log(`  ⚠️ ${j.time_casa} x ${j.time_fora} (pri=${j.pri}) sem odds mas incluído por prioridade`);
      jogosComOdds.push(j);
    } else {
      jogosSemOdds.push(j);
      console.log(`  ✂️ ${j.time_casa} x ${j.time_fora} (${j.liga}) removido — sem odds na API`);
    }
  }

  console.log(`  ✅ ${jogosComOdds.length} com odds | ✂️ ${jogosSemOdds.length} sem odds removidos`);

  // Se removemos candidatos e ficamos abaixo da meta, buscar mais do pool complementar
  if (jogosComOdds.length < metaJogos) {
    // Normaliza a chave para cobrir tanto timeCasa (camelCase) quanto time_casa (snake_case)
    const normKey = j => `${j.timeCasa||j.time_casa||''}-${j.timeFora||j.time_fora||''}`;
    const jaIncluidos = new Set(jogosComOdds.map(normKey));
    const jaRemovidos = new Set(jogosSemOdds.map(j => j.fixtureId));
    const extras = Array.from(jogosComp.values())
      .filter(j => !timesIgnorar.has((j.timeCasa||j.time_casa||'').toLowerCase()) && !timesIgnorar.has((j.timeFora||j.time_fora||'').toLowerCase()))
      .filter(j => !jaIncluidos.has(normKey(j)) && !jaRemovidos.has(j.fixtureId))
      .sort((a, b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

    console.log(`  🔄 Buscando ${metaJogos - jogosComOdds.length} candidatos extras com odds...`);
    for (const j of extras) {
      if (jogosComOdds.length >= metaJogos + 5) break;
      if (!j.fixtureId) continue;
      const odds = await buscarOddsFixture(j.fixtureId, data);
      // Mesma verificação rigorosa: exige ao menos 1 mercado relevante ≥ 1.25
      const temMercado = odds && temMercadoApostavel(odds);
      if (temMercado) {
        j._odds = odds; // armazena para reutilizar no post-IA
        jogosComOdds.push(j);
        console.log(`  ➕ ${j.time_casa||j.timeCasa} x ${j.time_fora||j.timeFora} (${j.liga}) adicionado`);
      } else {
        console.log(`  ✂️ ${j.time_casa||j.timeCasa} x ${j.time_fora||j.timeFora} (${j.liga}) extras — sem mercado válido`);
      }
    }
  }

  jogos = jogosComOdds;
  console.log(`  📋 Pool final: ${jogos.length} candidatos com odds confirmadas`);

  // Margem mínima de 10 candidatos extras para absorver falhas pós-IA
  // Para metaJogos pequenos (complemento), garante candidatos suficientes
  // Buffer: jogos extras para absorver falhas de odds pós-IA.
  // Era metaJogos*3 (até 45 candidatos para meta=15) → muito caro no multi-agente (5 calls/jogo).
  // Reduzido para flat +8: cobre ~53% de descarte sem explodir custo.
  const MARGEM_RESERVA = 8;
  const totalComMargem = Math.min(metaJogos + MARGEM_RESERVA, jogos.length);
  jogos = jogos.slice(0, totalComMargem);

  // Lote 1: primeiros 4 (Sonnet + web_search — só jogos top-priority) | Lote 2: resto (Haiku)
  const LOTE = 4;
  const lote1 = jogos.slice(0, LOTE);
  const lote2 = jogos.slice(LOTE);
  console.log(`  Lotes: ${lote1.length} (Sonnet) + ${lote2.length} (Haiku) = ${jogos.length} jogos (meta: ${metaJogos} + ${MARGEM_RESERVA} reservas)`);

  let jogosResultado = [];

  // Normalizar formato alternativo que a IA às vezes retorna para "nao_recomendado"
  // Ex: { status: 'nao_recomendado', aposta_se_forcado: '...', confianca_alternativa: '...', razao_alternativa: '...' }
  function normalizarFormatoAlternativo(j) {
    if (!j) return j;
    if (j.status === 'nao_recomendado' && j.aposta_se_forcado) {
      console.log(`  🔧 Normalizando formato alternativo: ${j.time_casa} x ${j.time_fora} → ${j.aposta_se_forcado}`);
      // Tentar inferir o mercado a partir do texto da aposta
      const ap = j.aposta_se_forcado.toLowerCase();
      let mercado = j.mercado_evitar;
      if (ap.includes('vence') || ap.includes('empat') || ap.includes('dupla') || ap.includes('chance')) mercado = 'resultado';
      else if (ap.includes('escantei')) mercado = 'escanteios';
      else if (ap.includes('cart')) mercado = 'cartoes';
      else if (ap.includes('gol') || ap.includes('over') || ap.includes('under')) mercado = 'gols';
      return {
        ...j,
        aposta: j.aposta_se_forcado,
        mercado: mercado || 'resultado',
        confianca: j.confianca_alternativa || 'baixa',
        justificativa: j.razao_alternativa || j.razao_principal || 'Análise sem padrão de mercado claro.',
        razao_escolha: j.razao_principal || j.motivo_evitar || '',
      };
    }
    return j;
  }

  // Validar se o jogo tem os campos essenciais preenchidos pela IA
  function validarCamposEssenciais(j) {
    if (!j) return false;
    if (!j.aposta || j.aposta === 'undefined' || j.aposta.trim() === '') return false;
    if (!j.mercado || j.mercado === 'undefined') return false;
    if (!j.justificativa || j.justificativa === '-' || j.justificativa.trim() === '') return false;
    return true;
  }

  const prompt1 = montarPrompt(montarListaJogos(lote1, 0), blocoMem, df);
  console.log(`\n🤖 Lote 1: ${lote1.length} jogos...`);
  const txt1 = await chamarIAComBusca(prompt1, 8000);
  
  if (txt1) {
    try {
      const s1 = txt1.indexOf('{'), e1 = txt1.lastIndexOf('}');
      if (s1 !== -1) {
        const r1 = JSON.parse(txt1.slice(s1, e1+1));
        const jogos1Validos = (r1.jogos || []).map(normalizarFormatoAlternativo).filter(validarCamposEssenciais);
        const inv1 = (r1.jogos?.length || 0) - jogos1Validos.length;
        if (inv1 > 0) console.log(`  🗑️  ${inv1} jogo(s) do lote 1 descartado(s) — campos essenciais ausentes`);
        jogosResultado = [...jogos1Validos];
        console.log(`✅ Lote 1: ${jogosResultado.length} apostas geradas`);
      }
    } catch(e) { console.error('❌ Erro parse lote 1:', e.message); }
  } else {
    console.error('❌ Lote 1: sem resposta da IA');
  }

  if (lote2.length > 0) {
    console.log(`\n⏳ Aguardando 60s antes do lote 2 (rate limit)...`);
    await sleep(60000);
    console.log(`\n🤖 Lote 2: ${lote2.length} jogos (Haiku, sublotes de 5)...`);

    // Função auxiliar para parse robusto de JSON
    function parseJogos(txt) {
      if (!txt) return null;
      try {
        const s = txt.indexOf('{"jogos"') !== -1 ? txt.indexOf('{"jogos"') : txt.indexOf('{');
        const e = txt.lastIndexOf('}');
        if (s === -1 || e === -1) return null;
        const r = JSON.parse(txt.slice(s, e+1));
        return r.jogos || [];
      } catch(err) { return null; }
    }

    // Sublotes fixos de 5 jogos — prompt completo, tamanho controlado
    const TAMANHO_SUBLOTE = 3;
    const sublotes = [];
    for (let i = 0; i < lote2.length; i += TAMANHO_SUBLOTE) {
      sublotes.push(lote2.slice(i, i + TAMANHO_SUBLOTE));
    }
    console.log(`  Dividido em ${sublotes.length} sublote(s) de até ${TAMANHO_SUBLOTE} jogos`);

    let offsetAtual = LOTE;
    for (const [si, sublote] of sublotes.entries()) {
      if (si > 0) await sleep(15000);
      const ptS = montarPrompt(montarListaJogos(sublote, offsetAtual), blocoMem, df);
      const txS = await chamarIA(ptS, 6000);
      const jogosS = parseJogos(txS);
      if (jogosS === null || jogosS.length === 0) {
        // Parse falhou OU retornou array vazio — tentar jogo a jogo com prompt completo
        console.log(`  ⚠️ Sublote ${si+1} falhou (${jogosS === null ? 'parse nulo' : 'array vazio'}) — tentando jogo a jogo...`);
        for (const [ji, jogoUnico] of sublote.entries()) {
          await sleep(5000);
          const ptU = montarPrompt(montarListaJogos([jogoUnico], offsetAtual + ji), blocoMem, df);
          const txU = await chamarIA(ptU, 3000);
          const jogosU = parseJogos(txU)?.map(normalizarFormatoAlternativo).filter(validarCamposEssenciais);
          if (jogosU?.length) {
            jogosResultado = [...jogosResultado, ...jogosU];
            console.log(`  ✅ Jogo ${offsetAtual + ji + 1}: ${jogoUnico.timeCasa} x ${jogoUnico.timeFora}`);
          } else {
            console.log(`  🗑️  Jogo ${offsetAtual + ji + 1} descartado: ${jogoUnico.timeCasa} x ${jogoUnico.timeFora} — resposta inválida/incompleta`);
          }
        }
      } else {
        const jogosValidos = jogosS.map(normalizarFormatoAlternativo).filter(validarCamposEssenciais);
        const invalidos = jogosS.length - jogosValidos.length;
        if (invalidos > 0) console.log(`  🗑️  ${invalidos} jogo(s) descartado(s) do sublote ${si+1} — campos essenciais ausentes`);
        jogosResultado = [...jogosResultado, ...jogosValidos];
        console.log(`  ✅ Sublote ${si+1}: ${jogosValidos.length} apostas`);
      }
      offsetAtual += sublote.length;
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
      let fixtureId = fixtureMap.get(key) || null;
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

  // Mapa de odds pré-validadas por fixtureId — garante que o post-IA sempre
  // tem as odds corretas mesmo quando o lookup por nome da IA falha
  const oddsPrevalidadas = new Map();
  for (const jg of jogos) {
    if (jg.fixtureId && jg._odds) oddsPrevalidadas.set(jg.fixtureId, jg._odds);
  }
  console.log(`\n💰 Odds pré-validadas disponíveis: ${oddsPrevalidadas.size} fixtures`);

  // Buscar odds reais — mínima 1.25, confiança alta obrigatória
  const poucosJogosDia = jogos.length < LIMITE_JOGOS_MUITOS;
  console.log(`💰 Buscando odds reais — mínima 1.25, confiança alta | dia ${poucosJogosDia ? 'com poucos' : 'com muitos'} jogos (${jogos.length} disponíveis)...`);
  const descartados = []; // { jogo, motivo, oddsFixture }

  if (resultado.jogos) {
    for (const jogo of resultado.jogos) {
      if (!jogo.fixtureId) continue;
      // Usa odds pré-validadas primeiro (bypass do problema de nome mal casado pela IA)
      // só busca na API se não encontrar no mapa local
      const oddsFixture = oddsPrevalidadas.get(jogo.fixtureId)
        || await buscarOddsFixture(jogo.fixtureId, data);
      const motivo = aplicarOddsEPivotar(jogo, oddsFixture);
      if (motivo) descartados.push({ jogo, motivo, oddsFixture });
    }

    // Re-analisar descartados sempre que faltar jogos ativos para atingir a meta
    const ativosAposOdds = resultado.jogos.filter(j => !j.descartado).length;
    if (descartados.length > 0 && ativosAposOdds < metaJogos) {
      console.log(`\n🔄 Apenas ${ativosAposOdds}/${metaJogos} jogos ativos — re-analisando ${descartados.length} descartado(s) com mercados disponíveis...`);
      for (const { jogo, motivo, oddsFixture } of descartados) {
        if (!oddsFixture) { console.log(`  ⏭️ ${jogo.time_casa} x ${jogo.time_fora}: sem odds disponíveis`); continue; }
        const mercadosDisp = formatarMercadosDisponiveisParaIA(oddsFixture);
        const isPrioritarioReanalise = jogo.pri != null && jogo.pri < 60;
        console.log(`  🔍 Re-analisando ${jogo.time_casa} x ${jogo.time_fora} | motivo: ${motivo}`);

        // ── Agente 1: mercados completos (gols, resultado, escanteios, cartões) ──
        const promptReanalise = `Jogo: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga}, ${jogo.horario})
Motivo do descarte anterior: ${motivo}
${isPrioritarioReanalise ? '\n⚠️ LIGA PRIORITÁRIA — você DEVE encontrar uma aposta válida. Há mercados disponíveis acima.' : ''}

Mercados DISPONÍVEIS na API com odd ≥ 1.25 (SOMENTE esses existem para apostar):
${mercadosDisp}

Dados: forma casa ${jogo.forma_casa||'?'} | fora ${jogo.forma_fora||'?'} | gols ${jogo.media_gols_casa||'?'}+${jogo.media_gols_fora||'?'} | esc ${jogo.media_escanteios||'?'} | cart ${jogo.media_cartoes||'?'}

MISSÃO: Escolha a MELHOR aposta da lista acima. ${isPrioritarioReanalise ? 'Aceite confiança "media" se necessário.' : 'Confiança ALTA, odd ≥ 1.25.'}
Use mercado "gols" para gols, "resultado" para resultado/dupla chance, "escanteios" para cantos, "cartoes" para cartões.
Para 1º tempo use "gols" com "Primeiro Tempo" no texto da aposta (ex: "Over 0.5 gols - Primeiro Tempo").
Para 2º tempo use "gols" com "Segundo Tempo" no texto da aposta (ex: "Over 1.5 gols - Segundo Tempo").

IMPORTANTE: A aposta deve usar termos presentes na lista de mercados acima para que a odd seja confirmada.

Retorne JSON: {"aposta":"...","mercado":"gols|resultado|escanteios|cartoes","confianca":"alta|media","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;

        const aplicarNovaAposta = async (nova) => {
          const confOk = nova.confianca === 'alta' || (isPrioritarioReanalise && nova.confianca === 'media');
          if (!nova.aposta || !nova.mercado || !confOk) return false;

          // Tentativa 1: selecionarOddFixture padrão
          let oddNum = null;
          const oddReal = selecionarOddFixture(oddsFixture, nova.aposta, nova.mercado, jogo.time_casa, jogo.time_fora);
          if (oddReal) oddNum = parseFloat(oddReal);

          // Tentativa 2: lookup direto por texto na chave (fallback para mercados exóticos / 1º-2º tempo)
          if ((!oddNum || oddNum < ODD_MINIMA) && oddsFixture) {
            const normAposta = (nova.aposta || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
            const directMatch = Object.entries(oddsFixture).find(([k, v]) => {
              if (v < ODD_MINIMA || v > 15) return false;
              const kn = k.toLowerCase();
              // Checar se a chave contém palavras-chave da aposta
              const palavras = normAposta.split(/\s+/).filter(p => p.length > 2);
              return palavras.length > 0 && palavras.filter(p => kn.includes(p)).length >= Math.ceil(palavras.length * 0.5);
            });
            if (directMatch) {
              oddNum = parseFloat(directMatch[1]);
              console.log(`  🔎 Lookup direto: ${directMatch[0]} @ ${oddNum}`);
            }
          }

          if (oddNum && oddNum >= ODD_MINIMA) {
            jogo.aposta_original = jogo.aposta; jogo.mercado_original = jogo.mercado;
            jogo.aposta = nova.aposta; jogo.mercado = nova.mercado;
            jogo.odd_mercado = oddNum; jogo.confianca = nova.confianca || 'alta';
            jogo.descartado = false; jogo.analisando = false; jogo.descartado_motivo = null;
            jogo.justificativa = nova.justificativa || nova.razao || jogo.justificativa;
            console.log(`  ✅ Re-análise OK: ${nova.aposta} (${nova.mercado}) @ ${oddNum} [${jogo.confianca}]`);
            return true;
          }
          console.log(`  ⚠️ "${nova.aposta}" (${nova.mercado}) → odd não confirmada na API`);
          return false;
        };

        let resolvido = false;

        // Agente 1: re-análise geral
        try {
          const resp1 = await chamarIA(promptReanalise, 800);
          if (resp1) {
            const m1 = resp1.match(/\{[\s\S]*\}/);
            if (m1) resolvido = await aplicarNovaAposta(JSON.parse(m1[0]));
          }
        } catch(e) { console.error(`  Erro agente-1 ${jogo.time_casa}: ${e.message}`); }

        // ── Agente 2: 1º e 2º tempo — só para prioritários que ainda falharam ──
        if (!resolvido && isPrioritarioReanalise) {
          const mercados1t2t = Object.entries(oddsFixture)
            .filter(([k,v]) => v >= ODD_MINIMA && v <= 10 &&
              (k.includes('first half') || k.includes('1st half') || k.includes('second half') || k.includes('2nd half') || k.includes('halftime')))
            .map(([k,v]) => `  ${k}: ${v}`).join('\n');

          if (mercados1t2t) {
            console.log(`  ⏱️ Agente 1º/2º tempo: ${jogo.time_casa} x ${jogo.time_fora}`);
            const prompt2t = `Jogo: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga})
Dados: gols/jogo casa=${jogo.media_gols_casa||'?'} fora=${jogo.media_gols_fora||'?'} | forma casa=${jogo.forma_casa||'?'} fora=${jogo.forma_fora||'?'}

Mercados de 1º e 2º TEMPO disponíveis na API (odd ≥ 1.25):
${mercados1t2t}

MISSÃO: Escolha a melhor aposta de 1º OU 2º tempo para este jogo.
- resultado_1t: vencedor do 1º tempo (home/draw/away)
- resultado_2t: vencedor do 2º tempo
- gols com "Primeiro Tempo" ou "Segundo Tempo" explícito na aposta

Retorne JSON: {"aposta":"...","mercado":"resultado_1t|resultado_2t|gols","confianca":"alta|media","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
            try {
              const resp2 = await chamarIA(prompt2t, 600);
              if (resp2) {
                const m2 = resp2.match(/\{[\s\S]*\}/);
                if (m2) resolvido = await aplicarNovaAposta(JSON.parse(m2[0]));
              }
            } catch(e) { console.error(`  Erro agente-2t ${jogo.time_casa}: ${e.message}`); }
          }
        }

        // ── Agente 3: combo fallback — resultado + gols para prioritários ──
        if (!resolvido && isPrioritarioReanalise) {
          const mercadosCombo = Object.entries(oddsFixture)
            .filter(([k,v]) => v >= ODD_MINIMA && v <= 10 &&
              (k.includes('result') && (k.includes('total') || k.includes('goal') || k.includes('btts'))))
            .map(([k,v]) => `  ${k}: ${v}`).join('\n');

          if (mercadosCombo) {
            console.log(`  🔗 Agente combo: ${jogo.time_casa} x ${jogo.time_fora}`);
            const promptCombo = `Jogo: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga})
Dados: gols/jogo=${jogo.media_gols_casa||'?'}+${jogo.media_gols_fora||'?'} forma casa=${jogo.forma_casa||'?'} fora=${jogo.forma_fora||'?'}

Mercados COMBO disponíveis (resultado + gols):
${mercadosCombo}

MISSÃO: Escolha o melhor combo disponível acima.
Use mercado "combo" e formato de aposta: "[time] vence e over X.X gols" ou "[time] vence e BTTS".
Exemplo: "Argentina vence e over 2.5 gols"

Retorne JSON: {"aposta":"...","mercado":"combo","confianca":"alta|media","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
            try {
              const resp3 = await chamarIA(promptCombo, 600);
              if (resp3) {
                const m3 = resp3.match(/\{[\s\S]*\}/);
                if (m3) resolvido = await aplicarNovaAposta(JSON.parse(m3[0]));
              }
            } catch(e) { console.error(`  Erro agente-combo ${jogo.time_casa}: ${e.message}`); }
          } else {
            // Sem combo disponível na API — tentar sugerir combo com base nos dados mesmo sem chave específica
            console.log(`  ⚠️ Nenhum mercado combo disponível para ${jogo.time_casa} x ${jogo.time_fora}`);
          }
        }

        if (!resolvido) {
          console.log(`  ❌ ${isPrioritarioReanalise ? '[PRIORITÁRIO] ' : ''}${jogo.time_casa} x ${jogo.time_fora}: sem mercado válido após todos os agentes`);
        }
      }
    } else if (descartados.length > 0) {
      console.log(`\n📋 ${ativosAposOdds}/${metaJogos} jogos ativos — ${descartados.length} descartado(s) sem re-análise (meta atingida):`);
      descartados.forEach(({ jogo, motivo }) => console.log(`  🗑️ ${jogo.time_casa} x ${jogo.time_fora}: ${motivo}`));
    }

    console.log(`✅ Odds reais aplicadas`);
  }

  // Calcular "score" de probabilidade para apostas de Over/Under baseado nas médias do jogo
  // Usado para comparar alternativas quando todas têm a mesma confiança (ex: baixa vs baixa)
  function calcularScoreProbabilidade(aposta, mercado, jogo) {
    if (!aposta) return 0;
    const ap = aposta.toLowerCase();
    const mediaGols = (parseFloat(jogo.media_gols_casa) || 0) + (parseFloat(jogo.media_gols_fora) || 0);
    const mediaEsc = parseFloat(jogo.media_escanteios) || 0;
    const mediaCart = parseFloat(jogo.media_cartoes) || 0;

    const m = ap.match(/([\d.]+)/);
    const linha = m ? parseFloat(m[1]) : null;
    if (linha === null) return 0;

    let media = mercado === 'gols' ? mediaGols : mercado === 'escanteios' ? mediaEsc : mercado === 'cartoes' ? mediaCart : 0;
    if (!media) return 0;

    // Distância da média até a linha — quanto maior a folga, maior a probabilidade
    if (ap.includes('over') || ap.includes('mais')) {
      return media - linha; // positivo = média acima da linha = mais provável
    }
    if (ap.includes('under') || ap.includes('menos')) {
      return linha - media; // positivo = linha acima da média = mais provável
    }
    return 0;
  }



  // ── Pós-processamento: pivotar para confiança alta, descartar complementares sem opção ──────────
  const jogosFinais = [];
  for (const jogo of resultado.jogos) {
    const confAtual = jogo.confianca || 'media';
    const isComplementar = (jogo.pri || 99) >= 60; // pri >= 60 = complementar

    // Sem alternativas — manter se tem mercado definido (confiança baixa é aceitável para complementar)
    if (!jogo.alternativas?.length) {
      if (!jogo.aposta || !jogo.mercado) {
        console.log(`  🗑️  Descartando complementar sem mercado: ${jogo.time_casa} x ${jogo.time_fora}`);
        continue;
      }
      jogosFinais.push(jogo);
      continue;
    }

    // Aposta alta → nunca pivota, mantém
    if (confAtual === 'alta') { jogosFinais.push(jogo); continue; }

    // Buscar melhor alternativa
    const confAlvo = ['nao_recomendado', 'baixa'].includes(confAtual) ? ['alta', 'media'] : ['alta'];
    const melhor = jogo.alternativas.find(a => confAlvo.includes(a.confianca) && a.aposta);

    if (melhor) {
      // Tem alternativa melhor — pivotar
      const motivo = ['nao_recomendado','baixa'].includes(confAtual) ? `${confAtual} → pivotando` : 'buscando alta confiança';
      console.log(`  ⚡ Pivotando (${motivo}): ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} [${confAtual}] → ${melhor.aposta} [${melhor.mercado}] (${melhor.confianca})`);
      jogo.aposta_original = jogo.aposta_original || jogo.aposta;
      jogo.mercado_original = jogo.mercado_original || jogo.mercado;
      jogo.aposta = melhor.aposta;
      jogo.mercado = melhor.mercado;
      jogo.confianca = melhor.confianca;
      jogo.razao_escolha = `Pivotado (${motivo}): ${melhor.razao}`;
      jogo.justificativa = gerarJustificativaPosPivot(melhor.aposta, melhor.mercado, melhor.razao, jogo);
      jogosFinais.push(jogo);
    } else if (isComplementar && ['nao_recomendado', 'baixa'].includes(confAtual)) {
      // Sem alta/media disponível — comparar entre as opções baixa/nao_recomendado por probabilidade matemática
      const candidatosBaixa = jogo.alternativas.filter(a => ['baixa','nao_recomendado'].includes(a.confianca) && a.aposta);
      const atualScore = calcularScoreProbabilidade(jogo.aposta, jogo.mercado, jogo);
      let melhorBaixa = null, melhorScore = atualScore;
      for (const a of candidatosBaixa) {
        if (a.mercado === jogo.mercado && a.aposta === jogo.aposta) continue;
        const score = calcularScoreProbabilidade(a.aposta, a.mercado, jogo);
        if (score > melhorScore) { melhorScore = score; melhorBaixa = a; }
      }
      if (melhorBaixa) {
        console.log(`  📐 Pivotando por probabilidade matemática: ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} (score ${atualScore.toFixed(2)}) → ${melhorBaixa.aposta} (score ${melhorScore.toFixed(2)})`);
        jogo.aposta_original = jogo.aposta_original || jogo.aposta;
        jogo.mercado_original = jogo.mercado_original || jogo.mercado;
        jogo.aposta = melhorBaixa.aposta;
        jogo.mercado = melhorBaixa.mercado;
        jogo.razao_escolha = `Pivotado por probabilidade (${melhorBaixa.razao})`;
        jogo.justificativa = gerarJustificativaPosPivot(melhorBaixa.aposta, melhorBaixa.mercado, melhorBaixa.razao, jogo);
      }
      console.log(`  ⚠️  Complementar sem opção boa: ${jogo.time_casa} x ${jogo.time_fora} — guardando como reserva baixa`);
      jogo._reservaBaixa = true;
      jogosFinais.push(jogo); // mantém mas marcado
    } else {
      // Prioritário ou media sem alta disponível → mantém
      if (confAtual === 'media') console.log(`  ℹ️  Mantendo média: ${jogo.time_casa} x ${jogo.time_fora} — sem alternativa alta disponível`);
      jogosFinais.push(jogo);
    }
  }

  // Ordenar: alta e média primeiro, baixa (reserva) por último
  jogosFinais.sort((a, b) => {
    const ordem = { alta: 0, media: 1, baixa: 2, nao_recomendado: 3 };
    const oa = ordem[a.confianca] ?? 2;
    const ob = ordem[b.confianca] ?? 2;
    if (oa !== ob) return oa - ob;
    return (a.pri || 99) - (b.pri || 99); // dentro do mesmo nível, melhor pri primeiro
  });

  // Cortar para metaJogos — baixa confiança só entra se necessário para completar
  resultado.jogos = jogosFinais.slice(0, metaJogos);
  const usouBaixa = resultado.jogos.filter(j => j._reservaBaixa).length;
  if (usouBaixa > 0) {
    console.log(`  ⚠️  ${usouBaixa} jogo(s) de baixa confiança incluídos por falta de opção melhor`);
  }
  const totalDescartados = jogosFinais.length - resultado.jogos.length;
  if (totalDescartados > 0) {
    console.log(`  ✂️  Cortando ${totalDescartados} reservas extras`);
  }

  // Log distribuição final
  const distConf = jogosFinais.reduce((acc, j) => {
    const c = j.confianca || 'media';
    acc[c] = (acc[c] || 0) + 1; return acc;
  }, {});
  console.log(`  📊 Distribuição por confiança: ${Object.entries(distConf).map(([c,n])=>`${c}:${n}`).join(' | ')}${totalDescartados > 0 ? ` | descartados: ${totalDescartados}` : ''}`);

  // Reatribuir id sequencial — a IA reinicia a numeração em cada chamada/sublote,
  // causando ids duplicados (ex: vários jogos com id:1). Garante id único 1..N.
  resultado.jogos.forEach((j, idx) => { j.id = idx + 1; });

  return resultado;
}

// ─── Multi-agente: utilitários ──────────────────────────────

function filtrarMemoria(blocoMem, palavrasChave) {
  if (!blocoMem) return '';
  return blocoMem.split('\n')
    .filter(l => palavrasChave.some(p => l.toLowerCase().includes(p)))
    .join('\n');
}

async function chamarIASonnet(prompt, maxTokens = 4000) {
  const modelos = ['claude-sonnet-4-5', 'claude-3-5-sonnet-20241022'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
      });
      const json = await res.json();
      if (!json.error) {
        registrarCusto(modelo, json.usage?.input_tokens || 2000, json.usage?.output_tokens || 500);
        return (json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
      }
    } catch(e) {}
  }
  return chamarIA(prompt, maxTokens);
}

// ─── Multi-agente: carregador de fixtures ───────────────────

async function _carregarFixturesComStats(data, horaMin, metaJogos, timesIgnorar) {
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;
  const fixtures = await buscarFixturesPorData(data);
  const jogosMap = new Map(), jogosComp = new Map();

  for (const f of fixtures) {
    const ts = f.fixture?.timestamp, status = f.fixture?.status?.short, ligaId = f.league?.id;
    const timeCasa = f.teams?.home?.name, timeFora = f.teams?.away?.name;
    if (!ts || !timeCasa || !timeFora || status !== 'NS') continue;
    const ligaNome = f.league?.name || '';
    const subRegex = /\bU(1[7-9]|20)\b/i;
    if (subRegex.test(timeCasa) || subRegex.test(timeFora) || subRegex.test(ligaNome)) continue;
    const ligaLower = ligaNome.toLowerCase();
    if (ligaLower.includes('amateur') || ligaLower.includes('reserve') || ligaLower.includes('youth')) continue;
    const dt = new Date(ts * 1000);
    let hBR = dt.getUTCHours() - 3; const mBR = dt.getUTCMinutes();
    if (hBR < 0) hBR += 24;
    const totalMin = hBR * 60 + mBR;
    if (totalMin < minMinutos || (hBR >= 1 && hBR < 10)) continue;
    const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
    const key = `${timeCasa}-${timeFora}`, pais = f.league?.country || '';
    if (LIGAS_IGNORAR.has(ligaId) || ligaBrasileiraNaoRelevante(ligaNome, pais)) continue;
    const ligaMatch = LIGAS_PRIORITY[ligaId];
    if (ligaMatch) {
      let priFinal = ligaMatch.pri;
      if (ligaMatch.pri === 3) priFinal = 3;
      else if (ligaMatch.pri === 5 && !isTimesChampions(timeCasa, timeFora)) priFinal = 6;
      else if (ligaMatch.selecaoCampea) { if (!isSelecaoCampea(timeCasa, timeFora)) continue; }
      if (!jogosMap.has(key)) { dbSaveLiga(ligaMatch.nome, ligaId, pais).catch(()=>{}); jogosMap.set(key, { liga: ligaMatch.nome, tipo: ligaMatch.tipo, pri: priFinal, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id }); }
    } else {
      const paisLower = pais.toLowerCase(), isWorldLeague = paisLower === 'world';
      if (!isWorldLeague && PAISES_IGNORAR_COMP.has(paisLower)) continue;
      if (isWorldLeague) { const priWorld = (ligaNome.toLowerCase().includes('friendly')||ligaNome.toLowerCase().includes('international')) ? 85 : 150; if (!jogosComp.has(key)) jogosComp.set(key, { liga: ligaNome, tipo: 'copa', pri: priWorld, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id }); continue; }
      let priComp = 200, tipoComp = 'other';
      const EUROPEUS = ["england","scotland","spain","italy","france","germany","portugal","netherlands","belgium","turkey","austria","switzerland","denmark","norway","croatia","serbia","ukraine","greece","russia","poland","czech-republic","finland","sweden","hungary","romania","slovakia","bulgaria","georgia","albania","armenia","estonia","latvia","lithuania","luxembourg","malta","wales","ireland","iceland","cyprus","north macedonia","montenegro","kosovo","andorra","faroe islands","gibraltar","bosnia"];
      const SUL_AMERICANOS = ["argentina","colombia","chile","uruguay","peru","venezuela","bolivia","ecuador","paraguay"];
      const AFRICA_ORIENTE = ["egypt","morocco","algeria","tunisia","saudi-arabia","uae","qatar","kuwait","jordan","iran","nigeria","ghana","senegal","ivory coast","cameroon","south africa"];
      const CONCACAF = ["canada","usa","mexico","costa rica","honduras","el salvador","guatemala","panama","jamaica","trinidad and tobago"];
      if (EUROPEUS.includes(paisLower)) { tipoComp = 'eu'; priComp = isTimesEuropaB(timeCasa, timeFora) ? 50 : 90; }
      else if (SUL_AMERICANOS.includes(paisLower)) { tipoComp = 'sul'; priComp = 70; }
      else if (CONCACAF.includes(paisLower)) { tipoComp = 'concacaf'; priComp = 75; }
      else if (AFRICA_ORIENTE.includes(paisLower)) { tipoComp = 'af'; priComp = 80; }
      else if (paisLower === 'brazil' || paisLower === 'brasil') { tipoComp = 'b'; priComp = 60; }
      if (!jogosComp.has(key)) { dbSaveLiga(`${ligaNome} (${pais})`, ligaId, pais).catch(()=>{}); jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: tipoComp, pri: priComp, timeCasa, timeFora, horario: hStr, fixtureId: f.fixture?.id, ligaId, teamCasaId: f.teams?.home?.id, teamForaId: f.teams?.away?.id }); }
    }
  }

  const todasLigaIds = [...new Set([...jogosMap.values(), ...jogosComp.values()].map(j => j.ligaId).filter(Boolean))];
  const ligaStatsMap = new Map();
  if (todasLigaIds.length > 0) {
    try {
      const resL = await fetch(`${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=in.(${todasLigaIds.join(',')})&select=liga_id,nome,green,red,total,mercados,media_escanteios,media_cartoes,amostras_escanteios,amostras_cartoes,cobertura_por_dia,tentativas_total,sucessos_total`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      for (const row of (await resL.json() || [])) { if (row.total >= 3) ligaStatsMap.set(row.liga_id, { ...row, assertividade: Math.round((row.green / row.total) * 100) }); }
    } catch(e) {}
  }

  const memoria = await buscarMemoria();
  let blocoMem = memoria ? `\nHISTÓRICO DE CALIBRAÇÃO:\n${memoria.substring(0,3000)}\n` : '';
  if (ligaStatsMap.size > 0) {
    let blocoLigas = '\nASSERTIVIDADE HISTÓRICA POR LIGA:\n';
    for (const [lid, st] of ligaStatsMap) {
      const merc = Object.entries(st.mercados || {}).filter(([,m]) => (m.green+m.red) >= 2).map(([nm,m]) => { const tot=m.green+m.red; return `${nm}:${Math.round((m.green/tot)*100)}%(${m.green}G/${m.red}R)`; }).join(' ');
      blocoLigas += `  Liga ${lid} (${st.nome||'?'}): geral ${st.assertividade}%${merc ? ' — '+merc : ''}\n`;
    }
    blocoMem = (blocoMem||'') + blocoLigas;
  }

  for (const [, jogo] of jogosComp) {
    const st = ligaStatsMap.get(jogo.ligaId);
    if (st) {
      if (st.assertividade >= 80) jogo.pri = Math.min(jogo.pri, 60);
      else if (st.assertividade >= 70) jogo.pri = Math.min(jogo.pri, 70);
      else if (st.assertividade >= 60) jogo.pri = Math.min(jogo.pri, 80);
      else if (st.assertividade < 40 && st.total >= 5) jogo.pri = Math.max(jogo.pri, 180);
    }
  }

  let jogos = Array.from(jogosMap.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));
  if (timesIgnorar.size > 0) jogos = jogos.filter(j => !timesIgnorar.has(j.timeCasa?.toLowerCase()) && !timesIgnorar.has(j.timeFora?.toLowerCase()));
  if (jogos.length < metaJogos) {
    const dowHoje = new Date().getDay(); // 0=Dom ... 6=Sáb
    const cobScore = j => {
      const st = ligaStatsMap.get(j.ligaId);
      const cob = st?.cobertura_por_dia?.[String(dowHoje)];
      return typeof cob === 'number' ? cob : -1;
    };
    const compOrdenado = Array.from(jogosComp.values()).sort((a,b) => {
      if (a.pri !== b.pri) return a.pri - b.pri;
      const ca = cobScore(a), cb = cobScore(b);
      if (ca >= 0 && cb >= 0) return cb - ca;
      if (ca >= 0) return ca > 0 ? -1 : 1;
      if (cb >= 0) return cb > 0 ? 1 : -1;
      return a.horario.localeCompare(b.horario);
    });
    const compFiltrado = []; let cont13h = 0;
    for (const j of compOrdenado) {
      if (timesIgnorar.size > 0 && (timesIgnorar.has(j.timeCasa?.toLowerCase()) || timesIgnorar.has(j.timeFora?.toLowerCase()))) continue;
      if (j.horario === '13:00') { cont13h++; if (cont13h <= 4) compFiltrado.push(j); } else compFiltrado.push(j);
    }
    jogos = [...jogos, ...compFiltrado.slice(0, Math.max(15, (metaJogos - jogos.length) * 3))];
  }
  if (!jogos.length) return null;

  const MARGEM = 8;
  jogos = jogos.slice(0, Math.min(metaJogos + MARGEM, jogos.length));

  // ── Pré-filtro de odds: só descartar complementares sem cobertura na Odds API ───────
  // Ligas prioritárias (pri ≤ 10: Série A/B, Copas) NUNCA são descartadas por falta de odds
  const LIGAS_PRIORITARIAS_TIPOS = new Set(['a','b','copa']);
  const jogosComOdds = [], jogosSemOdds = [];
  const dowHojeFiltro = new Date().getDay();
  await Promise.all(jogos.map(async j => {
    const isPrioritaria = (j.pri != null && j.pri <= 10) || LIGAS_PRIORITARIAS_TIPOS.has(j.tipo);
    if (!j.fixtureId || isPrioritaria) { jogosComOdds.push(j); return; }
    const odds = await buscarOddsFixture(j.fixtureId, data).catch(() => null);
    if (odds) jogosComOdds.push(j);
    else jogosSemOdds.push(j);
    // Atualizar cobertura por dia em background via RPC (fire-and-forget)
    if (j.ligaId) {
      fetch(`${SUPABASE_URL}/rest/v1/rpc/atualizar_cobertura_liga`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_liga_id: j.ligaId, p_dow: dowHojeFiltro, p_tem_odds: !!odds })
      }).catch(() => {});
    }
  }));
  if (jogosSemOdds.length) {
    console.log(`⚡ Pré-filtro odds: ${jogosSemOdds.length} jogo(s) sem cobertura ignorado(s): ${jogosSemOdds.map(j=>`${j.timeCasa} x ${j.timeFora}`).join(', ')}`);
  }
  // Se sobrar abaixo da meta, aceitar jogos sem odds de volta
  jogos = jogosComOdds.length >= metaJogos ? jogosComOdds : [...jogosComOdds, ...jogosSemOdds.slice(0, metaJogos - jogosComOdds.length)];

  console.log(`\nMulti-agente — jogos selecionados: ${jogos.length}`);
  jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

  for (const f of fixtures) {
    const tCasaNome = f.teams?.home?.name, tForaNome = f.teams?.away?.name;
    const jogo = jogos.find(j => j.timeCasa === tCasaNome && j.timeFora === tForaNome);
    if (!jogo || jogo._stats) continue;
    const [statsCasa, statsFora] = await Promise.all([
      coletarEstatisticas(f.teams?.home?.id, tCasaNome, f.league?.id, f.teams?.away?.id),
      coletarEstatisticas(f.teams?.away?.id, tForaNome, f.league?.id, f.teams?.home?.id)
    ]);
    await sleep(300);
    jogo._stats = { statsCasa, statsFora };
    console.log(`  ✅ Stats: ${tCasaNome} vs ${tForaNome}`);
  }

  const ano = parseInt(data.substring(0,4)), mes = parseInt(data.substring(5,7)), dia = parseInt(data.substring(8,10));
  const df = `${String(dia).padStart(2,'0')}/${String(mes).padStart(2,'0')}/${ano}`;
  return { jogos, ligaStatsMap, blocoMem, fixtures, df };
}

// ─── Multi-agente: prompts especializados ────────────────────

function _promptAgentGols(jogo, ligaStatsMap, memGols) {
  const sc = jogo._stats?.statsCasa, sf = jogo._stats?.statsFora;
  const st = ligaStatsMap?.get(jogo.ligaId);
  const gPerf = st?.mercados?.gols;
  const ligaGols = gPerf && (gPerf.green+gPerf.red) >= 2 ? `${Math.round(gPerf.green/(gPerf.green+gPerf.red)*100)}% (${gPerf.green}G/${gPerf.red}R)` : 'sem histórico';
  return `Analise o mercado de GOLS para este jogo e retorne SOMENTE um objeto JSON válido, sem texto antes ou depois.

Jogo: ${jogo.timeCasa} x ${jogo.timeFora} | ${jogo.liga} | ${jogo.horario}
Casa: média ${sc?.mediaGols||'?'} gols/jogo | forma ${sc?.forma||'?'}
Fora: média ${sf?.mediaGols||'?'} gols/jogo | forma ${sf?.forma||'?'}
H2H: ${sc?.h2hTexto||'sem dados'}
Liga histórico gols: ${ligaGols}
${memGols ? `Memória:\n${memGols.substring(0,350)}` : ''}

Escolha as 2 melhores opções entre: Over 0.5, Over 1.5, Over 2.5, Over 3.5, Under 2.5, BTTS, Primeiro tempo com gol.
Probabilidade = número decimal entre 0.01 e 0.99. Nunca use 0 ou 1.

RESPONDA APENAS COM ESTE JSON (sem markdown, sem texto extra):
{"mercado":"gols","opcao_1":{"aposta":"Over 1.5 gols","probabilidade":0.85,"razao":"média combinada 2.8 gols, H2H 4/5 com Over 1.5"},"opcao_2":{"aposta":"Over 2.5 gols","probabilidade":0.65,"razao":"equipes ofensivas mas defesa de fora é sólida"}}`;
}

function _promptAgentResultado(jogo, ligaStatsMap, memResultado) {
  const sc = jogo._stats?.statsCasa, sf = jogo._stats?.statsFora;
  const st = ligaStatsMap?.get(jogo.ligaId);
  const rPerf = st?.mercados?.resultado;
  const ligaRes = rPerf && (rPerf.green+rPerf.red) >= 2 ? `${Math.round(rPerf.green/(rPerf.green+rPerf.red)*100)}% (${rPerf.green}G/${rPerf.red}R)` : 'sem histórico';
  return `Analise o RESULTADO deste jogo e retorne SOMENTE um objeto JSON válido, sem texto antes ou depois.

Jogo: ${jogo.timeCasa} x ${jogo.timeFora} | ${jogo.liga} | ${jogo.horario}
Casa: forma ${sc?.forma||'?'} | média gols ${sc?.mediaGols||'?'}
Fora: forma ${sf?.forma||'?'} | média gols ${sf?.mediaGols||'?'}
H2H: ${sc?.h2hTexto||'sem dados'}
Liga histórico resultado: ${ligaRes}
${memResultado ? `Memória:\n${memResultado.substring(0,350)}` : ''}

Estime as probabilidades brutas: casa_vence, empate, fora_vence (devem somar ~1.0).
Então calcule: dupla_chance_1X = casa_vence + empate, dupla_chance_X2 = fora_vence + empate.
opcao_1 = a aposta com maior probabilidade. opcao_2 = segunda maior.
Probabilidade = número decimal entre 0.01 e 0.99. Nunca use 0 ou 1.

RESPONDA APENAS COM ESTE JSON (sem markdown, sem texto extra):
{"mercado":"resultado","opcao_1":{"aposta":"Dupla Chance Casa (1X)","probabilidade":0.78,"razao":"casa forte em casa, empate frequente nessa liga"},"opcao_2":{"aposta":"Casa vence","probabilidade":0.58,"razao":"5 vitórias em 7 jogos em casa"}}`;
}

function _promptAgentEscanteios(jogo, ligaStatsMap, memEscanteios) {
  const sc = jogo._stats?.statsCasa, sf = jogo._stats?.statsFora;
  const st = ligaStatsMap?.get(jogo.ligaId);
  const ePerf = st?.mercados?.escanteios;
  const ligaEsc = ePerf && (ePerf.green+ePerf.red) >= 2 ? `${Math.round(ePerf.green/(ePerf.green+ePerf.red)*100)}% (${ePerf.green}G/${ePerf.red}R)` : 'sem histórico';
  const mediaLiga = st?.media_escanteios ? `${st.media_escanteios.toFixed(1)} (${st.amostras_escanteios||0} jogos)` : 'não disponível';
  const escC = parseFloat(sc?.mediaEscanteios)||0, escF = parseFloat(sf?.mediaEscanteios)||0;
  const mediaComb = (escC > 0 && escF > 0) ? (escC + escF).toFixed(1) : '?';
  const semDados = mediaComb === '?' && mediaLiga === 'não disponível' && ligaEsc === 'sem histórico';
  if (semDados) return `{"sem_dados":true,"razao":"Sem dados de escanteios para ${jogo.timeCasa} x ${jogo.timeFora}"}`;
  return `Analise ESCANTEIOS deste jogo e retorne SOMENTE um objeto JSON válido, sem texto antes ou depois.

Jogo: ${jogo.timeCasa} x ${jogo.timeFora} | ${jogo.liga} | ${jogo.horario}
Casa: média ${sc?.mediaEscanteios||'?'} escanteios/jogo
Fora: média ${sf?.mediaEscanteios||'?'} escanteios/jogo
Média combinada estimada: ${mediaComb}
LigaMedia real de escanteios: ${mediaLiga}
Liga histórico escanteios: ${ligaEsc}
${memEscanteios ? `Memória:\n${memEscanteios.substring(0,300)}` : ''}

REGRA: Se LigaMedia disponível e linha sugerida > LigaMedia + 1.5, use linha mais conservadora.
Se NÃO houver dados suficientes para avaliar, retorne: {"sem_dados":true,"razao":"motivo"}
Probabilidade = número decimal entre 0.01 e 0.99. Nunca use 0 ou 1. Nunca retorne texto livre.

RESPONDA APENAS COM ESTE JSON (sem markdown, sem texto extra):
{"mercado":"escanteios","opcao_1":{"aposta":"Over 8.5 escanteios","probabilidade":0.80,"razao":"média combinada 9.8, alinhada com LigaMedia"},"opcao_2":{"aposta":"Over 7.5 escanteios","probabilidade":0.88,"razao":"linha conservadora confirmada pelo histórico"}}`;
}

function _promptAgentCartoes(jogo, ligaStatsMap, memCartoes) {
  const sc = jogo._stats?.statsCasa, sf = jogo._stats?.statsFora;
  const st = ligaStatsMap?.get(jogo.ligaId);
  const cPerf = st?.mercados?.cartoes;
  const ligaCart = cPerf && (cPerf.green+cPerf.red) >= 2 ? `${Math.round(cPerf.green/(cPerf.green+cPerf.red)*100)}% (${cPerf.green}G/${cPerf.red}R)` : 'sem histórico';
  const mediaLigaCart = st?.media_cartoes ? `${st.media_cartoes.toFixed(1)} (${st.amostras_cartoes||0} jogos)` : 'não disponível';
  const cartC = parseFloat(sc?.mediaCartoes)||0, cartF = parseFloat(sf?.mediaCartoes)||0;
  const mediaComb = (cartC > 0 && cartF > 0) ? (cartC + cartF).toFixed(1) : '?';
  const semDados = mediaComb === '?' && mediaLigaCart === 'não disponível' && ligaCart === 'sem histórico';
  if (semDados) return `{"sem_dados":true,"razao":"Sem dados de cartões para ${jogo.timeCasa} x ${jogo.timeFora}"}`;
  return `Analise CARTÕES deste jogo e retorne SOMENTE um objeto JSON válido, sem texto antes ou depois.

Jogo: ${jogo.timeCasa} x ${jogo.timeFora} | ${jogo.liga} | ${jogo.horario}
Casa: média ${sc?.mediaCartoes||'?'} cartões/jogo
Fora: média ${sf?.mediaCartoes||'?'} cartões/jogo
Média combinada estimada: ${mediaComb}
LigaMedia real de cartões: ${mediaLigaCart}
Liga histórico cartões: ${ligaCart}
${memCartoes ? `Memória:\n${memCartoes.substring(0,300)}` : ''}

Avalie: Over/Under 1.5, 2.5, 3.5, 4.5, Mais cartões Casa/Fora.
Considere rivalidade e contexto (rebaixamento/título = mais cartões).
Se NÃO houver dados suficientes para avaliar, retorne: {"sem_dados":true,"razao":"motivo"}
Probabilidade = número decimal entre 0.01 e 0.99. Nunca use 0 ou 1. Nunca retorne texto livre.

RESPONDA APENAS COM ESTE JSON (sem markdown, sem texto extra):
{"mercado":"cartoes","opcao_1":{"aposta":"Over 2.5 cartões","probabilidade":0.72,"razao":"média combinada 3.4, árbitro rigoroso nessa liga"},"opcao_2":{"aposta":"Over 3.5 cartões","probabilidade":0.55,"razao":"contexto de rivalidade aumenta cartões"}}`;
}

function _promptCoordenador(jogo, ligaStatsMap, blocoMem, agentes, df) {
  const sc = jogo._stats?.statsCasa, sf = jogo._stats?.statsFora;
  const escC = parseFloat(sc?.mediaEscanteios)||0, escF = parseFloat(sf?.mediaEscanteios)||0;
  const cartC = parseFloat(sc?.mediaCartoes)||0, cartF = parseFloat(sf?.mediaCartoes)||0;
  const mediaCombEsc = (escC > 0 && escF > 0) ? (escC + escF).toFixed(1) : '?';
  const mediaCombCart = (cartC > 0 && cartF > 0) ? (cartC + cartF).toFixed(1) : '?';

  // P4: lista todos os 4 mercados — com dados reais ou marcados como SEM DADOS
  const TODOS_MERCADOS = ['gols', 'resultado', 'escanteios', 'cartoes'];
  const agMap = new Map(agentes.map(a => [a.mercado, a]));
  const blocoAg = TODOS_MERCADOS.map(m => {
    const a = agMap.get(m);
    if (!a) return `[${m.toUpperCase()}] — SEM DADOS (agente falhou — NÃO USE este mercado)`;
    const op1 = `${a.opcao_1.aposta} (${Math.round((a.opcao_1.probabilidade||0)*100)}%) — ${a.opcao_1.razao}`;
    const op2 = a.opcao_2 ? `${a.opcao_2.aposta} (${Math.round((a.opcao_2.probabilidade||0)*100)}%) — ${a.opcao_2.razao}` : 'sem opção 2';
    return `[${m.toUpperCase()}] Opção 1: ${op1} | Opção 2: ${op2}`;
  }).join('\n');

  return `COORDENADOR. Escolha a MELHOR aposta para este jogo com base nos especialistas abaixo.

JOGO: ${jogo.timeCasa} x ${jogo.timeFora} | ${jogo.liga} | tipo: ${jogo.tipo||'eu'} | ${jogo.horario} | ${df}
Casa: forma ${sc?.forma||'?'} | gols ${sc?.mediaGols||'?'} | esc ${sc?.mediaEscanteios||'?'} | cart ${sc?.mediaCartoes||'?'}
Fora: forma ${sf?.forma||'?'} | gols ${sf?.mediaGols||'?'} | esc ${sf?.mediaEscanteios||'?'} | cart ${sf?.mediaCartoes||'?'}

ANÁLISES ESPECIALIZADAS:
${blocoAg}

${blocoMem ? `MEMÓRIA DE CALIBRAÇÃO (contexto histórico):\n${blocoMem.substring(0,1200)}` : ''}

CRITÉRIOS DE DECISÃO (siga rigorosamente):
1. PROIBIDO usar mercados marcados como "SEM DADOS" — só escolha de mercados com dados reais acima
2. Prioridade: probabilidade mais alta (segurança > odd)
3. Se probabilidades similares (<5% diferença), use value = odd_real / (1/probabilidade)
4. NUNCA invente probabilidades — use APENAS os números fornecidos pelos agentes acima
5. Se melhor opção de um agente < 55%, use opcao_2 desse agente
6. confianca: alta ≥ 75% | media 55–74% | baixa < 55%
7. CAMPO alternativas: inclua APENAS mercados com dados reais acima. PROIBIDO criar uma entrada para mercado marcado "SEM DADOS" — omita-o completamente do array (nunca escreva "indisponível", "sem dados" ou similar como aposta)
8. IMPORTANTE: se forma e gols forem todos "?" (dados ausentes) mas há odds disponíveis nos agentes, defina confiança MÍNIMA "media" — há mercado válido para apostar mesmo sem histórico

CAMPO justificativa (PÚBLICO): escreva como especialista em apostas. PROIBIDO usar: "calibração", "assertividade %", "LigaMedia", "especialista", "agente", "sistema". Use apenas: forma recente, H2H, médias, contexto esportivo. 2–3 frases.

Retorne SOMENTE JSON válido:
{"time_casa":"${jogo.timeCasa}","time_fora":"${jogo.timeFora}","liga":"${jogo.liga}","tipo_liga":"${jogo.tipo||'eu'}","horario":"${jogo.horario}","aposta":"Over 1.5 gols","mercado":"gols","confianca":"alta","probabilidade_estimada":0.85,"odd_sugerida":"1.65","value":1.40,"razao_escolha":"...","aposta_backup":"BTTS","mercado_backup":"gols","media_gols_casa":"${sc?.mediaGols||'?'}","media_gols_fora":"${sf?.mediaGols||'?'}","media_escanteios":"${mediaCombEsc}","media_cartoes":"${mediaCombCart}","forma_casa":"${sc?.forma||'?'}","forma_fora":"${sf?.forma||'?'}","justificativa":"Análise pública aqui.","alternativas":[{"mercado":"gols","aposta":"Over 2.5 gols","confianca":"alta","razao":"..."},{"mercado":"resultado","aposta":"Dupla Chance 1X","confianca":"media","razao":"..."},{"mercado":"escanteios","aposta":"Over 8.5 escanteios","confianca":"media","razao":"..."},{"mercado":"cartoes","aposta":"Over 2.5 cartões","confianca":"baixa","razao":"..."}]}`;
}

// ─── Multi-agente: parse e análise por jogo ──────────────────

function _parseAgenteJson(txt) {
  if (!txt) return null;
  try {
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    return JSON.parse(txt.slice(s, e+1));
  } catch(e) { return null; }
}

// Retorna null se agente sinalizou sem_dados ou opcao_1 inválida
function _parseAgenteFiltrado(txt) {
  const obj = _parseAgenteJson(txt);
  if (!obj) return null;
  if (obj.sem_dados) return null;
  if (!obj.opcao_1?.aposta || (obj.opcao_1.probabilidade||0) <= 0) return null;
  return obj;
}

// Calcula Dupla Chance a partir das probabilidades brutas do agente Resultado
function _enriquecerResultadoComDuplaChance(ag) {
  if (!ag || ag.mercado !== 'resultado') return ag;
  const ops = [ag.opcao_1, ag.opcao_2].filter(Boolean);
  const find = (kws) => ops.find(o => kws.some(k => (o.aposta||'').toLowerCase().includes(k)));
  const pCasa   = find(['casa vence','home wins','1 vence'])?.probabilidade || 0;
  const pEmpate = find(['empate','draw','empat'])?.probabilidade || 0;
  const pFora   = find(['fora vence','away wins','visitante'])?.probabilidade || 0;
  if (!pCasa && !pFora) return ag;
  const p1X = Math.min(pCasa + pEmpate, 0.99);
  const pX2 = Math.min(pFora + pEmpate, 0.99);
  // Substituir opcao_1 por dupla chance se ganhar ≥10pp sobre vitória simples
  if (p1X >= pX2 && p1X > pCasa + 0.10) {
    ag.opcao_1 = { aposta: 'Dupla Chance Casa (1X)', probabilidade: parseFloat(p1X.toFixed(2)), razao: `Casa(${Math.round(pCasa*100)}%) + Empate(${Math.round(pEmpate*100)}%)` };
    if (!ag.opcao_2 || ag.opcao_2.probabilidade < pX2) ag.opcao_2 = { aposta: 'Dupla Chance Fora (X2)', probabilidade: parseFloat(pX2.toFixed(2)), razao: `Fora(${Math.round(pFora*100)}%) + Empate(${Math.round(pEmpate*100)}%)` };
  } else if (pX2 > p1X && pX2 > pFora + 0.10) {
    ag.opcao_1 = { aposta: 'Dupla Chance Fora (X2)', probabilidade: parseFloat(pX2.toFixed(2)), razao: `Fora(${Math.round(pFora*100)}%) + Empate(${Math.round(pEmpate*100)}%)` };
    if (!ag.opcao_2 || ag.opcao_2.probabilidade < p1X) ag.opcao_2 = { aposta: 'Dupla Chance Casa (1X)', probabilidade: parseFloat(p1X.toFixed(2)), razao: `Casa(${Math.round(pCasa*100)}%) + Empate(${Math.round(pEmpate*100)}%)` };
  }
  return ag;
}

async function _analisarJogoMultiAgente(jogo, ligaStatsMap, blocoMem, df, _gerarApostasRef) {
  const label = `${jogo.timeCasa} x ${jogo.timeFora}`;
  console.log(`\n🤖 Multi-agente: ${label}`);
  console.log(`  ⚡ Agentes especializados rodando em paralelo...`);

  const memGols       = filtrarMemoria(blocoMem, ['gol', 'over', 'under', 'placar', 'btts', 'marca']);
  const memResultado  = filtrarMemoria(blocoMem, ['result', 'vence', 'empate', 'dupla chance', '1x', 'x2']);
  const memEscanteios = filtrarMemoria(blocoMem, ['escanteio', 'corner']);
  const memCartoes    = filtrarMemoria(blocoMem, ['cartão', 'cartoes', 'amarelo', 'vermelho']);

  // Prompts de escanteios/cartões podem já retornar JSON sem_dados antes de chamar a IA
  const promptEsc = _promptAgentEscanteios(jogo, ligaStatsMap, memEscanteios);
  const promptCart = _promptAgentCartoes(jogo, ligaStatsMap, memCartoes);
  const escPreSemDados = promptEsc.startsWith('{"sem_dados"');
  const cartPreSemDados = promptCart.startsWith('{"sem_dados"');

  const [txtGols, txtResultado, txtEscanteios, txtCartoes] = await Promise.all([
    chamarIA(_promptAgentGols(jogo, ligaStatsMap, memGols), 600),
    chamarIA(_promptAgentResultado(jogo, ligaStatsMap, memResultado), 600),
    escPreSemDados  ? Promise.resolve(promptEsc)  : chamarIA(promptEsc, 600),
    cartPreSemDados ? Promise.resolve(promptCart) : chamarIA(promptCart, 600),
  ]);

  // P1: log detalhado com erro específico ao falhar
  const logAg = (nome, txt, ag) => {
    if (!ag?.opcao_1) {
      let erroMsg = 'sem JSON válido';
      if (txt) {
        const s = txt.indexOf('{'), e2 = txt.lastIndexOf('}');
        if (s !== -1 && e2 !== -1) {
          try {
            const parsed = JSON.parse(txt.slice(s, e2+1));
            const campos = Object.keys(parsed).join(', ');
            erroMsg = `JSON ok mas sem opcao_1 | campos encontrados: [${campos}]`;
          } catch(ex) { erroMsg = ex.message.substring(0,80); }
        }
        else erroMsg = `sem chaves — raw: ${txt.substring(0,60)}`;
      }
      console.log(`  ❌ ${nome}: falhou — ${erroMsg}`);
      return;
    }
    const p1 = `${ag.opcao_1.aposta} (${Math.round((ag.opcao_1.probabilidade||0)*100)}%)`;
    const p2 = ag.opcao_2 ? `${ag.opcao_2.aposta} (${Math.round((ag.opcao_2.probabilidade||0)*100)}%)` : '-';
    console.log(`  ✅ ${nome}: ${p1} | ${p2}`);
  };

  // P2: Dupla Chance automática para agente Resultado
  const agGols       = _parseAgenteJson(txtGols);
  const agResultado  = _enriquecerResultadoComDuplaChance(_parseAgenteJson(txtResultado));
  // P3: filtro sem_dados para escanteios e cartões
  const agEscanteios = _parseAgenteFiltrado(txtEscanteios);
  const agCartoes    = _parseAgenteFiltrado(txtCartoes);

  logAg('Gols      ', txtGols,       agGols);
  logAg('Resultado ', txtResultado,  agResultado);
  logAg('Escanteios', txtEscanteios, agEscanteios);
  logAg('Cartões   ', txtCartoes,    agCartoes);

  const agentesValidos = [agGols, agResultado, agEscanteios, agCartoes].filter(a => a?.opcao_1);

  // P4: se menos de 2 agentes retornaram dados — fallback por jogo
  if (agentesValidos.length < 2) {
    console.log(`  ⚠️ Multi-agente insuficiente (${agentesValidos.length}/4 agentes) — usando fallback para ${label}`);
    return null; // gerarApostasMultiAgente vai chamar fallback no loop
  }

  const txtCoord = await chamarIASonnet(_promptCoordenador(jogo, ligaStatsMap, blocoMem, agentesValidos, df), 1500);
  const resultado = _parseAgenteJson(txtCoord);

  if (!resultado?.aposta || !resultado?.mercado || !resultado?.justificativa) {
    console.log(`  ❌ Coordenador falhou — descartando ${label}`); return null;
  }

  // P4: validar que o mercado escolhido realmente veio de um agente válido
  const mercadosDisponiveis = new Set(agentesValidos.map(a => a.mercado));
  if (!mercadosDisponiveis.has(resultado.mercado)) {
    console.log(`  ⚠️ Coordenador escolheu mercado "${resultado.mercado}" que não tem dados — descartando`);
    return null;
  }

  // Remover alternativas de mercados SEM DADOS que o coordenador tenha inventado
  // (ex: "Mercado indisponível" como aposta — texto-placeholder em vez de omitir a entrada)
  if (resultado.alternativas?.length) {
    const antes = resultado.alternativas.length;
    resultado.alternativas = resultado.alternativas.filter(a => mercadosDisponiveis.has(a.mercado));
    const removidas = antes - resultado.alternativas.length;
    if (removidas > 0) console.log(`  🧹 ${removidas} alternativa(s) de mercado sem dados removida(s)`);
  }

  const probPct = resultado.probabilidade_estimada ? Math.round(resultado.probabilidade_estimada*100)+'%' : '?';
  console.log(`  🎯 Coordenador: ${resultado.mercado} ${resultado.aposta} (${probPct}) — value ${resultado.value||'?'}`);

  // Anexar outputs brutos dos agentes especializados (uso interno do Agente de Múltiplas)
  resultado._agentesRaw = agentesValidos;
  return resultado;
}

// ─── gerarApostasMultiAgente ─────────────────────────────────

async function gerarApostasMultiAgente(data, horaMin, metaJogos, timesIgnorar = new Set()) {
  console.log('\n🚀 Iniciando geração multi-agente...');

  const loaded = await _carregarFixturesComStats(data, horaMin, metaJogos, timesIgnorar);
  if (!loaded?.jogos?.length) { console.log('⚠️ Nenhum jogo disponível para multi-agente'); return null; }

  const { jogos, ligaStatsMap, blocoMem, df } = loaded;
  const jogosResultado = [];

  for (const jogo of jogos) {
    try {
      const res = await _analisarJogoMultiAgente(jogo, ligaStatsMap, blocoMem, df);
      if (res) {
        // Preservar metadados do fixture original para evitar falha de lookup por nome
        res._srcFixtureId = jogo.fixtureId;
        res._srcLigaId = jogo.ligaId;
        res._srcPri = jogo.pri;
        res._srcTipo = jogo.tipo;
        res._srcLiga = jogo.liga;
        res._srcTeamCasaId = jogo.teamCasaId;
        res._srcTeamForaId = jogo.teamForaId;
        jogosResultado.push(res);
      }
    } catch(e) { console.error(`❌ Multi-agente erro ${jogo.timeCasa} x ${jogo.timeFora}:`, e.message); }
    await sleep(3000);
  }

  console.log(`\n✅ Multi-agente: ${jogosResultado.length} apostas brutas`);
  if (!jogosResultado.length) return null;

  // Capturar outputs brutos dos agentes especializados para uso pelo Agente de Múltiplas
  // (mantido só em memória — nunca persistido no banco)
  const agentesRawMap = new Map();
  for (const j of jogosResultado) {
    if (j._agentesRaw) {
      const key = `${(j.time_casa||'').toLowerCase()}|${(j.time_fora||'').toLowerCase()}`;
      agentesRawMap.set(key, j._agentesRaw);
      delete j._agentesRaw;
    }
  }
  _agentesRawCache.set(data, agentesRawMap);
  if (_agentesRawCache.size > 5) { const k = _agentesRawCache.keys().next().value; _agentesRawCache.delete(k); }

  // ── Pós-processamento idêntico ao gerarApostas ─────────────

  function normalizarFormatoAlternativo(j) {
    if (!j) return j;
    if (j.status === 'nao_recomendado' && j.aposta_se_forcado) {
      const ap = j.aposta_se_forcado.toLowerCase();
      let mercado = j.mercado_evitar;
      if (ap.includes('vence')||ap.includes('empat')||ap.includes('dupla')||ap.includes('chance')) mercado = 'resultado';
      else if (ap.includes('escantei')) mercado = 'escanteios';
      else if (ap.includes('cart')) mercado = 'cartoes';
      else if (ap.includes('gol')||ap.includes('over')||ap.includes('under')) mercado = 'gols';
      return { ...j, aposta: j.aposta_se_forcado, mercado: mercado||'resultado', confianca: j.confianca_alternativa||'baixa', justificativa: j.razao_alternativa||'Análise sem padrão claro.', razao_escolha: j.razao_principal||'' };
    }
    return j;
  }
  function validarCamposEssenciais(j) {
    if (!j) return false;
    if (!j.aposta || j.aposta === 'undefined' || j.aposta.trim() === '') return false;
    if (!j.mercado || j.mercado === 'undefined') return false;
    if (!j.justificativa || j.justificativa === '-' || j.justificativa.trim() === '') return false;
    return true;
  }
  function calcularScoreProbabilidade(aposta, mercado, jogo) {
    if (!aposta) return 0;
    const ap = aposta.toLowerCase();
    const mg = (parseFloat(jogo.media_gols_casa)||0)+(parseFloat(jogo.media_gols_fora)||0);
    const me = parseFloat(jogo.media_escanteios)||0, mc = parseFloat(jogo.media_cartoes)||0;
    const m2 = ap.match(/([\d.]+)/); const linha = m2 ? parseFloat(m2[1]) : null;
    if (linha === null) return 0;
    const media = mercado==='gols' ? mg : mercado==='escanteios' ? me : mercado==='cartoes' ? mc : 0;
    if (!media) return 0;
    if (ap.includes('over')||ap.includes('mais')) return media - linha;
    if (ap.includes('under')||ap.includes('menos')) return linha - media;
    return 0;
  }

  const norm = s => s == null ? '' : s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
  const fixtureMap = new Map(), metaMap = new Map();
  for (const jg of jogos) {
    const k = `${norm(jg.timeCasa)}|${norm(jg.timeFora)}`;
    fixtureMap.set(k, jg.fixtureId);
    metaMap.set(k, { tipo: jg.tipo, liga: jg.liga, pri: jg.pri, ligaId: jg.ligaId, teamCasaId: jg.teamCasaId, teamForaId: jg.teamForaId });
  }

  const resultado = { jogos: jogosResultado.map(normalizarFormatoAlternativo).filter(validarCamposEssenciais).map(j => {
    const k = `${norm(j.time_casa)}|${norm(j.time_fora)}`;
    let fixtureId = fixtureMap.get(k) || null;
    const meta = metaMap.get(k) || {};
    if (!fixtureId) {
      const alt = jogos.find(jg => { const nc=norm(jg.timeCasa),nf=norm(jg.timeFora),jc=norm(j.time_casa),jf=norm(j.time_fora); return nc?.split(' ')[0]===jc?.split(' ')[0] && nf?.split(' ')[0]===jf?.split(' ')[0]; });
      if (alt) { fixtureId = alt.fixtureId; meta.ligaId = alt.ligaId; }
    }
    // Fallback garantido: usar fixtureId preservado diretamente do jogo original
    if (!fixtureId && j._srcFixtureId) {
      fixtureId = j._srcFixtureId;
      if (!meta.ligaId && j._srcLigaId) meta.ligaId = j._srcLigaId;
      if (!meta.tipo && j._srcTipo) meta.tipo = j._srcTipo;
      if (!meta.liga && j._srcLiga) meta.liga = j._srcLiga;
      if (!meta.pri && j._srcPri) meta.pri = j._srcPri;
      if (!meta.teamCasaId && j._srcTeamCasaId) meta.teamCasaId = j._srcTeamCasaId;
      if (!meta.teamForaId && j._srcTeamForaId) meta.teamForaId = j._srcTeamForaId;
    }
    return { ...j, tipo_liga: meta.tipo||j.tipo_liga||'eu', liga: meta.liga||j.liga||'Internacional', pri: meta.pri||20, fixtureId: fixtureId||null, ligaId: meta.ligaId||j.ligaId||null, teamCasaId: meta.teamCasaId||null, teamForaId: meta.teamForaId||null };
  }) };
  resultado.jogos.sort((a,b) => (a.pri||20)-(b.pri||20));

  console.log(`\n💰 Odds reais (multi-agente) — mínima 1.25 | ${jogos.length} candidatos...`);
  const descartadosMA = [];
  for (const jogo of resultado.jogos) {
    if (!jogo.fixtureId) continue;
    const oddsFixture = await buscarOddsFixture(jogo.fixtureId, data);
    const motivo = aplicarOddsEPivotar(jogo, oddsFixture);
    if (motivo) descartadosMA.push({ jogo, motivo, oddsFixture });
  }
  const ativosAposOddsMA = resultado.jogos.filter(j => !j.descartado).length;
  if (descartadosMA.length > 0 && ativosAposOddsMA < metaJogos) {
    console.log(`\n🔄 Apenas ${ativosAposOddsMA}/${metaJogos} jogos ativos — re-analisando ${descartadosMA.length} descartado(s)...`);
    for (const { jogo, motivo, oddsFixture } of descartadosMA) {
      if (!oddsFixture) continue;
      const mercadosDisp = formatarMercadosDisponiveisParaIA(oddsFixture);
      const isPrioritarioMA = jogo.pri != null && jogo.pri < 60;
      const isCompMA = (jogo.pri || 99) >= 60;
      const promptReanalise = `Jogo: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga}, ${jogo.horario})\nMotivo do descarte: ${motivo}\n${isPrioritarioMA ? '⚠️ LIGA PRIORITÁRIA — DEVE ter aposta. Aceite confiança "media" se necessário.\n' : ''}${isCompMA ? '⚠️ JOGO COMPLEMENTAR — escolha qualquer mercado com odd ≥ 1.25, qualquer confiança.\n' : ''}\nMercados DISPONÍVEIS na API (únicos apostáveis):\n${mercadosDisp}\n\nForma casa: ${jogo.forma_casa||'?'} | Fora: ${jogo.forma_fora||'?'} | Gols: ${jogo.media_gols_casa||'?'}+${jogo.media_gols_fora||'?'} | Esc: ${jogo.media_escanteios||'?'} | Cart: ${jogo.media_cartoes||'?'}\n\nEscolha a MELHOR aposta dentre os mercados acima. ${isPrioritarioMA ? 'Confiança alta ou media, odd ≥ 1.25.' : isCompMA ? 'Confiança alta, media ou baixa, odd ≥ 1.25.' : 'Confiança ALTA, odd ≥ 1.25.'}\nRetorne JSON: {"aposta":"...","mercado":"gols|resultado|escanteios|cartoes","confianca":"alta|media|baixa","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
      try {
        const resp = await chamarIA(promptReanalise, 800);
        if (resp) {
          const m = resp.match(/\{[\s\S]*\}/);
          if (m) {
            const nova = JSON.parse(m[0]);
            const confOkMA = nova.confianca === 'alta' || (isPrioritarioMA && nova.confianca === 'media') || (isCompMA && ['media','baixa'].includes(nova.confianca));
            if (nova.aposta && nova.mercado && confOkMA) {
              const oddReal = selecionarOddFixture(oddsFixture, nova.aposta, nova.mercado, jogo.time_casa, jogo.time_fora);
              const oddNum = oddReal ? parseFloat(oddReal) : null;
              if (oddNum && oddNum >= ODD_MINIMA) {
                console.log(`  ✅ Re-análise MA: ${nova.aposta} (${nova.mercado}) @ ${oddNum} [${nova.confianca}]`);
                jogo.aposta_original = jogo.aposta; jogo.mercado_original = jogo.mercado;
                jogo.aposta = nova.aposta; jogo.mercado = nova.mercado;
                jogo.odd_mercado = oddNum; jogo.confianca = nova.confianca || 'alta';
                jogo.descartado = false; jogo.descartado_motivo = null;
                jogo.justificativa = nova.justificativa || nova.razao || jogo.justificativa;
              }
            }
          }
        }
      } catch(e) { console.error(`  Erro re-análise MA ${jogo.time_casa}: ${e.message}`); }
    }
  } else if (descartadosMA.length > 0) {
    console.log(`📋 Muitos jogos — ${descartadosMA.length} descartado(s) não reutilizados`);
    descartadosMA.forEach(({ jogo, motivo }) => console.log(`  🗑️ ${jogo.time_casa} x ${jogo.time_fora}: ${motivo}`));
  }

  const jogosFinais = [];
  for (const jogo of resultado.jogos) {
    const conf = jogo.confianca||'media';
    const isComp = (jogo.pri||99) >= 60;
    // Se aplicarOddsEPivotar já confirmou um mercado válido, não sobrescrever com pivot de confiança
    // (pivot de confiança não verifica odds — pode trocar para mercado sem odd disponível)
    if (jogo.odd_mercado && jogo.odd_mercado >= ODD_MINIMA && !jogo.descartado && !jogo.analisando) {
      jogosFinais.push(jogo);
      continue;
    }
    if (!jogo.alternativas?.length) { if (isComp && ['nao_recomendado','baixa'].includes(conf)) { if (jogo.odd_mercado && jogo.odd_mercado >= ODD_MINIMA) { jogo.confianca = 'media'; } else { console.log(`  🗑️  Descartando complementar sem odd confirmada: ${jogo.time_casa} x ${jogo.time_fora}`); continue; } } jogosFinais.push(jogo); continue; }
    if (conf === 'alta') { jogosFinais.push(jogo); continue; }
    const alvo = ['nao_recomendado','baixa'].includes(conf) ? ['alta','media'] : ['alta'];
    const melhor = jogo.alternativas.find(a => alvo.includes(a.confianca) && a.aposta);
    if (melhor) {
      const motivo = ['nao_recomendado','baixa'].includes(conf) ? `${conf} → pivotando` : 'buscando alta';
      console.log(`  ⚡ Pivot(${motivo}): ${jogo.time_casa} x ${jogo.time_fora} | ${jogo.aposta} → ${melhor.aposta}`);
      jogo.aposta_original = jogo.aposta_original||jogo.aposta; jogo.mercado_original = jogo.mercado_original||jogo.mercado;
      jogo.aposta = melhor.aposta; jogo.mercado = melhor.mercado; jogo.confianca = melhor.confianca;
      jogo.razao_escolha = `Pivotado(${motivo}): ${melhor.razao}`; jogo.justificativa = gerarJustificativaPosPivot(melhor.aposta, melhor.mercado, melhor.razao, jogo);
      // P5: atualizar backup para próxima melhor alternativa (diferente da nova aposta)
      const proxBackup = jogo.alternativas?.find(a => a.aposta && a.aposta !== jogo.aposta && a.mercado !== jogo.mercado);
      if (proxBackup) { jogo.aposta_backup = proxBackup.aposta; jogo.mercado_backup = proxBackup.mercado; }
      jogosFinais.push(jogo);
    } else if (isComp && ['nao_recomendado','baixa'].includes(conf)) {
      const candidatos = jogo.alternativas.filter(a => ['baixa','nao_recomendado'].includes(a.confianca) && a.aposta);
      const atualScore = calcularScoreProbabilidade(jogo.aposta, jogo.mercado, jogo);
      let melhorBaixa = null, melhorScore = atualScore;
      for (const a of candidatos) { if (a.mercado===jogo.mercado && a.aposta===jogo.aposta) continue; const sc2 = calcularScoreProbabilidade(a.aposta, a.mercado, jogo); if (sc2 > melhorScore) { melhorScore = sc2; melhorBaixa = a; } }
      if (melhorBaixa) { jogo.aposta = melhorBaixa.aposta; jogo.mercado = melhorBaixa.mercado; jogo.razao_escolha = `Pivotado prob: ${melhorBaixa.razao}`; jogo.justificativa = gerarJustificativaPosPivot(melhorBaixa.aposta, melhorBaixa.mercado, melhorBaixa.razao, jogo); }
      jogo._reservaBaixa = true; jogosFinais.push(jogo);
    } else { jogosFinais.push(jogo); }
  }

  // Jogos prioritários (Série A/B, Copa do Mundo — pri < 10) nunca devem ser cortados pelo slice
  // mesmo que a confiança pós-pivot seja "media". Garantir que entrem antes de qualquer pri >= 10.
  jogosFinais.sort((a,b) => {
    const priA = (a.pri||99) < 10 ? 0 : 1;
    const priB = (b.pri||99) < 10 ? 0 : 1;
    if (priA !== priB) return priA - priB; // prioritários primeiro
    const ord={alta:0,media:1,baixa:2,nao_recomendado:3};
    const oa=ord[a.confianca]??2, ob=ord[b.confianca]??2;
    return oa!==ob ? oa-ob : (a.pri||99)-(b.pri||99);
  });
  resultado.jogos = jogosFinais.slice(0, metaJogos);
  resultado.jogos.forEach((j, idx) => { j.id = idx + 1; });

  const dist = resultado.jogos.reduce((acc,j) => { const c=j.confianca||'media'; acc[c]=(acc[c]||0)+1; return acc; }, {});
  console.log(`  📊 Multi-agente final: ${Object.entries(dist).map(([c,n])=>`${c}:${n}`).join(' | ')}`);
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
- Múltipla A: odd total entre 3.50 e 4.50 — ALVO: ~4.00 (adicione ou remova jogos até chegar nessa faixa)
- Múltipla B: odd total entre 2.60 e 3.49 — ALVO: ~3.00 (adicione ou remova jogos até chegar nessa faixa)
- CRÍTICO: odd total NUNCA pode passar de 4.50 na A nem de 3.49 na B — reduza jogos se necessário
- Use APENAS jogos da lista acima
- CRÍTICO: copie time_casa e time_fora EXATAMENTE como aparecem na lista — nunca inverta a ordem dos times
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

  const txt = await chamarIA(prompt, 1500);
  if (!txt) return null;
  try {
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s === -1) return null;
    const obj = JSON.parse(txt.slice(s, e+1));

    // Validação das faixas de odd — rejeita se fora do alvo
    const validarFaixa = (mult, tipo) => {
      if (!mult?.jogos?.length) return mult;
      const odd = parseFloat(mult.odd_total);
      const [min, max] = tipo === 'A' ? [3.50, 4.50] : [2.60, 3.49];
      if (isNaN(odd) || odd < min || odd > max) {
        console.warn(`⚠️ Múltipla ${tipo}: odd ${odd} fora da faixa [${min}-${max}] — recalculando`);
        // Recalcula a odd real como produto das odds individuais
        const oddReal = mult.jogos.reduce((p, j) => p * (parseFloat(j.odd) || 1), 1);
        mult.odd_total = parseFloat(oddReal.toFixed(2));
        // Se ainda fora, loga o aviso (será tratado na próxima geração)
        if (mult.odd_total < min || mult.odd_total > max) {
          console.warn(`  ❌ Múltipla ${tipo} rejeitada: odd ${mult.odd_total} fora de [${min}-${max}]`);
          return null;
        }
      }
      return mult;
    };

    obj.multipla_a = validarFaixa(obj.multipla_a, 'A');
    obj.multipla_b = validarFaixa(obj.multipla_b, 'B');
    return obj;
  } catch(err) {
    console.error('Erro parse múltiplas:', err.message);
    return null;
  }
}

// ─── Agentes especializados de Múltiplas (A e B) ─────────────
// Buscar histórico de múltiplas dos últimos N dias numa única query
async function buscarHistoricoMultiplas(data, dias = 30) {
  const desde = diaOffset(data, -dias);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=gte.${desde}&data=lt.${data}&multiplas=not.is.null&select=data,multiplas,resultados_multiplas&order=data.desc&limit=60`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch(e) { console.error('Erro buscarHistoricoMultiplas:', e.message); return []; }
}

// Processar histórico em padrões: assertividade por mercado/liga, quebradores e vencedores frequentes
function processarHistoricoMultiplas(rows) {
  const porTipo = { A: [], B: [] };
  const apostaStats = {};  // "mercado: aposta" -> {g,r}
  const mercadoStats = {}; // mercado -> {g,r}
  const ligaStats = {};    // liga -> {g,r}
  const timeStats = {};    // nome do time -> {g,r}

  const reg = (obj, key, campo) => { if (!key) return; obj[key] = obj[key] || { g: 0, r: 0 }; obj[key][campo]++; };

  for (const row of rows) {
    const m = row.multiplas, r = row.resultados_multiplas;
    if (!m) continue;
    for (const [tipo, key] of [['A','multipla_a'],['B','multipla_b']]) {
      const mm = m[key];
      if (!mm?.jogos?.length) continue;
      const rr = r?.[key];
      const resultadoGeral = rr?.resultado || 'pendente';
      const jogosRes = (rr?.jogos_resultado?.length ? rr.jogos_resultado : mm.jogos);
      if (resultadoGeral !== 'pendente') {
        porTipo[tipo].push({ data: row.data, resultado: resultadoGeral, odd: mm.odd_total, jogos: jogosRes });
      }
      for (const j of jogosRes) {
        const jr = j.resultado;
        if (jr !== 'green' && jr !== 'red') continue;
        const campo = jr === 'green' ? 'g' : 'r';
        const mercado = (j.mercado || '').toLowerCase();
        const apostaKey = j.mercado && j.aposta ? `${j.mercado}: ${j.aposta}` : null;
        reg(mercadoStats, mercado, campo);
        reg(apostaStats, apostaKey, campo);
        reg(ligaStats, j.liga, campo);
        reg(timeStats, j.time_casa, campo);
        reg(timeStats, j.time_fora, campo);
      }
    }
  }

  const topN = (obj, campoOrdenar, n = 8) => Object.entries(obj)
    .filter(([,s]) => (s.g + s.r) >= 2)
    .sort((a,b) => b[1][campoOrdenar] - a[1][campoOrdenar])
    .slice(0, n);

  return {
    porTipo, apostaStats, mercadoStats, ligaStats, timeStats,
    quebradoresFrequentes: topN(apostaStats, 'r'),
    vencedoresFrequentes: topN(apostaStats, 'g'),
    timesQuebradores: topN(timeStats, 'r'),
  };
}

// Montar bloco de texto com o histórico processado para um tipo (A ou B)
function montarDigestHistorico(hist, tipo) {
  const linhas = hist.porTipo[tipo];
  const g = linhas.filter(l => l.resultado === 'green').length;
  const r = linhas.length - g;
  const recentesTxt = linhas.slice(0, 12).map(l => {
    const jogosTxt = l.jogos.map(j => {
      const marker = j.resultado === 'red' ? '❌quebrou' : j.resultado === 'green' ? '✅' : '?';
      return `${j.time_casa} x ${j.time_fora} [${j.aposta}] ${marker}`;
    }).join(' | ');
    return `${l.data} (odd ${l.odd || '?'}) → ${l.resultado.toUpperCase()}: ${jogosTxt}`;
  }).join('\n') || 'sem histórico ainda para este tipo';

  const fmtStats = (obj, n = 8) => Object.entries(obj)
    .filter(([,s]) => (s.g + s.r) >= 2)
    .sort((a,b) => (b[1].g+b[1].r) - (a[1].g+a[1].r))
    .slice(0, n)
    .map(([k,s]) => { const t = s.g + s.r; return `${k} ${Math.round(s.g/t*100)}% (${s.g}G/${s.r}R)`; })
    .join(' | ') || 'sem dados suficientes';

  const quebradoresTxt = hist.quebradoresFrequentes.map(([k,s]) => `${k} (${s.r}x red de ${s.g+s.r})`).join(', ') || 'nenhum padrão identificado ainda';
  const vencedoresTxt  = hist.vencedoresFrequentes.map(([k,s]) => `${k} (${s.g}x green de ${s.g+s.r})`).join(', ') || 'nenhum padrão identificado ainda';
  const timesQuebrTxt  = hist.timesQuebradores.map(([t,s]) => `${t} (${s.r}x red)`).join(', ') || 'nenhum time identificado como quebrador recorrente';

  return `HISTÓRICO MÚLTIPLA ${tipo} (últimos 30 dias): ${g}G / ${r}R
ÚLTIMAS MÚLTIPLAS ${tipo}:
${recentesTxt}

ASSERTIVIDADE POR MERCADO: ${fmtStats(hist.mercadoStats)}
ASSERTIVIDADE POR LIGA: ${fmtStats(hist.ligaStats)}
APOSTAS/MERCADOS QUE MAIS QUEBRARAM (evite priorizar): ${quebradoresTxt}
APOSTAS/MERCADOS QUE MAIS DERAM GREEN (priorize): ${vencedoresTxt}
TIMES QUE MAIS APARECERAM EM QUEBRAS: ${timesQuebrTxt}`;
}

// Montar pool de opções por jogo do dia — aposta principal + alternativas do coordenador
// + outputs brutos dos 4 agentes especializados (com probabilidade exata), quando disponíveis
function montarPoolJogosDia(jogosDodia, agentesRawMap) {
  return jogosDodia.filter(j => !j.descartado && !j.analisando && j.odd_mercado && j.odd_mercado >= 1.25).map(j => {
    const key = `${(j.time_casa||'').toLowerCase()}|${(j.time_fora||'').toLowerCase()}`;
    const raw = agentesRawMap?.get(key);
    const opcoes = [];
    // Usar odds_confirmadas quando disponível (coletadas em aplicarOddsEPivotar)
    if (j.odds_confirmadas && j.odds_confirmadas.length > 0) {
      for (const oc of j.odds_confirmadas) {
        opcoes.push({ mercado: oc.mercado, aposta: oc.aposta, odd: oc.odd, fonte: 'confirmada' });
      }
    } else {
      // Fallback: apenas aposta principal
      if (j.aposta && j.mercado) opcoes.push({ mercado: j.mercado, aposta: j.aposta, odd: j.odd_mercado, fonte: 'confirmada' });
    }
    return { time_casa: j.time_casa, time_fora: j.time_fora, liga: j.liga, horario: j.horario, odd_mercado: j.odd_mercado || null, opcoes };
  }).filter(j => j.opcoes.length);
}

function montarBlocoJogosDia(pool) {
  return pool.map((j, i) => {
    const opcoesTxt = j.opcoes.map(o => `${o.mercado}: "${o.aposta}" @ ${o.odd}`).join(' | ');
    return `${i+1}. ${j.time_casa} x ${j.time_fora} | ${j.liga} | ${j.horario}\n   Opções confirmadas: ${opcoesTxt}`;
  }).join('\n');
}

function _promptAgenteMultiplaA(digest, blocoJogos) {
  return `Você é o AGENTE MÚLTIPLA A. Objetivo: montar a múltipla de MAIOR ODD com segurança razoável (3-4 jogos).

${digest}

JOGOS DISPONÍVEIS HOJE (cada opção tem odd real confirmada pela API — pode escolher qualquer opção, não precisa ser a aposta principal do dia):
${blocoJogos}

⚠️ REGRAS OBRIGATÓRIAS DE ODD:
- Cada opção listada acima tem sua odd já confirmada pela API no formato "@ X.XX". Use EXATAMENTE essa odd no campo "odd" do JSON.
- NUNCA invente odds. Se escolher "Over 2.5 gols @ 1.66", o campo odd deve ser 1.66.
- A odd_total deve estar entre 3.50 e 5.00. NÃO ultrapasse 5.00.

RACIOCÍNIO OBRIGATÓRIO (siga os 4 passos antes de responder):
Passo 1 — Analisar histórico: quais mercados/ligas têm maior % de GREEN nas múltiplas A? Quais foram os quebradores mais frequentes?
Passo 2 — Filtrar jogos elegíveis: elimine jogos de times que foram quebradores frequentes. Priorize mercados com melhor histórico. Priorize opções com probabilidade > 70%. Evite opções com indício de value < 1.0.
Passo 3 — Montar a múltipla: selecione 3-4 jogos que maximizem a probabilidade conjunta. NÃO priorize odd alta — priorize segurança. Justifique cada jogo com base no histórico E nos dados de hoje.
Passo 4 — Calcular probabilidade conjunta: P(múltipla) = P(jogo1) × P(jogo2) × P(jogo3) [× P(jogo4)]. Só inclua o 4º jogo se P(jogo4) > 65% e não for quebrador histórico.

Retorne SOMENTE JSON (sem comentários, sem texto fora do JSON):
{"tipo":"A","jogos":[{"time_casa":"...","time_fora":"...","liga":"...","horario":"...","aposta":"...","mercado":"...","odd":1.65,"razao_inclusao":"..."}],"odd_total":4.15,"probabilidade_conjunta":0.38,"justificativa":"..."}`;
}

function _promptAgenteMultiplaB(digest, blocoJogos) {
  return `Você é o AGENTE MÚLTIPLA B. Objetivo: montar a múltipla MAIS SEGURA do dia (2-3 jogos, odd menor).

${digest}

JOGOS DISPONÍVEIS HOJE (cada opção tem odd real confirmada pela API — pode escolher qualquer opção, não precisa ser a aposta principal do dia):
${blocoJogos}

⚠️ REGRAS OBRIGATÓRIAS DE ODD:
- Use SEMPRE a "ODD CONFIRMADA API" exibida acima para o campo "odd" de cada jogo. NUNCA invente odds.
- NUNCA invente odds. Se escolher "Over 2.5 gols @ 1.66", o campo odd deve ser 1.66.
- A odd_total deve estar entre 2.50 e 3.49.

DIFERENÇA EM RELAÇÃO AO AGENTE A: selecione os jogos com MAIOR probabilidade individual (não precisa ser os mesmos do A). Máximo 3 jogos. Foco em P(conjunta) > 45% — segurança acima de tudo. Pode repetir 1 jogo do A se for o mais seguro disponível, mas evite repetir todos.

RACIOCÍNIO OBRIGATÓRIO (mesmos 4 passos do Agente A, com threshold mais conservador):
Passo 1 — Analisar histórico (mercados/ligas com melhor % GREEN, quebradores frequentes)
Passo 2 — Filtrar jogos elegíveis (eliminar quebradores, priorizar probabilidade alta, threshold ainda mais exigente)
Passo 3 — Montar a múltipla com 2-3 jogos de máxima probabilidade individual
Passo 4 — Calcular P(múltipla) = produto das probabilidades — deve ser > 45%

Retorne SOMENTE JSON:
{"tipo":"B","jogos":[{"time_casa":"...","time_fora":"...","liga":"...","horario":"...","aposta":"...","mercado":"...","odd":1.65,"razao_inclusao":"..."}],"odd_total":2.85,"probabilidade_conjunta":0.52,"justificativa":"..."}`;
}

function _validarMultiplaAgente(obj, { minJogos = 2, minOdd = 1.8, maxOdd = null } = {}) {
  if (!obj?.jogos?.length || obj.jogos.length < minJogos) return false;
  if (!obj.odd_total || obj.odd_total < minOdd) return false;
  if (maxOdd && obj.odd_total > maxOdd) return false;
  if (obj.jogos.some(j => !j.time_casa || !j.time_fora || !j.aposta || !j.mercado || !j.odd || j.odd < 1.20)) return false;
  return true;
}

// Nova função: agentes especializados analisam o histórico de 30 dias antes de montar as múltiplas
// Substitui gerarMultiplas como ponto de entrada — fallback automático para gerarMultiplas se falhar
async function gerarMultiplasComAgentes(data, jogosDodia) {
  try {
    console.log('\n🎯 Agentes de múltiplas rodando...');
    const histRows = await buscarHistoricoMultiplas(data, 30);
    const hist = processarHistoricoMultiplas(histRows);
    const gA = hist.porTipo.A.filter(l => l.resultado === 'green').length, rA = hist.porTipo.A.length - gA;
    const gB = hist.porTipo.B.filter(l => l.resultado === 'green').length, rB = hist.porTipo.B.length - gB;
    console.log(`  📊 Histórico: ${hist.porTipo.A.length + hist.porTipo.B.length} múltiplas analisadas (${gA}G/${rA}R múltipla A | ${gB}G/${rB}R múltipla B)`);
    if (hist.quebradoresFrequentes.length) console.log(`  📋 Quebradores frequentes: ${hist.quebradoresFrequentes.slice(0,3).map(([k,s])=>`${k} (${s.r}x)`).join(', ')}`);
    if (hist.vencedoresFrequentes.length) console.log(`  📋 Mercados GREEN: ${hist.vencedoresFrequentes.slice(0,3).map(([k,s])=>`${k} (${s.g}x)`).join(', ')}`);

    const agentesRawMap = _agentesRawCache.get(data) || null;
    const pool = montarPoolJogosDia(jogosDodia, agentesRawMap);
    if (pool.length < 2) { console.log('  ⚠️ Pool insuficiente de jogos — fallback gerarMultiplas'); return await gerarMultiplas(data, jogosDodia); }
    const blocoJogos = montarBlocoJogosDia(pool);

    const [txtA, txtB] = await Promise.all([
      chamarIASonnet(_promptAgenteMultiplaA(montarDigestHistorico(hist, 'A'), blocoJogos), 2000),
      chamarIASonnet(_promptAgenteMultiplaB(montarDigestHistorico(hist, 'B'), blocoJogos), 2000),
    ]);

    const objA = _parseAgenteJson(txtA);
    const objB = _parseAgenteJson(txtB);
    const validA = _validarMultiplaAgente(objA, { minJogos: 2, minOdd: 2.5, maxOdd: 6.0 });
    const validB = _validarMultiplaAgente(objB, { minJogos: 2, minOdd: 1.8, maxOdd: 4.0 });

    if (!validA || !validB) {
      const diagnosticar = (obj, txt, nome) => {
        if (!obj) return `sem JSON válido | raw: ${(txt||'').substring(0, 200)}`;
        if (!obj.jogos?.length) return `sem campo "jogos" | campos: [${Object.keys(obj).join(', ')}]`;
        if (obj.jogos.length < 2) return `jogos insuficientes (${obj.jogos.length} < 2)`;
        if (!obj.odd_total) return `sem odd_total | campos: [${Object.keys(obj).join(', ')}]`;
        const minOdd = nome === 'A' ? 2.5 : 1.8;
        if (obj.odd_total < minOdd) return `odd_total ${obj.odd_total} < mínimo ${minOdd}`;
        const jogoInvalido = obj.jogos.find(j => !j.time_casa || !j.time_fora || !j.aposta || !j.mercado || !j.odd || j.odd < 1.20);
        if (jogoInvalido) return `jogo inválido: ${JSON.stringify(jogoInvalido).substring(0, 150)}`;
        return 'válido';
      };
      if (!validA) console.log(`  ❌ Agente Múltipla A falhou — motivo: ${diagnosticar(objA, txtA, 'A')}`);
      if (!validB) console.log(`  ❌ Agente Múltipla B falhou — motivo: ${diagnosticar(objB, txtB, 'B')}`);
      console.log(`  ⚠️ Agentes retornaram inválido (A:${validA?'ok':'falhou'} B:${validB?'ok':'falhou'}) — fallback gerarMultiplas`);
      return await gerarMultiplas(data, jogosDodia);
    }

    console.log(`✅ Múltipla A: ${objA.jogos.length} jogos | odd ${objA.odd_total} | P(conjunta) ${Math.round((objA.probabilidade_conjunta||0)*100)}%`);
    console.log(`  → ${objA.jogos.map(j=>j.aposta).join(' | ')}`);
    console.log(`✅ Múltipla B: ${objB.jogos.length} jogos | odd ${objB.odd_total} | P(conjunta) ${Math.round((objB.probabilidade_conjunta||0)*100)}%`);
    console.log(`  → ${objB.jogos.map(j=>j.aposta).join(' | ')}`);

    const fmt = arr => arr.map(j => ({ liga: j.liga, time_casa: j.time_casa, time_fora: j.time_fora, horario: j.horario, aposta: j.aposta, mercado: j.mercado, odd: j.odd, justificativa: j.razao_inclusao || '' }));
    return {
      multipla_a: { odd_total: objA.odd_total, jogos: fmt(objA.jogos) },
      multipla_b: { odd_total: objB.odd_total, jogos: fmt(objB.jogos) },
    };
  } catch(e) {
    console.error('❌ gerarMultiplasComAgentes falhou:', e.message, '— fallback gerarMultiplas');
    return await gerarMultiplas(data, jogosDodia);
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
    const resNormal = resultadosApostas.find(r =>
      match(r.time_casa, j.time_casa) && match(r.time_fora, j.time_fora)
    );
    const resInvertido = !resNormal && resultadosApostas.find(r =>
      match(r.time_fora, j.time_casa) && match(r.time_casa, j.time_fora)
    );
    const res = resNormal || resInvertido;
    const timesInvertidos = !!resInvertido;
    if (!res) {
      console.log(`  ⚠️ Não encontrado: "${j.time_casa}" x "${j.time_fora}"`);
      return 'nao_encontrado';
    }
    // Não propagar 'cancelado' da aposta individual — a múltipla pode ter aposta diferente
    // Ex: individual=Under 3.0 (push), múltipla=Over 2.5 (green com mesmo placar)
    if (!res.placar) return res.resultado_aposta === 'cancelado' ? 'cancelado' : 'pendente';
    if (res.resultado_aposta === 'pendente') return 'pendente';
    let [gC, gF] = res.placar.split('-').map(Number);
    // Se times estavam invertidos na múltipla, inverter gols para cálculo correto
    if (timesInvertidos) {
      [gC, gF] = [gF, gC];
      console.log(`  🔄 Times invertidos na múltipla: ${j.time_casa} x ${j.time_fora} — gols ajustados para ${gC}-${gF}`);
    }
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
    // Passar stats do resultado individual para validar escanteios/cartoes corretamente
    const statsMultipla = (res.escanteios_total != null || res.cartoes_total != null) ? {
      escanteiosTotal: res.escanteios_total ?? 0,
      escanteiosCasa: null, escanteiosFora: null,
      cartoesTotal: res.cartoes_total ?? 0,
      confirmado: true,
    } : null;
    const resultado = verificarAposta(jogoComMercado, gC, gF, statsMultipla);
    console.log(`  📊 Múltipla: ${j.time_casa} x ${j.time_fora} | ${res.placar} | mercado:${j.mercado||'resultado'} | ${j.aposta} → ${resultado.toUpperCase()}`);
    return resultado;
  })];

  // Buscar via web search em lote para todos os não encontrados
  const naoEncontradosIdx = multipla.jogos.map((_, i) => i).filter(i => resultadosJogos[i] === 'nao_encontrado');
  if (naoEncontradosIdx.length > 0) {
    try {
      const listaWS = naoEncontradosIdx.map(i => `${multipla.jogos[i].time_casa} x ${multipla.jogos[i].time_fora}`).join(', ');
      console.log(`  🔍 Web search múltiplas em lote: ${listaWS}`);
      const txt = await chamarIA(
        `Placares finais futebol. Para cada jogo responda "Time1 N-M Time2" ou "cancelado". Jogos: ${listaWS}`,
        150
      );
      if (txt) {
        for (const idx of naoEncontradosIdx) {
          const j = multipla.jogos[idx];
          const nc = j.time_casa.split(' ')[0].toLowerCase();
          const nf = j.time_fora.split(' ')[0].toLowerCase();
          if (/cancelado|adiado|suspens/i.test(txt.split('\n').find(l => l.toLowerCase().includes(nc)) || '')) {
            resultadosJogos[idx] = 'cancelado';
          } else {
            const m = txt.match(new RegExp(nc + '[^\\n]*?(\\d+)[-x](\\d+)', 'i'))
                    || txt.match(new RegExp('(\\d+)[-x](\\d+)[^\\n]*' + nf, 'i'));
            if (m) {
              const gC = parseInt(m[1]), gF = parseInt(m[2]);
              resultadosJogos[idx] = verificarAposta({...j}, gC, gF, null);
              console.log(`  ✅ Web search lote: ${j.time_casa} x ${j.time_fora} → ${gC}-${gF} → ${resultadosJogos[idx].toUpperCase()}`);
            }
          }
        }
      }
    } catch(e) { console.log(`  ⚠️ Web search múltiplas falhou: ${e.message}`); }
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
      // Placar do 1º tempo — necessário para validar apostas de tempo parcial
      golsCasa1T: f.score?.halftime?.home ?? null,
      golsFora1T: f.score?.halftime?.away ?? null,
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
// ─── Agente IA para validação de apostas complexas ─────────────────────────
async function agentValidarAposta(jogo, golsCasa, golsFora, stats) {
  const statsTexto = stats ? `Escanteios: ${stats.escanteiosTotal} | Cartões: ${stats.cartoesTotal}` : 'Sem stats disponíveis';
  const prompt = `Você é um validador de apostas esportivas. Analise se a aposta abaixo deu GREEN ou RED.

JOGO: ${jogo.time_casa} ${golsCasa} x ${golsFora} ${jogo.time_fora}
APOSTA: ${jogo.aposta}
MERCADO: ${jogo.mercado || 'não informado'}
${statsTexto}

REGRAS:
- Handicap asiático: ex. "Argentina -1.5 gols" significa Argentina precisa vencer por 2+ gols
- Handicap +1.5 significa o time pode perder por 1 ou vencer/empatar
- X2: visitante vence OU empate
- 1X: mandante vence OU empate  
- Double chance: igual ao acima
- Ambos marcam / BTTS: ambos os times marcaram pelo menos 1 gol
- Over/Under: total de gols do jogo
- Vence ou empata: time não pode perder
- Margem de gols: diferença entre os times

Responda APENAS com uma palavra: GREEN ou RED`;

  const resposta = await chamarIA(prompt, 50);
  const r = resposta?.toLowerCase().trim();
  if (r?.includes('green')) return 'green';
  if (r?.includes('red')) return 'red';
  return 'pendente';
}

function verificarAposta(jogo, golsCasa, golsFora, stats = null) {
  const total = golsCasa + golsFora;
  const aposta = jogo.aposta?.toLowerCase() || '';
  // Inferir mercado pela aposta — evita erro quando mercado salvo está errado
  // IMPORTANTE: checar escanteios/cartões ANTES de over/under genérico,
  // pois "Over 2.5 cartões" contém "over" mas é cartoes, não gols.
  const inferirMercadoVerif = (m, a) => {
    const al = (a||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (al.includes('escanteio') || al.includes('corner') || al.includes('canto')) return 'escanteios';
    if (al.includes('cartao') || al.includes('amarelo') || al.includes('card') || al.includes('yellow')) return 'cartoes';
    if (al.includes('marca') || al.includes('to score') || al.includes('anytime') ||
        al.includes('over') || al.includes('under') || al.includes('ambas') ||
        al.includes('ambos') || al.includes('btts') || al.includes('menos de') ||
        al.includes('mais de')) return 'gols';
    return m || 'resultado';
  };
  const mercado = inferirMercadoVerif(jogo.mercado?.toLowerCase(), jogo.aposta);
  const casaVence = golsCasa > golsFora;
  const foraVence = golsFora > golsCasa;
  const empate = golsCasa === golsFora;

  // Helper: verificar over/under genérico
  const checkOverUnder = (valor, linha) => {
    const n = parseFloat(linha);
    const ap = (typeof apostaNorm !== 'undefined' ? apostaNorm : aposta);
    // Verifica se a linha aparece como número completo (não como prefixo de outro número)
    // Ex: "over 2" não deve casar em "over 2.5" — verifica que após a linha não vem dígito/ponto
    const linhaExata = (prefixo, l) => {
      const idx = ap.indexOf(`${prefixo} ${l}`);
      if (idx === -1) return false;
      const proxChar = ap[idx + prefixo.length + 1 + l.length];
      return !proxChar || !/[0-9.]/.test(proxChar);
    };
    // Linhas inteiras (1, 2, 3...) usam Asian Handicap: valor exato = PUSH (reembolso)
    // Linhas .5 (1.5, 2.5...) nunca têm push — resultado sempre green ou red
    const isLinhaInteira = Number.isInteger(n);
    if (linhaExata('over', linha) || linhaExata('mais de', linha)) {
      if (isLinhaInteira && valor === n) return 'cancelado'; // push só para linhas inteiras
      return valor > n ? 'green' : 'red';
    }
    if (linhaExata('under', linha) || linhaExata('menos de', linha)) {
      if (isLinhaInteira && valor === n) return 'cancelado';
      return valor < n ? 'green' : 'red';
    }
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
    // Detecta tempo parcial na aposta
    const isPrimTempo = apostaNorm.includes('primeiro tempo') || apostaNorm.includes('1st half') || apostaNorm.includes('first half') || apostaNorm.includes('1o tempo') || apostaNorm.includes('1º tempo') || apostaNorm.includes('1° tempo') || apostaNorm.includes('halftime') || /\b1[°º]\s*tempo/i.test(jogo.aposta||'') || /(1st|first|1\s*t)\s*(half|time|tempo)/i.test(jogo.aposta||'') || apostaNorm.includes('ht');
    const isSegTempo  = apostaNorm.includes('segundo tempo')  || apostaNorm.includes('2nd half') || apostaNorm.includes('second half') || apostaNorm.includes('2o tempo') || apostaNorm.includes('2º tempo') || apostaNorm.includes('2° tempo') || /\b2[°º]\s*tempo/i.test(jogo.aposta||'');
    // Detecta time específico
    const isAway = apostaNorm.includes('away') || apostaNorm.includes('visitante') || apostaNorm.includes('fora over') || apostaNorm.includes('fora under');
    const isHome = apostaNorm.includes('home ') || apostaNorm.includes('mandante') || apostaNorm.includes('casa over') || apostaNorm.includes('casa under');

    // Gols parciais (1º/2º tempo) — usa placar de intervalo quando disponível
    if (isPrimTempo || isSegTempo) {
      if (stats?.golsCasa1T == null) return 'sem_stats';
      // 1º tempo: gols do intervalo
      // 2º tempo: gols totais MENOS gols do 1º tempo
      const golsPT = isPrimTempo
        ? { casa: stats.golsCasa1T, fora: stats.golsFora1T, total: stats.golsCasa1T + stats.golsFora1T }
        : { casa: golsCasa - stats.golsCasa1T, fora: golsFora - stats.golsFora1T, total: (golsCasa - stats.golsCasa1T) + (golsFora - stats.golsFora1T) };
      const valorPT = isAway ? golsPT.fora : isHome ? golsPT.casa : golsPT.total;
      for (const linha of ['0.5','0.75','1.0','1','1.25','1.5','1.75','2.0','2','2.25','2.5','2.75','3.0','3','3.25','3.5','3.75','4.0','4','4.25','4.5']) {
        const r = checkOverUnder(valorPT, linha);
        if (r) return r;
      }
      return 'pendente';
    }

    // Apostas de time específico (full match)
    if (isAway || palavrasFora.some(p => apostaNorm.includes(p))) {
      for (const linha of ['0.5','0.75','1.0','1','1.25','1.5','1.75','2.0','2','2.25','2.5','2.75','3.0','3','3.25','3.5','3.75','4.0','4','4.25','4.5']) {
        const r = checkOverUnder(golsFora, linha);
        if (r) return r;
      }
    }
    if (isHome || palavrasCasa.some(p => apostaNorm.includes(p) && !isAway)) {
      for (const linha of ['0.5','0.75','1.0','1','1.25','1.5','1.75','2.0','2','2.25','2.5','2.75','3.0','3','3.25','3.5','3.75','4.0','4','4.25','4.5']) {
        const r = checkOverUnder(golsCasa, linha);
        if (r) return r;
      }
    }

    // Over/Under total — inclui linhas inteiras, .5 e linhas asiáticas (.25/.75)
    for (const linha of ['0.5','0.75','1.0','1','1.25','1.5','1.75','2.0','2','2.25','2.5','2.75','3.0','3','3.25','3.5','3.75','4.0','4','4.25','4.5','4.75','5','5.5']) {
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
      if (apostaNorm.includes('visitante') || apostaNorm.includes('away team') || apostaNorm.includes('away to score')) return golsFora > 0 ? 'green' : 'red';
      if (apostaNorm.includes('mandante') || apostaNorm.includes('home team') || apostaNorm.includes('home to score')) return golsCasa > 0 ? 'green' : 'red';
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
    // Se stats zeradas E não confirmadas manualmente, API não tem dados para essa liga — needs manual review
    if (!stats.confirmado && esc === 0 && stats.escanteiosCasa === 0 && stats.escanteiosFora === 0) {
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
    // Se stats zeradas E não confirmadas manualmente, API não tem dados para essa liga — needs manual review
    if (!stats.confirmado && cart === 0 && stats.cartoesCasa === 0 && stats.cartoesFora === 0) {
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

  // ── HANDICAP ASIÁTICO ─────────────────────────────────────
  // Ex: "Inglaterra -1.5 gols", "Argentina -1.5", "Brasil +1.5"
  const handicapMatch = apostaNorm.match(/([+-]\d+\.?\d*)\s*(gol|goal)?/);
  if (handicapMatch) {
    const hcap = parseFloat(handicapMatch[1]);
    const apostaMencCasaHc = palavrasCasa.some(p => apostaNorm.includes(p));
    const apostaMencForaHc = palavrasFora.some(p => apostaNorm.includes(p));
    if (apostaMencCasaHc || apostaMencForaHc) {
      const difGols = golsCasa - golsFora; // positivo = casa vence
      const difAjustado = apostaMencCasaHc ? difGols + hcap : -difGols + hcap;
      console.log(`    🔎 handicap: ${apostaMencCasaHc?'casa':'fora'} hcap=${hcap} dif=${difGols} ajustado=${difAjustado}`);
      if (difAjustado > 0) return 'green';
      if (difAjustado < 0) return 'red';
      // Exatamente 0 = push (empate asiático) = reembolso
      return 'cancelado';
    }
  }

  // ── MERCADO RESULTADO ─────────────────────────────────────
  if (mercado === 'resultado') {
    const apostaMencCasa = palavrasCasa.some(p => apostaNorm.includes(p));
    const apostaMencFora = !apostaMencCasa && palavrasFora.some(p => apostaNorm.includes(p));
    console.log(`    🔎 resultado: apostaNorm="${apostaNorm}" mencCasa=${apostaMencCasa} mencFora=${apostaMencFora} casaVence=${casaVence} foraVence=${foraVence}`);

    // Empate simples — só se não houver indicação de dupla chance (ou empate, X2, 1X)
    if (aposta.includes('empate') && !aposta.includes('vence') && !aposta.includes('vitoria') && !aposta.includes('vitória') && !aposta.includes('dupla') && !aposta.includes('ou empat') && !aposta.includes('x2') && !aposta.includes('1x')) return empate ? 'green' : 'red';
    // DNB (Draw No Bet): empate = cancelado, vitória = green, derrota = red
    if (aposta.includes('dnb') || aposta.includes('draw no bet')) {
      if (empate) return 'cancelado';
      if (apostaMencCasa) return casaVence ? 'green' : 'red';
      if (apostaMencFora) return foraVence ? 'green' : 'red';
    }
    if (aposta.includes('ou empat') || aposta.includes('vence ou empat') || aposta.includes('dupla chance') || aposta.includes('nao perde') || aposta.includes('não perde') || aposta.includes('x2') || aposta.includes('1x') || aposta.includes('12')) {
      if (aposta.includes('x2') || apostaMencFora) return (foraVence || empate) ? 'green' : 'red';
      if (aposta.includes('1x') || apostaMencCasa) return (casaVence || empate) ? 'green' : 'red';
      if (aposta.includes('12')) return (casaVence || foraVence) ? 'green' : 'red';
      // Dupla chance genérica por posição: "dupla chance (casa ou empate)" / "(fora ou empate)"
      if (aposta.includes('casa') || aposta.includes('home')) return (casaVence || empate) ? 'green' : 'red';
      if (aposta.includes('fora') || aposta.includes('away')) return (foraVence || empate) ? 'green' : 'red';
    }
    if (aposta.includes('vence') || aposta.includes('vitória') || aposta.includes('vitoria')) {
      if (apostaMencCasa) return casaVence ? 'green' : 'red';
      if (apostaMencFora) return foraVence ? 'green' : 'red';
      // Fallback quando aposta usa keyword genérica sem nome do time (ex: "Fora vence (2)")
      if (apostaNorm.includes('fora vence') || apostaNorm.includes('away wins') || apostaNorm.includes('visitante vence') || apostaNorm.includes('away (2)')) return foraVence ? 'green' : 'red';
      if (apostaNorm.includes('casa vence') || apostaNorm.includes('home wins') || apostaNorm.includes('mandante vence') || apostaNorm.includes('home (1)')) return casaVence ? 'green' : 'red';
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
          const prev = resMultExistente || {};
          await dbSaveResultadosMultiplas(data, {
            validado_em: new Date().toISOString(),
            multipla_a: resA || prev.multipla_a || null,
            multipla_b: resB || prev.multipla_b || null,
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
    let stats = null; // declarado aqui para estar disponível ao propagar placar do 1ºT

    try {
      let jogoEncontradoNaAPI = false; // Declarar no escopo externo

      // Tentar pelo fixtureId salvo
      if (jogo.fixtureId) {
        const res = await buscarResultadoFixture(jogo.fixtureId);
        if (res) {
          placar = res.placar; golsCasa = res.golsCasa; golsFora = res.golsFora;
          // Propaga placar do 1º tempo para stats (usado em verificarAposta para apostas de tempo parcial)
          if (res.golsCasa1T != null) {
            if (!stats) stats = {};
            stats.golsCasa1T = res.golsCasa1T;
            stats.golsFora1T = res.golsFora1T;
          }
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
          const fixtures = json.response;
          if (!Array.isArray(fixtures) || fixtures.length === 0) {
            console.log(`⚠️ Fixtures vazios ou erro de API — cache não atualizado`);
          } else {
            cacheFixtures = fixtures;
            cacheFixtures._ts = agora;
          }
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
          const al = (a||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
          if (al.includes('escanteio') || al.includes('corner') || al.includes('canto')) return 'escanteios';
          if (al.includes('cartao') || al.includes('amarelo') || al.includes('card') || al.includes('yellow')) return 'cartoes';
          return m || '';
        };
        const mercadoEfetivo = inferirMercadoPre(jogo.mercado?.toLowerCase(), jogo.aposta);

        // Buscar stats detalhadas se precisar (cartões/escanteios)
        // Busca sempre que: aposta principal é escanteios/cartões OU existem alternativas nesses mercados
        const temAltStats = jogo.alternativas?.some(a => ['escanteios','cartoes'].includes(a.mercado));
        // stats já declarado no escopo externo — reset para busca de escanteios/cartões
        stats = null;
        if ((['escanteios','cartoes'].includes(mercadoEfetivo) || temAltStats) && fixtureIdUsado) {
          console.log(`    📊 Buscando stats para mercado: ${mercadoEfetivo}${temAltStats?' (alternativas)':''}`);
          stats = await buscarStatsFixture(fixtureIdUsado);
          if (!stats) console.log(`    ⚠️ Stats não encontradas para fixtureId: ${fixtureIdUsado}`);
          await sleep(300);
        }
        let resultado = verificarAposta(jogo, golsCasa, golsFora, stats);

        // Se pendente, tentar agente IA para interpretar apostas complexas (handicap, X2, etc)
        if (resultado === 'pendente') {
          console.log(`    🤖 Tentando agente IA para aposta complexa...`);
          try {
            resultado = await agentValidarAposta(jogo, golsCasa, golsFora, stats);
            console.log(`    🤖 Agente IA: ${resultado.toUpperCase()}`);
          } catch(e) {
            console.log(`    ⚠️ Agente IA falhou: ${e.message}`);
          }
        }

        console.log(`    ✅ ${placar} | mercado:"${jogo.mercado}" | aposta:"${jogo.aposta}" | casa:"${jogo.time_casa}" | fora:"${jogo.time_fora}" → ${resultado.toUpperCase()}`);

        // Se verificarAposta retornou pendente (ex: stats zeradas), mandar para web search na rotina 03h
        if (resultado === 'sem_stats') {
          // Stats zeradas — marcar pendente_ws com placar para web search buscar escanteios/cartões
          console.log(`    ⚠️ Stats zeradas — pendente_ws para web search buscar escanteios/cartões`);
          resultados.push({ encontrado: true, placar, placar_conhecido: placar, resultado_aposta: 'pendente_ws', motivo: 'stats zeradas — web search buscará escanteios/cartões', jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta, mercado: jogo.mercado });
        } else {
          // Calcular resultado real de cada mercado alternativo
          const mercadosResult = {};
          if (golsCasa !== null && golsFora !== null) {
            const totalGols = golsCasa + golsFora;
            // Gols
            mercadosResult.gols = {
              'Over 2.5': totalGols > 2.5 ? 'green' : 'red',
              'Under 2.5': totalGols < 2.5 ? 'green' : 'red',
              'Over 1.5': totalGols > 1.5 ? 'green' : 'red',
              'Ambos marcam': (golsCasa > 0 && golsFora > 0) ? 'green' : 'red'
            };
            // Resultado
            mercadosResult.resultado = {
              'Casa vence': golsCasa > golsFora ? 'green' : 'red',
              'Fora vence': golsFora > golsCasa ? 'green' : 'red',
              'Empate': golsCasa === golsFora ? 'green' : 'red',
              'Dupla casa (1X)': golsCasa >= golsFora ? 'green' : 'red',
              'Dupla fora (X2)': golsFora >= golsCasa ? 'green' : 'red'
            };
          }
          // Escanteios e cartões — só se a API trouxe stats reais (não zeradas)
          // Zero em casa E fora simultaneamente = liga sem cobertura de stats na API, não um 0 real
          const escSemCobertura = stats && stats.escanteiosTotal === 0 && stats.escanteiosCasa === 0 && stats.escanteiosFora === 0;
          const cartSemCobertura = stats && stats.cartoesTotal === 0 && stats.cartoesCasa === 0 && stats.cartoesFora === 0;
          if (stats?.escanteiosTotal != null && !escSemCobertura) {
            const esc = stats.escanteiosTotal;
            mercadosResult.escanteios = {};
            for (const linha of ['4.5','5.5','6.5','7.5','8.5','9.5','10.5','11.5','12.5','13.5','14.5']) {
              const l = parseFloat(linha);
              mercadosResult.escanteios[`Over ${linha}`] = esc > l ? 'green' : 'red';
              mercadosResult.escanteios[`Under ${linha}`] = esc < l ? 'green' : 'red';
            }
          }
          if (stats?.cartoesTotal != null && !cartSemCobertura) {
            const cart = stats.cartoesTotal;
            mercadosResult.cartoes = {};
            for (const linha of ['0.5','1.5','2.5','3.5','4.5','5.5','6.5','7.5']) {
              const l = parseFloat(linha);
              mercadosResult.cartoes[`Over ${linha}`] = cart > l ? 'green' : 'red';
              mercadosResult.cartoes[`Under ${linha}`] = cart < l ? 'green' : 'red';
            }
          }
          resultados.push({ encontrado: true, placar, resultado_aposta: resultado, motivo: `${jogo.time_casa} ${golsCasa} x ${golsFora} ${jogo.time_fora}`, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta, mercados_resultado: mercadosResult, escanteios_total: stats?.escanteiosTotal || null, cartoes_total: stats?.cartoesTotal || null });
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
        `Resultados futebol ${data}. Para cada jogo: "Time1 N-M Time2". Se escanteios/cartoes pedidos inclua "esc:X cart:Y". Se cancelado: "cancelado". Jogos: ${lista}`,
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
              // Se ainda pendente após web search (stats não encontradas), manter pendente para input manual
              if (res === 'pendente' || res === 'sem_stats') {
                console.log(`    ⏳ Stats não encontradas no web search — mantendo pendente para input manual`);
                pend.resultado_aposta = 'pendente';
                pend.motivo = `${pend.time_casa} ${gC} x ${gF} ${pend.time_fora} — stats indisponíveis, informe manualmente`;
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

  // Incluir todos os jogos no relatório — pendentes também (marcados como não resolvidos)
  const resultadosValidados = resultados.filter(r => ['green','red','cancelado','pendente'].includes(r.resultado_aposta));

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

  // Calcular distribuição por mercado apostado
  const mercadoApostado = {};
  const mercadoGreen = {};
  for (const res of resultadosValidados) {
    const a = apostas.find(x => x.id === res.jogo_id);
    const merc = a?.mercado || 'gols';
    mercadoApostado[merc] = (mercadoApostado[merc] || 0) + 1;
    if (res.resultado_aposta === 'green') mercadoGreen[merc] = (mercadoGreen[merc] || 0) + 1;
  }
  const distMercado = Object.entries(mercadoApostado).map(([m, n]) => {
    const g2 = mercadoGreen[m] || 0;
    const pct = Math.round((g2/n)*100);
    return `${m}: ${n} apostas → ${pct}% (${g2}G/${n-g2}R)`;
  }).join(' | ');

  // Calcular mercados subapostados (nunca ou pouco apostado mas teriam performado bem)
  const mercadosAlternativos = { gols: {green:0,total:0}, resultado: {green:0,total:0}, escanteios: {green:0,total:0}, cartoes: {green:0,total:0} };
  for (const res of resultadosValidados) {
    if (!res.mercados_resultado) continue;
    for (const [merc, apostasDict] of Object.entries(res.mercados_resultado)) {
      for (const [aposta, resAlt] of Object.entries(apostasDict)) {
        if (!mercadosAlternativos[merc]) continue;
        mercadosAlternativos[merc].total++;
        if (resAlt === 'green') mercadosAlternativos[merc].green++;
      }
    }
  }
  const subapostados = Object.entries(mercadosAlternativos)
    .filter(([merc, s]) => s.total > 0)
    .map(([merc, s]) => {
      const pct = Math.round((s.green/s.total)*100);
      const apostado = mercadoApostado[merc] || 0;
      const flag = apostado === 0 ? ' ← NUNCA APOSTADO HOJE' : apostado <= 1 ? ' ← SUBAPOSTADO' : '';
      return `${merc}: ${pct}% de greens possíveis${flag}`;
    }).join('\n');

  const promptDiario = `Analise as apostas do dia ${data}. Assertividade: ${assert}% (${g} green, ${r} red${p>0?`, ${p} pendentes`:''}).

DISTRIBUIÇÃO POR MERCADO APOSTADO HOJE:
${distMercado}

RESULTADOS DETALHADOS (com o que teria dado GREEN):
${detalhes}

${padroesTexto ? `PADRÕES POR LIGA:\n${padroesTexto}` : ''}

MERCADOS E SUAS TAXAS DE GREEN HOJE (apostados ou não):
${subapostados}

${baixaConfianca.length > 0 ? `APOSTAS DE CONFIANÇA BAIXA: ${baixaConfianca.join(', ')}` : ''}

ESCREVA O RELATÓRIO NESTA ESTRUTURA EXATA:

O QUE FIZ:
[por mercado: quantas apostas, % green, avaliação]

O QUE DEIXEI PASSAR:
[jogos específicos onde outro mercado teria dado green — cite o jogo, o mercado ignorado e o resultado]

PADRÃO IDENTIFICADO:
[o que está funcionando, o que não está, por liga]

INSTRUÇÃO PARA AMANHÃ:
[ações específicas: "priorizar escanteios quando média ≥ X", "evitar Over 2.5 em liga Y", etc.]

Seja direto e acionável. Máx 400 palavras. A IA que ler este relatório amanhã deve saber EXATAMENTE o que fazer diferente.`;

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

  const relatorio = await chamarIA(`${promptDiario}${blocoMultiplas}\n\nSe múltiplas RED, identifique jogo que quebrou. Máx 200 palavras.`, 1500);
  if (!relatorio) return;
  await dbSaveCalibracao('diario', data, data, relatorio, parseFloat(assert));
  console.log(`✅ Relatório diário — ${assert}%`);

  // Atualizar stats de green/red por liga na ligas_conhecidas
  // Usar alternativas salvas para calcular assertividade REAL por mercado
  const statsPorLiga = {};
  for (const res of resultadosValidados) {
    const aposta = apostas.find(x => x.id === res.jogo_id);
    if (!aposta?.ligaId) continue;
    if (!statsPorLiga[aposta.ligaId]) statsPorLiga[aposta.ligaId] = { green: 0, red: 0, mercados: {}, escanteios: null, cartoes: null };
    // Capturar valores absolutos para média da liga
    if (typeof res.escanteios_total === 'number' && res.escanteios_total > 0) statsPorLiga[aposta.ligaId].escanteios = res.escanteios_total;
    if (typeof res.cartoes_total === 'number' && res.cartoes_total > 0) statsPorLiga[aposta.ligaId].cartoes = res.cartoes_total;
    if (res.resultado_aposta === 'green') statsPorLiga[aposta.ligaId].green++;
    else if (res.resultado_aposta === 'red') statsPorLiga[aposta.ligaId].red++;

    // Acumular mercado principal apostado
    const mercado = aposta.mercado || 'gols';
    if (!statsPorLiga[aposta.ligaId].mercados[mercado]) statsPorLiga[aposta.ligaId].mercados[mercado] = { green: 0, red: 0 };
    if (res.resultado_aposta === 'green') statsPorLiga[aposta.ligaId].mercados[mercado].green++;
    else if (res.resultado_aposta === 'red') statsPorLiga[aposta.ligaId].mercados[mercado].red++;

    // Acumular mercados ALTERNATIVOS — calcular o que teria dado green com placar real e/ou stats reais
    if (aposta.alternativas?.length) {
      const statsAlt = (res.escanteios_total != null || res.cartoes_total != null) ? { escanteiosTotal: res.escanteios_total ?? 0, cartoesTotal: res.cartoes_total ?? 0 } : null;
      for (const alt of aposta.alternativas) {
        if (alt.mercado === mercado) continue; // já contou acima
        let resultadoAlt;
        if (['escanteios','cartoes'].includes(alt.mercado)) {
          // Usa mercados_resultado já calculado (cobre stats da API ou informadas manualmente)
          resultadoAlt = calcularResultadoAlternativaTexto(alt.aposta, res.mercados_resultado?.[alt.mercado]);
        } else if (res.placar) {
          const jogoAlt = { ...aposta, mercado: alt.mercado, aposta: alt.aposta };
          const [gcAlt, gfAlt] = res.placar.split('-').map(Number);
          resultadoAlt = verificarAposta(jogoAlt, gcAlt, gfAlt, statsAlt);
        }
        if (!['green','red'].includes(resultadoAlt)) continue;
        if (!statsPorLiga[aposta.ligaId].mercados[alt.mercado]) statsPorLiga[aposta.ligaId].mercados[alt.mercado] = { green: 0, red: 0 };
        if (resultadoAlt === 'green') statsPorLiga[aposta.ligaId].mercados[alt.mercado].green++;
        else statsPorLiga[aposta.ligaId].mercados[alt.mercado].red++;
      }
    }
  }
  const updatePromises = Object.entries(statsPorLiga).map(([ligaId, s]) => {
    const entradas = Object.entries(s.mercados || {});
    if (entradas.length === 0) {
      // Sem mercados, mas pode ter médias para salvar
      if (s.escanteios !== null || s.cartoes !== null) {
        return dbUpdateLigaStats(parseInt(ligaId), 0, 0, null, s.escanteios, s.cartoes);
      }
      return Promise.resolve();
    }
    return Promise.all(entradas.map(([mercado, ms], idx) => {
      // Salvar a média junto com a primeira chamada apenas (evita duplicar amostra)
      const esc = idx === 0 ? s.escanteios : null;
      const cart = idx === 0 ? s.cartoes : null;
      return dbUpdateLigaStats(parseInt(ligaId), ms.green, ms.red, mercado, esc, cart);
    }));
  });
  await Promise.all(updatePromises);
  console.log(`📊 Stats de ligas atualizadas: ${Object.keys(statsPorLiga).length} liga(s)`);
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
  const relatorio = await chamarIA(`Semanal ${inicio}-${hoje} | ${media}% | ${textos.substring(0,1000)} | Padrões e recomendações. Máx 150 palavras.`, 800);
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
  const relatorio = await chamarIA(`Mensal ${inicio}-${hoje} | ${media}% | ${textos.substring(0,1200)} | ${parseFloat(media)>=80?'Mantenha padrão.':'O que mudar?'} Máx 200 palavras.`, 1000);
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
  const relatorio = await chamarIA(`Semestral ${inicio}-${hoje} | ${media}% | ${textos.substring(0,1500)} | Evolução e estratégias. Máx 250 palavras.`, 1200);
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

  // 1. Validar o dia anterior — relatório gerado apenas na rotina 03h (validar-pendentes)
  // onde todos os jogos já terminaram e o resultado é completo
  await agentValidar(ontem, { forcarWebSearch: true });

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
    const todosjogos = row?.apostas?.jogos || [];
    // Considera apenas jogos válidos (não descartados e com odd confirmada)
    const jogosExistentes = todosjogos.filter(j => !j.descartado);
    const total = jogosExistentes.length;

    if (total >= 15) {
      console.log(`✅ ${diaAlvo}: já tem ${total} jogos válidos — pulando`);
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
    let resultado = null;
    try {
      resultado = await gerarApostasMultiAgente(diaAlvo, '13:00', faltam, timesJaSelecionados);
      if (!resultado?.jogos?.length) { console.log(`⚠️ Multi-agente sem jogos — fallback gerarApostas`); resultado = null; }
    } catch(e) { console.error('❌ Multi-agente falhou, usando fallback:', e.message); }
    if (!resultado) resultado = await gerarApostas(diaAlvo, '13:00', faltam, timesJaSelecionados);
    if (!resultado?.jogos?.length) {
      console.log(`⚠️ ${diaAlvo}: não foi possível gerar novos jogos`);
      continue;
    }

    // Garantir horário mínimo 13:00 nos jogos novos (belt-and-suspenders)
    resultado.jogos = resultado.jogos.filter(j => {
      const [hh, mm] = (j.horario || '00:00').split(':').map(Number);
      const ok = hh * 60 + mm >= 13 * 60;
      if (!ok) console.log(`  ⏰ Rejeitando jogo antes das 13h: ${j.time_casa} x ${j.time_fora} (${j.horario})`);
      return ok;
    });
    if (!resultado.jogos.length) { console.log(`⚠️ ${diaAlvo}: todos os novos jogos rejeitados por horário`); continue; }

    if (total === 0) {
      // Primeiro preenchimento — salvar normalmente
      resultado.jogos = aplicarTetoAtivos(resultado.jogos);
      await dbSave(diaAlvo, resultado);
      console.log(`✅ ${diaAlvo}: ${resultado.jogos.length} jogos salvos`);
    } else {
      // Complemento — mesclar com jogos existentes usando maior ID existente para evitar colisão
      const maxIdExistente = todosjogos.reduce((max, j) => Math.max(max, j.id || 0), 0);
      const jogosCompletos = {
        jogos: aplicarTetoAtivos([...jogosExistentes, ...resultado.jogos.map((j, i) => ({
          ...j,
          id: maxIdExistente + i + 1
        }))])
      };
      await dbSave(diaAlvo, jogosCompletos);
      console.log(`✅ ${diaAlvo}: complementado para ${jogosCompletos.jogos.filter(j=>!j.descartado).length} ativos`);
    }

    // Gerar múltiplas em background
    setTimeout(async () => {
      try {
        const rowAtual = await dbGet(diaAlvo);
        const multiplas = await gerarMultiplasComAgentes(diaAlvo, rowAtual?.apostas?.jogos || []);
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
  console.log(`\n⏰ Rotina 04h — verificando integridade de ${hoje} e ${amanha}`);

  for (const diaAlvo of [hoje, amanha]) {
    const row = await dbGetComMultiplas(diaAlvo);
    const jogos = row?.apostas?.jogos || [];
    const multiplas = row?.multiplas;

    // 1. Re-confirmar odds salvas contra a API (detecta odds de mercado errado, ex: 1º tempo vs jogo completo)
    for (const jogo of jogos) {
      if (!jogo.odd_mercado || jogo.descartado || !jogo.fixtureId) continue;
      const oddsFixture = await buscarOddsFixture(jogo.fixtureId, diaAlvo);
      if (!oddsFixture) continue;
      const oddConfirmada = selecionarOddFixture(oddsFixture, jogo.aposta, jogo.mercado, jogo.time_casa, jogo.time_fora);
      if (oddConfirmada === null) {
        console.log(`⚠️ ${jogo.time_casa}: odd não encontrada para "${jogo.aposta}" — mercado errado, removendo`);
        jogo.odd_mercado = null;
      } else if (parseFloat(oddConfirmada) < ODD_MINIMA) {
        console.log(`⚠️ ${jogo.time_casa}: odd confirmada ${oddConfirmada} < mínima ${ODD_MINIMA} — forçando re-análise`);
        jogo.odd_mercado = null;
      } else if (Math.abs(parseFloat(oddConfirmada) - parseFloat(jogo.odd_mercado)) > 0.15) {
        console.log(`⚠️ ${jogo.time_casa}: odd salva ${jogo.odd_mercado} diverge da API ${oddConfirmada} — corrigindo`);
        jogo.odd_mercado = parseFloat(oddConfirmada); // corrige para o valor real
      }
    }

    // 2. Verificar jogos — conta e também checa jogos sem odd_mercado validada
    // Inclui descartados sem odd — podem ter uma alternativa válida não tentada ainda
    const semOdd = jogos.filter(j => !j.odd_mercado);
    const precisaComplementar = jogos.length < 15 || semOdd.length > 0;

    if (precisaComplementar) {
      const motivo = jogos.length < 15
        ? `apenas ${jogos.length}/15 jogos`
        : `${semOdd.length} jogo(s) sem odd_mercado validada`;
      console.log(`⚠️ ${diaAlvo}: ${motivo} — acionando re-análise`);

      // Re-analisar jogos descartados por "sem odd" — podem ter odd disponível agora
      // Regra: sem odd = não vai para a lista. Re-análise só ATIVA se encontrar odd. Nunca remove ativos.
      const semOddDescartados = jogos.filter(j => j.descartado && j.descartado_motivo?.includes('sem odd'));
      const candidatosReanalise = [...semOdd, ...semOddDescartados].filter((j,i,arr) => arr.findIndex(x=>x.id===j.id)===i);
      if (candidatosReanalise.length > 0) {
        console.log(`🔄 Re-analisando ${candidatosReanalise.length} jogo(s) sem odd: ${candidatosReanalise.map(j=>j.time_casa+' x '+j.time_fora).join(', ')}`);
        const jogosAtualizados = [...jogos];
        for (const jogo of candidatosReanalise) {
          if (!jogo.fixtureId) continue;
          const oddsFixture = await buscarOddsFixture(jogo.fixtureId, diaAlvo);
          if (!oddsFixture) {
            // Sem odds na API — descarta (ou mantém descartado)
            jogo.descartado = true; jogo.descartado_motivo = 'sem odds na API';
            console.log(`  ✂️ ${jogo.time_casa} x ${jogo.time_fora} — sem odds na API, não entra na lista`);
            continue;
          }
          const mercadosDisp = formatarMercadosDisponiveisParaIA(oddsFixture);
          const promptReanalise = `Jogo Copa/Liga: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga||''}, ${jogo.horario||''})\nMotivo sem odd: aposta original "${jogo.aposta}" não disponível ou odd < 1.25\n\nMercados DISPONÍVEIS com odd ≥ 1.25:\n${mercadosDisp}\n\nForma casa: ${jogo.forma_casa||'?'} | Fora: ${jogo.forma_fora||'?'} | Gols: ${jogo.media_gols_casa||'?'}+${jogo.media_gols_fora||'?'}\n\nEscolha a MELHOR aposta. Confiança ALTA, odd ≥ 1.25. Mercados de tempo parcial válidos (diga o período).\nRetorne JSON: {"aposta":"...","mercado":"gols|resultado|escanteios|cartoes","confianca":"alta","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
          try {
            const resp = await chamarIA(promptReanalise, 800);
            const m = resp?.match(/\{[\s\S]*\}/);
            if (m) {
              const nova = JSON.parse(m[0]);
              if (nova.aposta && nova.mercado && nova.confianca === 'alta') {
                const oddReal = selecionarOddFixture(oddsFixture, nova.aposta, nova.mercado, jogo.time_casa, jogo.time_fora);
                const oddNum = oddReal ? parseFloat(oddReal) : null;
                if (oddNum && oddNum >= ODD_MINIMA) {
                  console.log(`  ✅ Re-análise: ${jogo.time_casa} x ${jogo.time_fora} → ${nova.aposta} @ ${oddNum}`);
                  jogo.aposta_original = jogo.aposta; jogo.mercado_original = jogo.mercado;
                  jogo.aposta = nova.aposta; jogo.mercado = nova.mercado;
                  jogo.odd_mercado = oddNum; jogo.confianca = 'alta';
                  jogo.justificativa = nova.justificativa || nova.razao || jogo.justificativa;
                  jogo.descartado = false;
                } else {
                  console.log(`  ❌ Re-análise falhou para ${jogo.time_casa}: odd não confirmada. Não entra na lista.`);
                  jogo.descartado = true; jogo.descartado_motivo = `re-análise: ${nova.aposta} sem odd confirmada`;
                }
              } else {
                jogo.descartado = true; jogo.descartado_motivo = 're-análise: sem aposta válida';
              }
            } else {
              jogo.descartado = true; jogo.descartado_motivo = 're-análise: resposta inválida';
            }
          } catch(e) { console.error(`  Erro re-análise ${jogo.time_casa}:`, e.message); jogo.descartado = true; }
        }
        // Salva jogos atualizados antes de complementar
        await dbSave(diaAlvo, { jogos: aplicarTetoAtivos(jogosAtualizados) });
      }

      // Complementar se ainda faltam jogos (descontando descartados)
      const rowAtualizado = await dbGet(diaAlvo);
      const jogosValidos = (rowAtualizado?.apostas?.jogos || []).filter(j => !j.descartado);
      if (jogosValidos.length < 15) {
        const faltam = 15 - jogosValidos.length;
        const timesJaSelecionados = new Set(
          jogosValidos.flatMap(j => [j.time_casa?.toLowerCase(), j.time_fora?.toLowerCase()]).filter(Boolean)
        );
        console.log(`🔄 ${diaAlvo}: complementando ${faltam} jogo(s)`);
        let resultado = null;
        try {
          resultado = await gerarApostasMultiAgente(diaAlvo, '13:00', faltam, timesJaSelecionados);
          if (!resultado?.jogos?.length) resultado = null;
        } catch(e) { console.error('❌ Multi-agente falhou:', e.message); }
        if (!resultado) resultado = await gerarApostas(diaAlvo, '13:00', faltam, timesJaSelecionados);
        if (resultado?.jogos?.length) {
          resultado.jogos = resultado.jogos.filter(j => {
            const [hh, mm] = (j.horario || '00:00').split(':').map(Number);
            const ok = hh * 60 + mm >= 13 * 60;
            if (!ok) console.log(`  ⏰ Rejeitando jogo antes das 13h: ${j.time_casa} x ${j.time_fora} (${j.horario})`);
            return ok;
          });
          if (resultado.jogos.length) {
            const jogosCompletos = {
              jogos: aplicarTetoAtivos([...jogosValidos, ...resultado.jogos.map((j, i) => ({...j, id: Math.max(...(rowAtualizado?.apostas?.jogos||[]).map(x=>x.id||0), 0) + i + 1}))])
            };
            await dbSave(diaAlvo, jogosCompletos);
            console.log(`✅ ${diaAlvo}: ${jogosCompletos.jogos.filter(j=>!j.descartado).length} ativos após complemento`);
          }
        }
      }
    } else {
      console.log(`✅ ${diaAlvo}: ${jogos.length} jogos com odds validadas OK`);
    }

    // 2. Verificar múltiplas
    if (!multiplas?.multipla_a || !multiplas?.multipla_b) {
      console.log(`⚠️ ${diaAlvo}: múltiplas ausentes — gerando`);
      const rowAtual = await dbGet(diaAlvo);
      const novasMultiplas = await gerarMultiplasComAgentes(diaAlvo, rowAtual?.apostas?.jogos || []);
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
      const norm = s => s?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim() || '';
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

app.get('/admin/usuarios', async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/oddlab_usuarios?select=nome,device_id,acessos,primeiro_acesso,ultimo_acesso&order=acessos.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    res.json({ ok: true, usuarios: Array.isArray(rows) ? rows : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Busca fixture por nome de times ao vivo na API-Football
app.get('/buscar-fixture', async (req, res) => {
  const { casa, fora, data } = req.query;
  if (!casa && !fora) return res.status(400).json({ error: 'Informe ao menos um time (casa ou fora)' });

  try {
    const dataAlvo = data || new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/').reverse().join('-');
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
    const nc = norm(casa), nf = norm(fora);

    // Usa o cache de fixtures do dia se disponível (não consome req)
    // Senão chama a API diretamente
    let fixtures = [];
    const cached = await buscarFixturesPorData(dataAlvo); // já usa cache interno
    if (cached && cached.length) {
      fixtures = cached;
      console.log(`🔍 buscar-fixture: usando cache de ${fixtures.length} fixtures para ${dataAlvo}`);
    } else {
      // Fallback: chama /fixtures?date= diretamente
      if (!contarRequisicao()) return res.status(429).json({ error: 'Limite atingido' });
      const r = await fetch(
        `https://v3.football.api-sports.io/fixtures?date=${dataAlvo}`,
        { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
      );
      const json = await r.json();
      fixtures = json.response || [];
      console.log(`🔍 buscar-fixture: API retornou ${fixtures.length} fixtures para ${dataAlvo}`);
    }

    // Filtra por nome (normalizado, match parcial pela primeira palavra)
    const matches = fixtures.filter(f => {
      const hn = norm(f.teams?.home?.name || f.timeCasa || '');
      const an = norm(f.teams?.away?.name || f.timeFora || '');
      const casaOk = !nc || hn.includes(nc.split(' ')[0]) || nc.split(' ')[0].length > 2 && hn.split(' ').some(w => nc.includes(w));
      const foraOk = !nf || an.includes(nf.split(' ')[0]) || nf.split(' ')[0].length > 2 && an.split(' ').some(w => nf.includes(w));
      return casaOk && foraOk;
    });

    res.json({
      data: dataAlvo,
      total: matches.length,
      fonte: fixtures === cached ? 'cache' : 'api',
      fixtures: matches.map(f => {
        // Suporta tanto o formato da API quanto o formato do cache interno
        const isCacheFormat = !!f.timeCasa;
        return {
          fixtureId: isCacheFormat ? f.fixtureId : f.fixture?.id,
          time_casa: isCacheFormat ? f.timeCasa : f.teams?.home?.name,
          time_fora: isCacheFormat ? f.timeFora : f.teams?.away?.name,
          horario: isCacheFormat ? f.horario : (f.fixture?.date ? new Date(f.fixture.date).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '--:--'),
          liga: isCacheFormat ? f.liga : f.league?.name,
          pais: isCacheFormat ? '' : f.league?.country,
          status: isCacheFormat ? 'NS' : f.fixture?.status?.short,
        };
      })
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lista bookmakers disponíveis na API-Football (para encontrar ID da Estrela Bet etc.)
app.get('/bookmakers-lista', async (req, res) => {
  const { busca } = req.query;
  try {
    if (!contarRequisicao()) return res.status(429).json({ error: 'Limite atingido' });
    const r = await fetch('https://v3.football.api-sports.io/odds/bookmakers', {
      headers: { 'x-apisports-key': APIFOOTBALL_KEY }
    });
    const json = await r.json();
    let lista = json.response || [];
    if (busca) {
      const b = busca.toLowerCase();
      lista = lista.filter(bm => bm.name?.toLowerCase().includes(b));
    }
    res.json({ total: lista.length, bookmakers: lista });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Nomes candidatos da Estrela Bet no API-Football (verificar via /bookmakers-lista)
const ESTRELA_BET_NOMES = ['estrela bet','estrelabet','estrelabet','estrela'];

// Endpoint de teste de odds — mostra todos os bookmakers, disponibilidade e Estrela Bet
app.get('/testar-odds', async (req, res) => {
  const { fixtureId, data } = req.query;
  if (!fixtureId) return res.status(400).json({ error: 'fixtureId obrigatório' });
  const dataAlvo = data || new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/').reverse().join('-');

  try {
    if (!contarRequisicao()) return res.status(429).json({ error: 'Limite de requisições atingido' });

    const resApi = await fetch(
      `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`,
      { headers: { 'x-apisports-key': APIFOOTBALL_KEY } }
    );
    if (!resApi.ok) return res.status(resApi.status).json({ error: `API-Football HTTP ${resApi.status}` });

    const json = await resApi.json();
    const entry = json.response?.[0];
    if (!entry) return res.json({ fixtureId, bookmakers: [], odds_calculadas: null, msg: 'Sem dados para este fixture' });

    const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();

    // Estrutura detalhada por bookmaker com disponibilidade por mercado
    const detalhes = (entry.bookmakers || []).map(bm => {
      const isEstrela = ESTRELA_BET_NOMES.some(n => normStr(bm.name).includes(n));
      return {
        bookmaker_id: bm.id,
        bookmaker_nome: bm.name,
        is_estrela_bet: isEstrela,
        mercados: (bm.bets || []).map(bet => ({
          bet_id: bet.id,
          bet_nome: bet.name,
          disponivel: (bet.values||[]).length > 0,
          valores: (bet.values || []).map(v => ({ aposta: v.value, odd: v.odd }))
        }))
      };
    });

    // Calcula resultado final reutilizando os dados já buscados (sem segunda chamada API)
    const oddsParsed = parsearBookmakersOdds(entry.bookmakers || []);
    // Também popula o cache para chamadas futuras (ex: geração de apostas)
    const cacheKey = `${dataAlvo}|${fixtureId}`;
    if (!oddsFixtureCache.has(cacheKey)) oddsFixtureCache.set(cacheKey, oddsParsed);

    // Estrela Bet separada
    const estrelaBet = detalhes.find(bm => bm.is_estrela_bet) || null;

    // Tabela de disponibilidade: para cada mercado, quais bookmakers têm
    const mercadosBkMap = {};
    for (const bm of detalhes) {
      for (const m of bm.mercados) {
        if (!mercadosBkMap[m.bet_nome]) mercadosBkMap[m.bet_nome] = [];
        mercadosBkMap[m.bet_nome].push({ bk: bm.bookmaker_nome, id: bm.bookmaker_id, disponivel: m.disponivel });
      }
    }

    // Monta tabela: mercado → aposta → [{ casa, odd }] ordenado por odd desc
    const oddsporCasa = {};
    for (const bm of (entry.bookmakers || [])) {
      for (const bet of (bm.bets || [])) {
        const key = bet.name;
        if (!oddsporCasa[key]) oddsporCasa[key] = {};
        for (const v of (bet.values || [])) {
          if (!oddsporCasa[key][v.value]) oddsporCasa[key][v.value] = [];
          oddsporCasa[key][v.value].push({ casa: bm.name, odd: parseFloat(v.odd) });
        }
      }
    }
    // Ordena apostas por odd desc dentro de cada mercado
    for (const mercado of Object.values(oddsporCasa))
      for (const aposta of Object.keys(mercado))
        mercado[aposta].sort((a, b) => b.odd - a.odd);

    res.json({
      fixtureId: parseInt(fixtureId),
      fixture: {
        time_casa: entry.fixture?.home_team,
        time_fora: entry.fixture?.away_team,
        liga: entry.league?.name,
        data: entry.fixture?.date?.substring(0,10),
      },
      total_bookmakers: detalhes.length,
      estrela_bet: estrelaBet,
      estrela_bet_encontrada: !!estrelaBet,
      odds_por_casa: oddsporCasa,
      bookmakers: detalhes,
      disponibilidade_por_mercado: mercadosBkMap,
      odds_calculadas: oddsParsed,
      chaves_disponiveis: oddsParsed ? Object.keys(oddsParsed).sort() : [],
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok', api: 'API-Football v3',
  api_suspensa: apiSuspensa, api_erro: apiErrorMsg || null,
  req_hoje: reqHoje, limite: LIMITE_SEGURO,
  custo_hoje_usd: parseFloat(custoHoje.toFixed(4)),
  chamadas_ia: chamadas,
  alerta_custo: custoHoje > ALERTA_CUSTO_DIA
}));

// Busca fixtures por time e data, retorna odds brutas do fixture encontrado
// Lista todos os fixtures de uma data com status de odds apostáveis
app.get('/fixtures-odds', async (req, res) => {
  const dataAlvo = req.query.data || hojeStr();
  try {
    const fixtures = await buscarFixturesPorData(dataAlvo);
    const result = [];
    for (const f of fixtures) {
      const status = f.fixture?.status?.short;
      const liga = f.league?.name || '';
      const pais = f.league?.country || '';
      const fixtureId = f.fixture?.id;
      const home = f.teams?.home?.name;
      const away = f.teams?.away?.name;
      const odds = fixtureId ? await buscarOddsFixture(fixtureId, dataAlvo) : null;
      const apostavel = odds ? Object.entries(odds).filter(([k,v]) =>
        v >= ODD_MINIMA && v <= 5 &&
        MERCADOS_APOSTAVEL.some(p => k.startsWith(p)) &&
        !k.includes('total - home') && !k.includes('total - away')
      ) : [];
      result.push({
        fixture_id: fixtureId,
        liga, pais, status,
        casa: home, fora: away,
        tem_odds: !!odds,
        mercados_apostavel: apostavel.length,
        melhor: apostavel.length ? apostavel.sort((a,b) => Math.abs(a[1]-1.7) - Math.abs(b[1]-1.7))[0] : null,
      });
    }
    result.sort((a,b) => b.mercados_apostavel - a.mercados_apostavel);
    res.json({ data: dataAlvo, total: result.length, com_odds: result.filter(r=>r.mercados_apostavel>0).length, fixtures: result });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/odds-jogo', async (req, res) => {
  const { casa, fora, data } = req.query;
  if (!casa || !fora) return res.status(400).json({ erro: 'Informe casa e fora' });
  const dataAlvo = data || hojeStr();
  try {
    const fixtures = await buscarFixturesPorData(dataAlvo);
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim();
    const nc = norm(casa), nf = norm(fora);
    const match = fixtures.find(f => {
      const h = norm(f.teams?.home?.name), a = norm(f.teams?.away?.name);
      return (h.includes(nc.split(' ')[0]) || nc.includes(h.split(' ')[0])) &&
             (a.includes(nf.split(' ')[0]) || nf.includes(a.split(' ')[0]));
    });
    if (!match) return res.json({ erro: `Fixture não encontrado para "${casa}" x "${fora}" em ${dataAlvo}`, total_fixtures: fixtures.length });
    const fixtureId = match.fixture?.id;
    const odds = await buscarOddsFixture(fixtureId, dataAlvo, true);
    res.json({
      fixture_id: fixtureId,
      casa: match.teams?.home?.name,
      fora: match.teams?.away?.name,
      liga: match.league?.name,
      horario: new Date(match.fixture?.timestamp * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
      status: match.fixture?.status?.short,
      mercados_disponiveis: odds || 'Sem odds na API para este fixture'
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

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
          const multiplas = await gerarMultiplasComAgentes(data, resultado.jogos);
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
  console.log(`\n⏰ Rotina 04h30 (múltiplas) — verificando ${hoje} e ${amanha}`);

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
      const novasMultiplas = await gerarMultiplasComAgentes(diaAlvo, jogos);
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

// Rotinas do cron — ordem:
// 03h00 → /validar-pendentes   (valida ontem, gera relatório diário)
// 03h30 → /rotina-04h          (gera apostas de hoje e amanhã)
// 04h00 → /rotina-04h30        (verifica 15 jogos, complementa se faltar, corrige fixtureIds)
// 04h30 → /rotina-05h          (verifica e gera múltiplas)

app.post('/rotina-04h', async (req, res) => {
  res.json({ mensagem: 'Rotina 03h30 — gerando apostas' });
  rotina04h().catch(console.error);
});

// Gatilhos manuais para crons do Telegram (para teste)
app.post('/telegram/testar-envio', async (req, res) => {
  const svc = require('./services/telegramService');
  res.json({ mensagem: 'Disparando enviarListaDeDia...' });
  svc.enviarListaDeDia().catch(console.error);
});

app.post('/telegram/testar-edicao', async (req, res) => {
  const svc = require('./services/telegramService');
  res.json({ mensagem: 'Disparando editarMensagemListaAnterior + responderValidacoesAnalises...' });
  svc.editarMensagemListaAnterior().catch(console.error);
  svc.responderValidacoesAnalises().catch(console.error);
});

app.post('/telegram/testar-analises', async (req, res) => {
  const svc = require('./services/telegramService');
  res.json({ mensagem: 'Disparando enviarMensagensAnalisesAgendasPremium...' });
  svc.enviarMensagensAnalisesAgendasPremium().catch(console.error);
});

app.post('/rotina-04h30', async (req, res) => {
  res.json({ mensagem: 'Rotina 04h00 — verificando integridade e complementando' });
  rotina05h().catch(console.error);
});

app.post('/rotina-05h', async (req, res) => {
  res.json({ mensagem: 'Rotina 04h30 — verificando e gerando múltiplas' });
  rotinaMultiplas().catch(console.error);
});

app.post('/rotina-complemento', async (req, res) => {
  res.json({ mensagem: 'Complemento diurno iniciado — preenchendo slots vazios' });
  rotinaComplementoDiurno().catch(console.error);
});

// Debug: mostra jogosComp ordenados que _carregarFixturesComStats selecionaria
app.get('/debug-fixtures/:data', async (req, res) => {
  const data = req.params.data;
  const metaJogos = parseInt(req.query.meta) || 7;
  try {
    const row = await dbGet(data);
    const jogosExistentes = row?.apostas?.jogos || [];
    const timesIgnorar = new Set(jogosExistentes.flatMap(j => [j.time_casa?.toLowerCase(), j.time_fora?.toLowerCase()]).filter(Boolean));

    const fixtures = await buscarFixturesPorData(data);
    const jogosMap = new Map(), jogosComp = new Map();
    const [hM, mM] = ['07', '00'].map(Number);
    const minMinutos = hM * 60 + mM;

    for (const f of fixtures) {
      const ts = f.fixture?.timestamp, status = f.fixture?.status?.short, ligaId = f.league?.id;
      const timeCasa = f.teams?.home?.name, timeFora = f.teams?.away?.name;
      if (!ts || !timeCasa || !timeFora || status !== 'NS') continue;
      const ligaNome = f.league?.name || '', pais = f.league?.country || '';
      const subRegex = /\bU(1[7-9]|20)\b/i;
      if (subRegex.test(timeCasa) || subRegex.test(timeFora) || subRegex.test(ligaNome)) continue;
      const ligaLower = ligaNome.toLowerCase();
      if (ligaLower.includes('amateur') || ligaLower.includes('reserve') || ligaLower.includes('youth')) continue;
      const dt = new Date(ts * 1000);
      let hBR = dt.getUTCHours() - 3; const mBR = dt.getUTCMinutes();
      if (hBR < 0) hBR += 24;
      const totalMin = hBR * 60 + mBR;
      if (totalMin < minMinutos || (hBR >= 1 && hBR < 10)) continue;
      const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
      const key = `${timeCasa}-${timeFora}`, paisLower = pais.toLowerCase();
      if (LIGAS_IGNORAR.has(ligaId) || ligaBrasileiraNaoRelevante(ligaNome, pais)) continue;
      const ligaMatch = LIGAS_PRIORITY[ligaId];
      if (ligaMatch) {
        if (!jogosMap.has(key)) jogosMap.set(key, { liga: ligaMatch.nome, pri: ligaMatch.pri, timeCasa, timeFora, horario: hStr });
      } else {
        const EUROPEUS = ["england","scotland","spain","italy","france","germany","portugal","netherlands","belgium","turkey","austria","switzerland","denmark","norway","croatia","serbia","ukraine","greece","russia","poland","czech-republic","finland","sweden","hungary","romania","slovakia","bulgaria","georgia","albania","armenia","estonia","latvia","lithuania","luxembourg","malta","wales","ireland","iceland","cyprus","north macedonia","montenegro","kosovo","andorra","faroe islands","gibraltar","bosnia"];
        const SUL_AMERICANOS = ["argentina","colombia","chile","uruguay","peru","venezuela","bolivia","ecuador","paraguay"];
        const AFRICA_ORIENTE_L = ["egypt","morocco","algeria","tunisia","saudi-arabia","uae","qatar","kuwait","jordan","iran","nigeria","ghana","senegal","ivory coast","cameroon","south africa"];
        const CONCACAF_L = ["canada","usa","mexico","costa rica","honduras","el salvador","guatemala","panama","jamaica","trinidad and tobago"];
        let priComp = 200;
        if (EUROPEUS.includes(paisLower)) priComp = 90;
        else if (SUL_AMERICANOS.includes(paisLower)) priComp = 70;
        else if (CONCACAF_L.includes(paisLower)) priComp = 75;
        else if (AFRICA_ORIENTE_L.includes(paisLower)) priComp = 80;
        else if (paisLower === 'brazil' || paisLower === 'brasil') priComp = 60;
        if (!jogosComp.has(key)) jogosComp.set(key, { liga: `${ligaNome} (${pais})`, ligaId, pri: priComp, pais, timeCasa, timeFora, horario: hStr });
      }
    }

    const compOrdenado = Array.from(jogosComp.values())
      .filter(j => !timesIgnorar.has(j.timeCasa?.toLowerCase()) && !timesIgnorar.has(j.timeFora?.toLowerCase()))
      .sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

    res.json({
      data, meta: metaJogos,
      jogosMap_count: jogosMap.size, jogosComp_count: jogosComp.size,
      comp_apos_filtro: compOrdenado.length,
      top30_comp: compOrdenado.slice(0, 30).map(j => ({ pri: j.pri, liga: j.liga, casa: j.timeCasa, fora: j.timeFora, horario: j.horario }))
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/reprocessar-analisando', async (req, res) => {
  const { data } = req.body;
  const hoje = hojeStr();
  const amanha = diaOffset(hoje, 1);
  res.json({ mensagem: 'Reprocessando jogos analisando...', dias: data ? [data] : [hoje, amanha] });
  for (const d of (data ? [data] : [hoje, amanha])) {
    reprocessarAnalisando(d).catch(console.error);
  }
});

// Sincronizar histórico de assertividade das ligas com dados reais dos últimos 60 dias
app.post('/sincronizar-ligas', async (req, res) => {
  res.json({ mensagem: 'Sincronização de ligas iniciada' });
  try {
    const hoje = hojeStr();
    // Buscar últimos 60 dias
    const promises = [];
    for (let i = 0; i < 60; i++) {
      const d = diaOffset(hoje, -i);
      promises.push(dbGet(d).catch(() => null));
    }
    const dias = (await Promise.all(promises)).filter(d => d?.apostas?.jogos?.length && d?.resultados?.apostas?.length);

    // Consolidar green/red por ligaId e por mercado, + médias de escanteios/cartoes
    const statsPorLiga = {};
    for (const dia of dias) {
      const apostas = dia.apostas.jogos;
      const resultados = dia.resultados.apostas;
      for (const res of resultados) {
        const aposta = apostas.find(x => x.id === res.jogo_id);
        if (!aposta?.ligaId) continue;
        if (!statsPorLiga[aposta.ligaId]) statsPorLiga[aposta.ligaId] = { green: 0, red: 0, total: 0, mercados: {}, escanteios: [], cartoes: [] };

        // Acumular amostras de escanteios/cartoes totais (independente do mercado apostado)
        if (typeof res.escanteios_total === 'number' && res.escanteios_total > 0) statsPorLiga[aposta.ligaId].escanteios.push(res.escanteios_total);
        if (typeof res.cartoes_total === 'number' && res.cartoes_total > 0) statsPorLiga[aposta.ligaId].cartoes.push(res.cartoes_total);

        if (!['green','red'].includes(res.resultado_aposta)) continue;
        if (res.resultado_aposta === 'green') statsPorLiga[aposta.ligaId].green++;
        else statsPorLiga[aposta.ligaId].red++;
        statsPorLiga[aposta.ligaId].total++;
        // Acumular por mercado (aposta principal)
        const mercado = aposta.mercado || 'gols';
        if (!statsPorLiga[aposta.ligaId].mercados[mercado]) statsPorLiga[aposta.ligaId].mercados[mercado] = { green: 0, red: 0 };
        if (res.resultado_aposta === 'green') statsPorLiga[aposta.ligaId].mercados[mercado].green++;
        else statsPorLiga[aposta.ligaId].mercados[mercado].red++;

        // Acumular mercados ALTERNATIVOS — aproveitar TODO dado já coletado, sem custo extra
        if (aposta.alternativas?.length) {
          const statsAlt = (res.escanteios_total != null || res.cartoes_total != null) ? { escanteiosTotal: res.escanteios_total ?? 0, cartoesTotal: res.cartoes_total ?? 0 } : null;
          for (const alt of aposta.alternativas) {
            if (alt.mercado === mercado) continue;
            let resultadoAlt;
            if (['escanteios','cartoes'].includes(alt.mercado)) {
              resultadoAlt = calcularResultadoAlternativaTexto(alt.aposta, res.mercados_resultado?.[alt.mercado]);
            } else if (res.placar) {
              const jogoAlt = { ...aposta, mercado: alt.mercado, aposta: alt.aposta };
              const [gcAlt2, gfAlt2] = res.placar.split('-').map(Number);
              resultadoAlt = verificarAposta(jogoAlt, gcAlt2, gfAlt2, statsAlt);
            }
            if (!['green','red'].includes(resultadoAlt)) continue;
            if (!statsPorLiga[aposta.ligaId].mercados[alt.mercado]) statsPorLiga[aposta.ligaId].mercados[alt.mercado] = { green: 0, red: 0 };
            if (resultadoAlt === 'green') statsPorLiga[aposta.ligaId].mercados[alt.mercado].green++;
            else statsPorLiga[aposta.ligaId].mercados[alt.mercado].red++;
          }
        }
      }
    }

    // Atualizar cada liga no banco com green/red/total/mercados + médias
    let atualizadas = 0;
    for (const [ligaId, s] of Object.entries(statsPorLiga)) {
      try {
        const body = { green: s.green, red: s.red, total: s.total, mercados: s.mercados };
        if (s.escanteios.length > 0) {
          body.media_escanteios = s.escanteios.reduce((a,b)=>a+b,0) / s.escanteios.length;
          body.amostras_escanteios = s.escanteios.length;
        }
        if (s.cartoes.length > 0) {
          body.media_cartoes = s.cartoes.reduce((a,b)=>a+b,0) / s.cartoes.length;
          body.amostras_cartoes = s.cartoes.length;
        }
        await fetch(`${SUPABASE_URL}/rest/v1/ligas_conhecidas?liga_id=eq.${ligaId}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        atualizadas++;
      } catch(e) { console.error(`Erro atualizando liga ${ligaId}:`, e.message); }
    }
    console.log(`✅ Sincronização concluída: ${atualizadas} ligas atualizadas com histórico real`);
    Object.entries(statsPorLiga)
      .sort((a,b) => (b[1].total - a[1].total))
      .slice(0, 10)
      .forEach(([id, s]) => {
        const pct = Math.round((s.green/s.total)*100);
        console.log(`  Liga ${id}: ${pct}% (${s.green}G/${s.red}R — ${s.total} apostas)`);
      });
  } catch(e) { console.error('Erro sincronização ligas:', e.message); }
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
      // Gerar relatório diário — só aqui (03h), quando todos os jogos já terminaram
      const calExistente = await dbGetCalibracaoPorPeriodo('diario', ontem).catch(()=>null);
      if (!calExistente) {
        await agentDiario(ontem);
        console.log(`✅ Relatório de ${ontem} gerado`);
      } else {
        console.log(`✅ Relatório de ${ontem} já existe — mantendo`);
      }
    } else {
      // Todos validados — garantir que relatório existe, mas não reger se já tem
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
  const { data, jogo_id, placar, placar_ht, resultado } = req.body;
  if (!data || !jogo_id) return res.status(400).json({ error: 'Parâmetros inválidos' });

  const row = await dbGet(data);
  if (!row?.resultados?.apostas) return res.status(404).json({ error: 'Sem resultados para esta data' });

  const apostaRes = row.resultados.apostas.find(a => a.jogo_id === jogo_id);
  const jogo = row.apostas?.jogos?.find(j => j.id === jogo_id);
  if (!apostaRes) return res.status(404).json({ error: 'Aposta não encontrada' });

  let novoResultado = apostaRes.resultado_aposta;
  let novoPlacar = apostaRes.placar;

  if (resultado && ['green','red','cancelado','pendente'].includes(resultado)) {
    novoResultado = resultado;
  } else if (jogo && (placar?.match(/^\d+-\d+$/) || placar_ht?.match(/^\d+-\d+$/))) {
    // Monta stats de intervalo se placar_ht fornecido
    let statsParaVerif = null;
    if (placar_ht && placar_ht.match(/^\d+-\d+$/)) {
      const [gC1T, gF1T] = placar_ht.split('-').map(Number);
      statsParaVerif = { golsCasa1T: gC1T, golsFora1T: gF1T, confirmado: true };
    }

    if (placar && placar.match(/^\d+-\d+$/)) {
      // Placar final informado — calcula resultado completo
      const [gC, gF] = placar.split('-').map(Number);
      novoPlacar = placar;
      novoResultado = verificarAposta(jogo, gC, gF, statsParaVerif);
      if (novoResultado === 'sem_stats') novoResultado = statsParaVerif ? 'pendente' : 'pendente';
    } else if (statsParaVerif) {
      // Só placar_ht informado — calcula usando gols do HT como placar final (para mercados de 1º tempo)
      const [gC1T, gF1T] = placar_ht.split('-').map(Number);
      const tentativa = verificarAposta(jogo, gC1T, gF1T, statsParaVerif);
      if (tentativa !== 'sem_stats') novoResultado = tentativa;
    }
    console.log(`✏️ ${apostaRes.time_casa}: placar=${placar||'—'} ht=${placar_ht||'—'} | ${apostaRes.resultado_aposta}→${novoResultado}`);
  }

  const apostas = row.resultados.apostas.map(a =>
    a.jogo_id === jogo_id
      ? { ...a, placar: novoPlacar, resultado_aposta: novoResultado, corrigido_manualmente: true, ...(placar_ht ? { placar_ht } : {}) }
      : a
  );

  await dbSaveResultados(data, { ...row.resultados, apostas });
  res.json({ ok: true, mensagem: `Corrigido: ${novoPlacar} → ${novoResultado}`, resultado: novoResultado, placar: novoPlacar });
});

// Corrigir campos de uma aposta (aposta, mercado, odd_mercado, descartado, etc.)
app.post('/corrigir-aposta', async (req, res) => {
  const { data, time_casa, campos } = req.body;
  if (!data || !time_casa || !campos || typeof campos !== 'object') {
    return res.status(400).json({ error: 'data, time_casa e campos obrigatórios' });
  }
  const row = await dbGet(data);
  if (!row?.apostas?.jogos) return res.status(404).json({ error: 'Sem apostas para essa data' });

  const idx = row.apostas.jogos.findIndex(j => j.time_casa === time_casa);
  if (idx === -1) return res.status(404).json({ error: `Jogo de ${time_casa} não encontrado em ${data}` });

  const antes = { ...row.apostas.jogos[idx] };
  row.apostas.jogos[idx] = { ...antes, ...campos };
  await dbSave(data, row.apostas);

  console.log(`✏️ /corrigir-aposta [${data}] ${time_casa}: ${JSON.stringify(campos)}`);
  res.json({ ok: true, antes, depois: row.apostas.jogos[idx] });
});

app.post('/anular-jogo', async (req, res) => {
  const { data, jogo_id } = req.body;
  if (!data || !jogo_id) return res.status(400).json({ error: 'data e jogo_id obrigatórios' });
  try {
    const row = await dbGet(data);
    if (!row?.apostas?.jogos) return res.status(404).json({ error: 'Sem apostas para essa data' });

    const jogo = row.apostas.jogos.find(j => j.id === jogo_id);
    if (!jogo) return res.status(404).json({ error: 'Jogo não encontrado' });

    const resultadosExistentes = row.resultados?.apostas || [];
    const resExistente = resultadosExistentes.find(r => r.jogo_id === jogo_id);

    let novosResultados;
    if (resExistente) {
      novosResultados = resultadosExistentes.map(r =>
        r.jogo_id === jogo_id
          ? { ...r, resultado_aposta: 'cancelado', anulado_manualmente: true }
          : r
      );
    } else {
      novosResultados = [...resultadosExistentes, {
        jogo_id,
        time_casa: jogo.time_casa,
        time_fora: jogo.time_fora,
        resultado_aposta: 'cancelado',
        anulado_manualmente: true,
        placar: null,
      }];
    }

    await dbSaveResultados(data, { ...(row.resultados || {}), apostas: novosResultados });
    console.log(`↩️ Jogo anulado: ${jogo.time_casa} x ${jogo.time_fora} (${data})`);
    res.json({ ok: true, mensagem: `Jogo anulado: ${jogo.time_casa} x ${jogo.time_fora}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cache de fixtures por data — evita chamar API-Football a cada keystroke do modal
const fixturesBuscaCache = {};

// Busca jogos disponíveis de um time em uma data — usado pelo modal de add manual
// sem filtro de sub-20 (adição manual é escolha deliberada do usuário)
// sem filtro de horário (qualquer horário da data é válido)
app.get('/buscar-jogos-time', async (req, res) => {
  // times_existentes: lista separada por | de times já na lista do dia (evita duplicatas)
  const { time, data, times_existentes } = req.query;
  if (!time || !data) return res.status(400).json({ error: 'time e data obrigatorios' });
  try {
    // Cache por 30 min para não consumir quota da API-Football a cada keystroke
    let fixtures = fixturesBuscaCache[data];
    if (!fixtures || (Date.now() - (fixtures._ts || 0)) > 30 * 60 * 1000) {
      const raw = await buscarFixturesPorData(data);
      if (!raw || raw.length === 0) {
        if (apiSuspensa) return res.status(503).json({ error: 'API indisponivel: ' + apiErrorMsg });
        return res.json({ jogos: [], aviso: 'Nenhum jogo encontrado na API para esta data' });
      }
      fixtures = raw;
      fixtures._ts = Date.now();
      fixturesBuscaCache[data] = fixtures;
    }

    const normS = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
    const nTime = normS(time);
    const termos = nTime.split(' ').filter(t => t.length >= 2);
    if (!termos.length) return res.json({ jogos: [] });

    // Times já presentes na lista do dia — excluir do resultado
    const timesJaNaLista = new Set(
      (times_existentes || '').split('|').map(t => normS(t)).filter(Boolean)
    );

    const matches = fixtures
      .filter(f => {
        // Filtrar pelo termo buscado
        const h = normS(f.teams?.home?.name), a = normS(f.teams?.away?.name);
        return termos.some(t => h.includes(t) || a.includes(t));
      })
      .filter(f => {
        // Excluir jogos cujos times já estão na lista do dia
        if (!timesJaNaLista.size) return true;
        const h = normS(f.teams?.home?.name), a = normS(f.teams?.away?.name);
        return !timesJaNaLista.has(h) && !timesJaNaLista.has(a);
      })
      // SEM filtro de sub-20: adição manual permite qualquer categoria (copinha, etc.)
      .map(f => ({
        fixture_id: f.fixture?.id,
        time_casa: f.teams?.home?.name,
        time_fora: f.teams?.away?.name,
        liga: f.league?.name,
        liga_id: f.league?.id,
        pais: f.league?.country,
        horario: new Date(f.fixture?.timestamp * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
        status: f.fixture?.status?.short,
      }))
      .slice(0, 15);

    res.json({ jogos: matches });
  } catch(errBusca) {
    console.error('Erro /buscar-jogos-time:', errBusca.message);
    res.status(500).json({ error: errBusca.message });
  }
});

// ─── Item 7: Adicionar / Confirmar jogo manual ───────────────
// Gera justificativa narrativa para uma aposta (para o usuário final)
app.post('/justificativa-aposta', async (req, res) => {
  const { time_casa, time_fora, liga, aposta, mercado, data } = req.body;
  if (!time_casa || !time_fora || !aposta) return res.status(400).json({ error: 'time_casa, time_fora e aposta obrigatórios' });
  try {
    const dataFmt = data ? (() => { const p = data.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; })() : 'hoje';
    const prompt = `Você é um analista esportivo que escreve textos para apostadores. Escreva uma justificativa NARRATIVA e PERSUASIVA para a aposta abaixo.

JOGO: ${time_casa} x ${time_fora}
LIGA: ${liga || 'desconhecida'}
DATA: ${dataFmt}
APOSTA: ${aposta}
MERCADO: ${mercado || 'gols'}

ESTILO OBRIGATÓRIO:
- Texto corrido em português, 4-6 parágrafos curtos (2-3 frases cada)
- Comece contextualizando o confronto e a aposta
- Cite forma recente, histórico H2H ou estatísticas relevantes
- Mencione fatores que FAVORECEM a aposta
- Termine com o principal RISCO e por que ainda assim a aposta faz sentido
- Linguagem natural, sem jargões técnicos internos como "odd", "mercado" ou "confiança"
- NÃO mencione casas de apostas, plataformas ou termos como "apostamos" — escreva como análise esportiva

USE web_search para buscar: forma atual dos times, escalações, suspensões, histórico recente de confrontos diretos.

Retorne APENAS o texto narrativo, sem títulos, sem JSON, sem marcadores.`;

    const txt = await chamarIAComBusca(prompt, 1500);
    if (!txt) return res.status(502).json({ error: 'IA não respondeu' });
    res.json({ ok: true, justificativa: txt.trim() });
  } catch(e) {
    console.error('Erro justificativa:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analisa um jogo avulso com IA e retorna o resultado SEM salvar
app.post('/adicionar-jogo-manual', async (req, res) => {
  const { time_casa, time_fora, data, liga_id } = req.body;
  if (!time_casa || !time_fora || !data) return res.status(400).json({ error: 'time_casa, time_fora e data obrigatorios' });
  try {
    console.log('\n🔧 Analise manual: ' + time_casa + ' x ' + time_fora + ' (' + data + ')');

    // 1. Buscar fixture na API
    const fixtures = await buscarFixturesPorData(data);
        const normM = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
    const nCasa = normM(time_casa), nFora = normM(time_fora);

    let fixture = fixtures.find(f => {
      const h = normM(f.teams?.home?.name || ''), a = normM(f.teams?.away?.name || '');
      const casaMatch = h.includes(nCasa.split(' ')[0]) || nCasa.includes(h.split(' ')[0] || '\x00');
      const foraMatch = a.includes(nFora.split(' ')[0]) || nFora.includes(a.split(' ')[0] || '\x00');
      return casaMatch && foraMatch;
    });
    // Preferir fixture com liga_id se fornecido
    if (liga_id) {
      const f2 = fixtures.find(f => String(f.league?.id) === String(liga_id) && normM(f.teams?.home?.name || '').includes(nCasa.split(' ')[0]));
      if (f2) fixture = f2;
    }

    const ligaNome = fixture?.league?.name || 'Internacional';
    const ligaIdResolvido = fixture?.league?.id || (liga_id ? Number(liga_id) : null);
    const tCasaId = fixture?.teams?.home?.id;
    const tForaId = fixture?.teams?.away?.id;
    const horario = fixture
      ? new Date(fixture.fixture?.timestamp * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
      : '00:00';

    // 2. Coletar estatísticas
    let statsCasa = null, statsFora = null;
    if (tCasaId && tForaId) {
      [statsCasa, statsFora] = await Promise.all([
        coletarEstatisticas(tCasaId, time_casa, ligaIdResolvido, tForaId),
        coletarEstatisticas(tForaId, time_fora, ligaIdResolvido, tCasaId)
      ]);
      console.log('  Stats coletadas');
    } else {
      console.log('  Fixture nao encontrado — analisando sem stats');
    }

    // 3. Buscar assertividade da liga no Supabase
    let ligaPerf = '';
    if (ligaIdResolvido) {
      try {
        const resL = await fetch(
          SUPABASE_URL + '/rest/v1/ligas_conhecidas?liga_id=eq.' + ligaIdResolvido + '&select=green,red,total,mercados,media_escanteios,media_cartoes,amostras_escanteios,amostras_cartoes',
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
        );
        const rowsL = await resL.json();
        const st = Array.isArray(rowsL) ? rowsL[0] : null;
        if (st && st.mercados) {
          const mercPerf = Object.entries(st.mercados)
            .filter(([, m]) => (m.green + m.red) >= 2)
            .map(([merc, m]) => merc + ':' + Math.round(m.green / (m.green + m.red) * 100) + '%')
            .join(' ');
          if (mercPerf) ligaPerf += '\n   LigaPerf: ' + mercPerf;
        }
        if (st && (st.media_escanteios || st.media_cartoes)) {
          const partes = [];
          if (st.media_escanteios) partes.push('escanteios media real ' + Number(st.media_escanteios).toFixed(1) + ' (' + (st.amostras_escanteios || 0) + ' jogos)');
          if (st.media_cartoes) partes.push('cartoes media real ' + Number(st.media_cartoes).toFixed(1) + ' (' + (st.amostras_cartoes || 0) + ' jogos)');
          ligaPerf += '\n   LigaMedia: ' + partes.join(' | ');
        }
      } catch(ligaErr) { /* continua sem stats de liga */ }
    }

    // 4. Montar contexto
    const sc = statsCasa, sf = statsFora;
    const listaJogo = '1. ' + ligaNome + ' | ' + time_casa + ' x ' + time_fora + ' | ' + horario + '\n' +
      '   Casa: forma=' + (sc?.forma || '?') + ' gols/jogo=' + (sc?.mediaGols || '?') + ' esc=' + (sc?.mediaEscanteios || '?') + ' cart=' + (sc?.mediaCartoes || '?') + '\n' +
      '   Fora: forma=' + (sf?.forma || '?') + ' gols/jogo=' + (sf?.mediaGols || '?') + ' esc=' + (sf?.mediaEscanteios || '?') + ' cart=' + (sf?.mediaCartoes || '?') + '\n' +
      '   H2H: ' + (sc?.h2hTexto || 'sem dados') + ligaPerf;

    // 5. Memória de calibração
    const memoria = await buscarMemoria();
    const parts = data.split('-');
    const df = parts[2] + '/' + parts[1] + '/' + parts[0];
    const blocoHistorico = memoria ? 'HISTORICO DE CALIBRACAO:\n' + memoria + '\n' : '';

    // 6. Prompt + IA (Sonnet + web_search)
    const promptIA = 'Voce e um analista de apostas esportivas experiente. Analise o jogo abaixo e escolha a melhor aposta.\n\n' +
      'DATA: ' + df + '\n' +
      blocoHistorico +
      'JOGO COM ESTATISTICAS REAIS:\n' + listaJogo + '\n\n' +
      'REGRA CRITICA DE ODD: so aceite apostas com odd real esperada >= 1.25. Prefira mercados entre 1.40-2.50. Sugira alternativas em mercados diferentes.\n\n' +
      'PROCESSO OBRIGATORIO:\n' +
      'PASSO 1 - Verifique o historico de calibracao para esse tipo de liga.\n' +
      'PASSO 2 - Avalie CADA mercado: gols, resultado, escanteios, cartoes.\n' +
      'PASSO 3 - Use web_search para lesoes, escalacoes e contexto atual do jogo.\n' +
      'PASSO 4 - Escolha o mercado com MAIOR confianca e odd esperada >= 1.25. Nunca retorne confianca baixa como principal.\n\n' +
      'CAMPO justificativa: texto para o PUBLICO. Sem termos internos. 2-3 frases em portugues natural sobre fatores esportivos.\n\n' +
      'Retorne SOMENTE JSON valido com exatamente 1 jogo:\n' +
      '{"jogos":[{"id":1,"liga":"' + ligaNome + '","tipo_liga":"eu","time_casa":"' + time_casa + '","time_fora":"' + time_fora + '","horario":"' + horario + '","aposta":"Over 2.5 gols","mercado":"gols","aposta_backup":"Over 1.5 gols","mercado_backup":"gols","razao_escolha":"media combinada alta","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"VVEDV","forma_fora":"DEVVD","justificativa":"Analise do jogo.","alternativas":[{"mercado":"gols","aposta":"Over 2.5","confianca":"alta","razao":"media alta"},{"mercado":"resultado","aposta":"Casa vence","confianca":"media","razao":"forma recente"},{"mercado":"escanteios","aposta":"Over 8.5","confianca":"media","razao":"media 9.2"},{"mercado":"cartoes","aposta":"Over 3.5","confianca":"baixa","razao":"media baixa"}]}]}';

    const txt = await chamarIAComBusca(promptIA, 4000);
    if (!txt) return res.status(502).json({ error: 'IA nao respondeu' });

    // 7. Parsear
    const idxS = txt.indexOf('{'), idxE = txt.lastIndexOf('}');
    if (idxS === -1) return res.status(502).json({ error: 'IA retornou formato invalido', raw: txt.substring(0, 200) });
    const parsed = JSON.parse(txt.slice(idxS, idxE + 1));
    const jogosIA = (parsed.jogos || []).filter(j => j && j.aposta && j.mercado);
    if (!jogosIA.length) return res.status(502).json({ error: 'IA nao retornou apostas validas', raw: txt.substring(0, 300) });

    const jogoFinal = Object.assign({}, jogosIA[0], {
      liga: ligaNome,
      time_casa: time_casa,
      time_fora: time_fora,
      horario: horario,
      fixtureId: fixture?.fixture?.id || null,
      ligaId: ligaIdResolvido,
      teamCasaId: tCasaId || null,
      teamForaId: tForaId || null,
      tipo_liga: jogosIA[0].tipo_liga || 'eu',
      pri: 1, // manual sempre tratado como prioritário para não ser descartado
      adicionado_manualmente: true,
    });

    // 8. Validar odd real contra API-Football (mesmo fluxo da geração automática)
    if (jogoFinal.fixtureId) {
      try {
        const oddsFixture = await buscarOddsFixture(jogoFinal.fixtureId, data, true); // forçar fresh
        if (oddsFixture) {
          const motivo = aplicarOddsEPivotar(jogoFinal, oddsFixture);
          if (motivo) {
            // IA escolheu mercado indisponível — tenta fallback de mercados disponíveis
            const mercadosDisp = formatarMercadosDisponiveisParaIA(oddsFixture);
            if (mercadosDisp !== 'Nenhum mercado com odd ≥ 1.25.') {
              console.log('  ⚠️ Mercado original indisponível, re-analisando com mercados reais...');
              const promptFallback = `Jogo: ${time_casa} x ${time_fora} (${ligaNome}, ${horario})
Mercados DISPONÍVEIS na API (únicos apostáveis):
${mercadosDisp}
Forma casa: ${statsCasa?.forma||'?'} | Fora: ${statsFora?.forma||'?'} | Gols: ${statsCasa?.mediaGols||'?'}+${statsFora?.mediaGols||'?'}
Escolha a MELHOR aposta. Confiança alta, odd ≥ 1.25.
Retorne JSON: {"aposta":"...","mercado":"gols|resultado|escanteios|cartoes","confianca":"alta","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
              const respFallback = await chamarIA(promptFallback, 800);
              let oddConfirmada = false;
              if (respFallback) {
                const mFb = respFallback.match(/\{[\s\S]*\}/);
                if (mFb) {
                  const novaFb = JSON.parse(mFb[0]);
                  if (novaFb.aposta && novaFb.mercado && novaFb.confianca === 'alta') {
                    const oddReal = selecionarOddFixture(oddsFixture, novaFb.aposta, novaFb.mercado, time_casa, time_fora);
                    const oddNum = oddReal ? parseFloat(oddReal) : null;
                    if (oddNum && oddNum >= ODD_MINIMA) {
                      jogoFinal.aposta = novaFb.aposta;
                      jogoFinal.mercado = novaFb.mercado;
                      jogoFinal.odd_mercado = oddNum;
                      jogoFinal.confianca = 'alta';
                      jogoFinal.descartado = false;
                      jogoFinal.justificativa = novaFb.justificativa || novaFb.razao;
                      oddConfirmada = true;
                      console.log(`  ✅ Re-análise manual: ${novaFb.aposta} @ ${oddNum}`);
                    }
                  }
                }
              }
              if (!oddConfirmada) {
                console.log(`  ❌ Manual: nenhum mercado com odd validada encontrado para ${time_casa} x ${time_fora}`);
                return res.json({ ok: false, sem_odd: true, error: `Nenhum mercado com odd validada disponível para ${time_casa} x ${time_fora}. O jogo existe mas não há odds apostáveis na API no momento.` });
              }
            } else {
              console.log(`  ❌ Manual: sem mercados disponíveis na API para ${time_casa} x ${time_fora}`);
              return res.json({ ok: false, sem_odd: true, error: `Sem mercados apostáveis na API para ${time_casa} x ${time_fora}. Tente novamente mais perto do horário do jogo.` });
            }
          } else {
            console.log(`  ✅ Odd validada: ${jogoFinal.aposta} @ ${jogoFinal.odd_mercado}`);
          }
        } else {
          console.log(`  ❌ Manual: sem odds na API para fixture ${jogoFinal.fixtureId}`);
          return res.json({ ok: false, sem_odd: true, error: `Sem odds disponíveis na API para ${time_casa} x ${time_fora}. Tente novamente mais perto do horário do jogo.` });
        }
      } catch(oddsErr) {
        console.error('  Erro validando odds manual:', oddsErr.message);
      }
    }

    console.log('  Analise manual OK: ' + jogoFinal.aposta + ' @ ' + jogoFinal.odd_mercado + ' [' + jogoFinal.confianca + ']');
    res.json({ ok: true, jogo: jogoFinal });
  } catch(errManual) {
    console.error('Erro /adicionar-jogo-manual:', errManual.message);
    res.status(500).json({ error: errManual.message });
  }
});

// Confirmar jogo manual — adiciona ao apostas_dia e reordena IDs
app.post('/confirmar-jogo-manual', async (req, res) => {
  const { data, jogo } = req.body;
  if (!data || !jogo) return res.status(400).json({ error: 'data e jogo obrigatórios' });
  try {
    const row = await dbGet(data);
    const jogosExistentes = row?.apostas?.jogos || [];

    // Reatribuir IDs sequencialmente
    const novosJogos = [...jogosExistentes, { ...jogo, id: jogosExistentes.length + 1, adicionado_manualmente: true }];
    novosJogos.forEach((j, idx) => { j.id = idx + 1; });

    await dbSave(data, { ...(row?.apostas || {}), jogos: novosJogos });

    // Regenerar múltiplas em background
    setTimeout(async () => {
      try {
        const rowAtual = await dbGet(data);
        const multiplas = await gerarMultiplasComAgentes(data, rowAtual?.apostas?.jogos || []);
        if (multiplas) await dbSaveMultiplas(data, multiplas);
      } catch(e) { console.error('❌ Múltiplas após add manual:', e.message); }
    }, 5000);

    console.log(`✅ Jogo manual confirmado: ${jogo.time_casa} x ${jogo.time_fora} — total agora: ${novosJogos.length}`);
    res.json({ ok: true, total: novosJogos.length, jogos: novosJogos });
  } catch(e) {
    console.error('❌ /confirmar-jogo-manual:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Excluir jogo do dia por ID
app.delete('/excluir-jogo', async (req, res) => {
  const { data, jogo_id } = req.body;
  if (!data || jogo_id == null) return res.status(400).json({ error: 'data e jogo_id obrigatórios' });
  try {
    const row = await dbGet(data);
    const jogosExistentes = row?.apostas?.jogos || [];
    const novosJogos = jogosExistentes.filter(j => j.id !== Number(jogo_id));
    if (novosJogos.length === jogosExistentes.length) return res.status(404).json({ error: `Jogo ${jogo_id} não encontrado` });
    // Renumerar IDs
    novosJogos.forEach((j, idx) => { j.id = idx + 1; });
    await dbSave(data, { ...(row?.apostas || {}), jogos: novosJogos });
    console.log(`🗑️ Jogo ${jogo_id} excluído de ${data} — restam ${novosJogos.length}`);
    res.json({ ok: true, total: novosJogos.length, jogos: novosJogos });
  } catch(e) {
    console.error('❌ /excluir-jogo:', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const { data, jogo_id, escanteios, cartoes, cartoes_amarelos, cartoes_vermelhos } = req.body;
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
      confirmado: true, // dado informado manualmente — nunca tratar 0 como "sem cobertura"
    };

    const mainMercado = (jogo.mercado || '').toLowerCase();
    const apostaPrincipalStats = mainMercado === 'escanteios' || mainMercado === 'cartoes' ||
      (jogo.aposta||'').toLowerCase().includes('escanteio') ||
      (jogo.aposta||'').toLowerCase().includes('corner') ||
      (jogo.aposta||'').toLowerCase().includes('cartao') ||
      (jogo.aposta||'').toLowerCase().includes('cartão');
    const resultado = apostaPrincipalStats
      ? verificarAposta(jogo, gC, gF, statsInformadas)
      : (resExistente.resultado_aposta || 'pendente');

    // Montar mercados_resultado para escanteios/cartões com os dados informados
    const mercadosResultExtra = { ...(resExistente.mercados_resultado || {}) };
    if (escanteios != null) {
      mercadosResultExtra.escanteios = {};
      for (const linha of ['4.5','5.5','6.5','7.5','8.5','9.5','10.5','11.5','12.5','13.5','14.5']) {
        const l = parseFloat(linha);
        mercadosResultExtra.escanteios[`Over ${linha}`] = escanteios > l ? 'green' : 'red';
        mercadosResultExtra.escanteios[`Under ${linha}`] = escanteios < l ? 'green' : 'red';
      }
    }
    if (cartoes != null) {
      mercadosResultExtra.cartoes = {};
      for (const linha of ['1.5','2.5','3.5','4.5','5.5','6.5']) {
        const l = parseFloat(linha);
        mercadosResultExtra.cartoes[`Over ${linha}`] = cartoes > l ? 'green' : 'red';
        mercadosResultExtra.cartoes[`Under ${linha}`] = cartoes < l ? 'green' : 'red';
      }
    }

    // Verificar se já tinha mercados_resultado.escanteios/cartoes ANTES (evitar contar 2x na liga)
    const jaTinhaEsc = !!resExistente.mercados_resultado?.escanteios;
    const jaTinhaCart = !!resExistente.mercados_resultado?.cartoes;

    const novosResultados = resultadosExistentes.map(r =>
      r.jogo_id === jogo_id
        ? { ...r, resultado_aposta: resultado, motivo: `Stats informadas manualmente: esc=${escanteios||0} cart=${cartoes||0}`, corrigido_manualmente: true, mercados_resultado: mercadosResultExtra, escanteios_total: escanteios || r.escanteios_total || null, cartoes_total: cartoes || r.cartoes_total || null, cartoes_amarelos: cartoes_amarelos ?? r.cartoes_amarelos ?? null, cartoes_vermelhos: cartoes_vermelhos ?? r.cartoes_vermelhos ?? null }
        : r
    );

    await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: novosResultados });
    console.log(`📊 Stats informadas: ${jogo.time_casa} x ${jogo.time_fora} | esc=${escanteios} cart=${cartoes} → ${resultado}`);

    // Propagar para ligas_conhecidas — alimentar o histórico de assertividade por mercado
    // Usa as alternativas do jogo (geradas pela IA) para saber qual aposta específica considerar
    if (jogo.ligaId) {
      // Sempre atualizar médias se valor informado (mesmo sem alternativas no mercado)
      let mediaEscParaSalvar = null, mediaCartParaSalvar = null;
      if (escanteios !== null && !jaTinhaEsc) mediaEscParaSalvar = escanteios;
      if (cartoes !== null && !jaTinhaCart) mediaCartParaSalvar = cartoes;

      if (jogo.alternativas?.length) {
        for (const alt of jogo.alternativas) {
          if (alt.mercado === 'escanteios' && escanteios !== null && !jaTinhaEsc) {
            const r = calcularResultadoAlternativaTexto(alt.aposta, mercadosResultExtra.escanteios);
            if (r) await dbUpdateLigaStats(jogo.ligaId, r === 'green' ? 1 : 0, r === 'red' ? 1 : 0, 'escanteios', mediaEscParaSalvar, null);
            mediaEscParaSalvar = null; // já salvou a média junto com o green/red
          }
          if (alt.mercado === 'cartoes' && cartoes !== null && !jaTinhaCart) {
            const r = calcularResultadoAlternativaTexto(alt.aposta, mercadosResultExtra.cartoes);
            if (r) await dbUpdateLigaStats(jogo.ligaId, r === 'green' ? 1 : 0, r === 'red' ? 1 : 0, 'cartoes', null, mediaCartParaSalvar);
            mediaCartParaSalvar = null;
          }
        }
      }
      // Se não entrou em nenhum mercado de alternativas, salvar só a média (sem green/red)
      if (mediaEscParaSalvar !== null || mediaCartParaSalvar !== null) {
        await dbUpdateLigaStats(jogo.ligaId, 0, 0, null, mediaEscParaSalvar, mediaCartParaSalvar);
      }
      console.log(`  📊 ligas_conhecidas atualizado para liga ${jogo.ligaId}`);
    }

    res.json({ ok: true, resultado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Correlação odd / aposta / mercado ────────────────────────────────────────
// Analisa todos os resultados validados e cruza: odd_mercado × mercado × linha × resultado
// Agrega correlação odd × mercado × resultado dos últimos 60 dias e salva em calibracao
async function atualizarCorrelacaoOdds() {
  const rowsResp = await fetch(
    `${SUPABASE_URL}/rest/v1/apostas_dia?select=data,apostas,resultados&order=data.desc&limit=60`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await rowsResp.json();

  const pontos = [];
  const agr = {};
  for (const row of rows || []) {
    const jogos  = row.apostas?.jogos || [];
    const resArr = row.resultados?.apostas || [];
    for (const j of jogos) {
      const res = resArr.find(r => r.jogo_id === j.id);
      if (!res || !['green','red'].includes(res.resultado_aposta)) continue;
      const oddM = j.odd_mercado ? parseFloat(j.odd_mercado) : null;
      const oddS = j.odd_sugerida ? parseFloat(j.odd_sugerida) : null;
      const linha = (j.aposta || '').match(/(\d+\.?\d*)/)?.[1] || null;
      const faixaOdd = oddM ? (oddM < 1.40 ? '1.25-1.39' : oddM < 1.60 ? '1.40-1.59' : oddM < 1.80 ? '1.60-1.79' : oddM < 2.00 ? '1.80-1.99' : '2.00+') : 'sem_odd';
      pontos.push({ data: row.data, liga: j.liga, tipo_liga: j.tipo_liga, mercado: j.mercado, aposta: j.aposta, linha, odd_mercado: oddM, odd_sugerida: oddS, confianca: j.confianca, resultado: res.resultado_aposta, faixa_odd: faixaOdd });
      const chave = `${j.mercado}|${linha||'?'}|${faixaOdd}`;
      if (!agr[chave]) agr[chave] = { mercado: j.mercado, linha, faixa_odd: faixaOdd, green: 0, red: 0, total: 0, odds: [] };
      agr[chave].total++;
      agr[chave][res.resultado_aposta]++;
      if (oddM) agr[chave].odds.push(oddM);
    }
  }

  const tabela = Object.values(agr)
    .filter(b => b.total >= 3)
    .map(b => ({ mercado: b.mercado, linha: b.linha, faixa_odd: b.faixa_odd, total: b.total, green: b.green, red: b.red, assertividade: parseFloat((b.green / b.total * 100).toFixed(1)), odd_media: b.odds.length ? parseFloat((b.odds.reduce((a,x)=>a+x,0)/b.odds.length).toFixed(2)) : null }))
    .sort((a,b) => b.total - a.total);

  const alertas = tabela.filter(b => b.assertividade < 60 && b.total >= 5)
    .map(b => `${b.mercado} linha ${b.linha} odd ${b.faixa_odd}: ${b.assertividade}% (${b.green}G/${b.red}R)`);

  const hoje = hojeStr();
  await fetch(`${SUPABASE_URL}/rest/v1/calibracao`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ tipo: 'correlacao_odds', periodo_inicio: hoje, periodo_fim: hoje, relatorio: JSON.stringify({ gerado_em: hoje, total_apostas_analisadas: pontos.length, tabela_correlacao: tabela, alertas, pontos_raw: pontos }), assertividade: tabela.length > 0 ? parseFloat((tabela.reduce((s,b)=>s+b.green,0) / tabela.reduce((s,b)=>s+b.total,0) * 100).toFixed(1)) : null }),
  });

  return { total_apostas: pontos.length, tabela_correlacao: tabela, alertas };
}

app.get('/calibracao/correlacao-odds', async (req, res) => {
  try {
    const resultado = await atualizarCorrelacaoOdds();
    res.json({ gerado_em: hojeStr(), ...resultado });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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

// Retorna todas as ligas conhecidas para a aba Mercados/Ligas
app.get('/ligas-conhecidas', async (req, res) => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ligas_conhecidas?select=liga_id,nome,pais,green,red,total,mercados,media_escanteios,media_cartoes,amostras_escanteios,amostras_cartoes&order=total.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    res.json(rows || []);
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

    const multiplas = await gerarMultiplasComAgentes(data, jogosComPri);
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

function msAteHoraUTC(horaUTC, minUTC = 0) {
  const agora = new Date();
  const prox = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), horaUTC, minUTC, 0));
  if (prox <= agora) prox.setUTCDate(prox.getUTCDate() + 1);
  return prox.getTime() - agora.getTime();
}

function jaPassouHojeUTC(horaUTC, minUTC = 0) {
  const agora = new Date();
  const ref = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), horaUTC, minUTC, 0));
  return agora > ref;
}

// Janela de catch-up: só executa se passou há menos de N minutos (evita re-execução tardia)
const CATCHUP_MAX_MIN = 90; // se passou > 90 min do horário, não faz catch-up
function deveExecutarCatchup(horaUTC, minUTC = 0) {
  const agora = new Date();
  const ref = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), horaUTC, minUTC, 0));
  if (agora <= ref) return false; // ainda não passou
  const minPassados = (agora - ref) / 60000;
  return minPassados <= CATCHUP_MAX_MIN; // só faz catch-up se passou < 90 min
}

async function rotinaDas03h() {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);
  console.log(`\n🌙 [03h] Validação final + relatório diário — ${ontem}`);
  const rowOntem = await dbGet(ontem);
  if (rowOntem?.apostas?.jogos) {
    const pendentes = rowOntem.resultados?.apostas?.filter(r => r.resultado_aposta === 'pendente') || [];
    const semResultado = !rowOntem.resultados;
    if (semResultado || pendentes.length > 0) {
      await agentValidar(ontem, { forcarWebSearch: true });
    }
    const calExistente = await dbGetCalibracaoPorPeriodo('diario', ontem).catch(()=>null);
    if (!calExistente) {
      await agentDiario(ontem);
      console.log(`✅ Relatório diário de ${ontem} gerado`);
    } else {
      console.log(`✅ Relatório de ${ontem} já existe`);
    }
  }
  // Atualizar correlação odd × mercado × resultado com todos os dados históricos
  try {
    const cor = await atualizarCorrelacaoOdds();
    console.log(`✅ Correlação odds atualizada — ${cor.total_apostas} apostas, ${cor.tabela_correlacao.length} buckets`);
  } catch(e) { console.error(`⚠️ Correlação odds falhou: ${e.message}`); }
}

// Reprocessa jogos marcados como "analisando=true" com nova chamada à API de odds
async function reprocessarAnalisando(data) {
  try {
    const row = await dbGet(data);
    const jogos = row?.apostas?.jogos;
    if (!jogos?.length) return;

    const analisando = jogos.filter(j => j.analisando && !j.descartado);
    if (!analisando.length) { console.log(`✅ [analisando] Nenhum jogo pendente para ${data}`); return; }

    console.log(`\n🔄 [analisando] ${analisando.length} jogo(s) prioritário(s) para reanalisar em ${data}...`);
    let alterou = false;

    for (const jogo of analisando) {
      if (!jogo.fixtureId) continue;
      console.log(`  🔍 ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga}) — buscando odds atualizadas...`);

      // Busca NOVA — ignora cache
      const oddsFixture = await buscarOddsFixture(jogo.fixtureId, data, true);
      if (!oddsFixture) {
        console.log(`  ⏭️ Sem odds na API ainda para ${jogo.time_casa} x ${jogo.time_fora}`);
        continue;
      }

      // Tenta aplicar odds e pivotar (agora com dados frescos)
      const motivo = aplicarOddsEPivotar(jogo, oddsFixture);

      // Se ainda marcado como analisando, tenta os agentes de 1º/2º tempo e combo
      if (jogo.analisando) {
        const mercadosDisp = formatarMercadosDisponiveisParaIA(oddsFixture);
        if (mercadosDisp !== 'Nenhum mercado com odd ≥ 1.25.') {
          const promptRetry = `Jogo: ${jogo.time_casa} x ${jogo.time_fora} (${jogo.liga}, ${jogo.horario})
Liga PRIORITÁRIA — encontre a melhor aposta disponível. Aceite confiança "media" se necessário.

Mercados disponíveis na API com odd ≥ 1.25:
${mercadosDisp}

Forma casa: ${jogo.forma_casa||'?'} | Fora: ${jogo.forma_fora||'?'} | Gols: ${jogo.media_gols_casa||'?'}+${jogo.media_gols_fora||'?'}

Retorne JSON: {"aposta":"...","mercado":"gols|resultado|escanteios|cartoes|combo|resultado_1t|resultado_2t","confianca":"alta|media","odd_sugerida":"X.XX","razao":"...","justificativa":"..."}`;
          try {
            const resp = await chamarIA(promptRetry, 600);
            if (resp) {
              const m = resp.match(/\{[\s\S]*\}/);
              if (m) {
                const nova = JSON.parse(m[0]);
                const confOk = nova.confianca === 'alta' || nova.confianca === 'media';
                if (nova.aposta && nova.mercado && confOk) {
                  const oddReal = selecionarOddFixture(oddsFixture, nova.aposta, nova.mercado, jogo.time_casa, jogo.time_fora);
                  const oddNum = oddReal ? parseFloat(oddReal) : null;
                  if (oddNum && oddNum >= ODD_MINIMA) {
                    jogo.aposta = nova.aposta; jogo.mercado = nova.mercado;
                    jogo.odd_mercado = oddNum; jogo.confianca = nova.confianca;
                    jogo.analisando = false; jogo.descartado_motivo = null;
                    jogo.justificativa = nova.justificativa || nova.razao || jogo.justificativa;
                    console.log(`  ✅ Resolvido: ${nova.aposta} (${nova.mercado}) @ ${oddNum} [${nova.confianca}]`);
                    alterou = true;
                  }
                }
              }
            }
          } catch(e) { console.error(`  Erro retry IA ${jogo.time_casa}: ${e.message}`); }
        }
      } else if (!motivo) {
        // aplicarOddsEPivotar resolveu
        jogo.analisando = false;
        console.log(`  ✅ ${jogo.time_casa} x ${jogo.time_fora} resolvido por odds frescas @ ${jogo.odd_mercado}`);
        alterou = true;
      }
    }

    if (alterou) {
      await dbSave(data, { jogos });
      console.log(`✅ [analisando] Banco atualizado para ${data}`);
    } else {
      console.log(`⚠️ [analisando] Nenhum jogo resolvido para ${data} — tentará novamente na próxima rotina`);
    }
  } catch(e) { console.error('[analisando] Erro:', e.message); }
}

// ── Rotina de complemento diurno (07h e 12h BRT) ──────────────────────────
// Apenas preenche slots vazios — não toca em jogos já analisados nem em múltiplas OK
async function rotinaComplementoDiurno() {
  const hoje = hojeStr();
  const amanha = diaOffset(hoje, 1);
  console.log(`\n⏰ [Complemento diurno] Verificando ${hoje} e ${amanha}`);

  for (const diaAlvo of [hoje, amanha]) {
    try {
      const row = await dbGet(diaAlvo);
      const jogos = row?.apostas?.jogos || [];
      const ativos = jogos.filter(j => !j.descartado && !j.analisando);
      const ocupados = jogos.filter(j => !j.descartado).length; // ativos + analisando = slots tomados

      if (ocupados >= 15) {
        console.log(`✅ [${diaAlvo}] ${ocupados} slots ocupados (${ativos.length} ativos + ${ocupados - ativos.length} analisando) — sem complemento`);
        continue;
      }

      const faltam = 15 - ocupados;
      console.log(`⚠️ [${diaAlvo}] Apenas ${ativos.length}/15 ativos — complementando ${faltam} jogo(s)`);

      // Times já selecionados (ativos + descartados) para evitar duplicatas
      const timesJaSelecionados = new Set(
        jogos.flatMap(j => [j.time_casa?.toLowerCase(), j.time_fora?.toLowerCase()]).filter(Boolean)
      );

      // Tenta multi-agente; fallback para gerarApostas
      let resultado = null;
      try {
        resultado = await gerarApostasMultiAgente(diaAlvo, '13:00', faltam, timesJaSelecionados);
        if (!resultado?.jogos?.length) resultado = null;
      } catch(e) { console.error('❌ [Complemento] Multi-agente falhou:', e.message); }

      if (!resultado) {
        resultado = await gerarApostas(diaAlvo, '13:00', faltam, timesJaSelecionados);
      }

      if (resultado?.jogos?.length) {
        // Filtro final: garantir horário mínimo 13:00
        resultado.jogos = resultado.jogos.filter(j => {
          const [hh, mm] = (j.horario || '00:00').split(':').map(Number);
          const ok = hh * 60 + mm >= 13 * 60;
          if (!ok) console.log(`  ⏰ [Complemento] Rejeitando jogo antes das 13h: ${j.time_casa} x ${j.time_fora} (${j.horario})`);
          return ok;
        });
        if (!resultado.jogos.length) { console.log(`⚠️ [${diaAlvo}] Todos os novos jogos rejeitados por horário`); continue; }
        const maxId = Math.max(...jogos.map(x => x.id || 0), 0);
        const novosJogos = resultado.jogos.map((j, i) => ({ ...j, id: maxId + i + 1 }));
        await dbSave(diaAlvo, { jogos: aplicarTetoAtivos([...jogos, ...novosJogos]) });
        const totalAtivos = ativos.length + novosJogos.filter(j => !j.descartado).length;
        console.log(`✅ [${diaAlvo}] Complemento: +${novosJogos.length} jogos → ${totalAtivos} ativos`);

        // Regenerar múltiplas se ainda não existem ou faltavam jogos antes
        const rowMult = await dbGetComMultiplas(diaAlvo);
        if (!rowMult?.multiplas?.multipla_a || !rowMult?.multiplas?.multipla_b) {
          const rowAtual = await dbGet(diaAlvo);
          const novasMultiplas = await gerarMultiplasComAgentes(diaAlvo, rowAtual?.apostas?.jogos || []);
          if (novasMultiplas) {
            await dbSaveMultiplas(diaAlvo, novasMultiplas);
            console.log(`✅ [${diaAlvo}] Múltiplas geradas após complemento`);
          }
        }
      } else {
        console.log(`⚠️ [${diaAlvo}] Complemento sem resultado — sem jogos com odds disponíveis`);
      }
    } catch(e) { console.error(`❌ [Complemento diurno] Erro em ${diaAlvo}:`, e.message); }
  }
}

function agendarRotina() {
  // ── 00:00 BRT (03:00 UTC) — validação noturna inicial + calibrações ─────
  // SEM catch-up: não deve rodar fora da madrugada
  const ms00h = msAteHoraUTC(3, 0);
  console.log(`⏰ Próxima rotinaNoturna (00h) em ${Math.round(ms00h/60000)} min`);
  setTimeout(function tick00h() {
    rotinaNoturna().catch(console.error);
    setTimeout(tick00h, 24 * 60 * 60 * 1000);
  }, ms00h);

  // ── 03:00 BRT (06:00 UTC) — validação final + relatório diário ───────────
  // SEM catch-up: não deve rodar fora da madrugada
  const ms03h = msAteHoraUTC(6, 0);
  console.log(`⏰ Próxima rotinaDas03h (03h) em ${Math.round(ms03h/60000)} min`);
  setTimeout(function tick03h() {
    rotinaDas03h().catch(console.error);
    setTimeout(tick03h, 24 * 60 * 60 * 1000);
  }, ms03h);

  // ── 03:30 BRT (06:30 UTC) — gerar apostas de hoje e amanhã ──────────────
  // Catch-up: se servidor reiniciou em até 90 min depois, gera apostas do dia
  if (deveExecutarCatchup(6, 30)) {
    console.log(`⚡ Catch-up 03h30: gerando apostas (passou < ${CATCHUP_MAX_MIN} min)`);
    setTimeout(() => rotina04h().catch(console.error), 15000);
  }
  const ms0330 = msAteHoraUTC(6, 30);
  console.log(`⏰ Próxima rotina04h (03h30) em ${Math.round(ms0330/60000)} min`);
  setTimeout(function tick0330() {
    rotina04h().catch(console.error);
    setTimeout(tick0330, 24 * 60 * 60 * 1000);
  }, ms0330);

  // ── 04:15 BRT (07:15 UTC) — verificar integridade e corrigir ────────────
  if (deveExecutarCatchup(7, 15)) {
    console.log(`⚡ Catch-up 04h15: verificando integridade`);
    setTimeout(() => rotina05h().catch(console.error), 30000);
  }
  const ms0415 = msAteHoraUTC(7, 15);
  console.log(`⏰ Próxima rotina05h (04h15) em ${Math.round(ms0415/60000)} min`);
  setTimeout(function tick0415() {
    rotina05h().catch(console.error);
    setTimeout(tick0415, 24 * 60 * 60 * 1000);
  }, ms0415);

  // ── 07:00 BRT (10:00 UTC) — complemento diurno 1 ────────────────────────
  if (deveExecutarCatchup(10, 0)) {
    console.log(`⚡ Catch-up 07h: complemento diurno`);
    setTimeout(() => rotinaComplementoDiurno().catch(console.error), 5000);
  }
  const ms07h = msAteHoraUTC(10, 0);
  console.log(`⏰ Próximo complemento diurno (07h) em ${Math.round(ms07h/60000)} min`);
  setTimeout(function tick07h() {
    console.log(`⏰ [07h] Complemento diurno`);
    rotinaComplementoDiurno().catch(console.error);
    setTimeout(tick07h, 24 * 60 * 60 * 1000);
  }, ms07h);

  // ── 12:00 BRT (15:00 UTC) — complemento diurno 2 ────────────────────────
  if (deveExecutarCatchup(15, 0)) {
    console.log(`⚡ Catch-up 12h: complemento diurno`);
    setTimeout(() => rotinaComplementoDiurno().catch(console.error), 5000);
  }
  const ms12h = msAteHoraUTC(15, 0);
  console.log(`⏰ Próximo complemento diurno (12h) em ${Math.round(ms12h/60000)} min`);
  setTimeout(function tick12h() {
    console.log(`⏰ [12h] Complemento diurno`);
    rotinaComplementoDiurno().catch(console.error);
    setTimeout(tick12h, 24 * 60 * 60 * 1000);
  }, ms12h);

  // ── 15:00 BRT (18:00 UTC) — primeira validação parcial dos jogos do dia ─
  const ms15h = msAteHoraUTC(18, 0);
  console.log(`⏰ Próxima validação parcial (15h) em ${Math.round(ms15h/60000)} min`);
  setTimeout(function tick15h() {
    const hoje = hojeStr();
    console.log(`⏰ [15h] Validação parcial — ${hoje}`);
    agentValidar(hoje, { forcarWebSearch: false }).catch(console.error);
    setTimeout(tick15h, 24 * 60 * 60 * 1000);
  }, ms15h);

  // ── 18:00 BRT (21:00 UTC) — segunda validação parcial ───────────────────
  const ms18h = msAteHoraUTC(21, 0);
  console.log(`⏰ Próxima validação parcial (18h) em ${Math.round(ms18h/60000)} min`);
  setTimeout(function tick18h() {
    const hoje = hojeStr();
    console.log(`⏰ [18h] Validação parcial — ${hoje}`);
    agentValidar(hoje, { forcarWebSearch: true }).catch(console.error);
    setTimeout(tick18h, 24 * 60 * 60 * 1000);
  }, ms18h);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarRotina();
  agendarCronTelegram();
});
