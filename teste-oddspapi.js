/**
 * teste-oddspapi.js — Diagnóstico OddsPapi x Estrela Bet
 * Rodar: node teste-oddspapi.js
 * Variáveis: ODDSPAPI_KEY e API_FOOTBALL_KEY
 *
 * NÃO modifica nenhum arquivo do projeto.
 */

const https = require('https');
const fs = require('fs');

const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ─── Helpers ─────────────────────────────────────────────────

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error: ${e.message}\nBody: ${data.substring(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function hoje() {
  return new Date().toISOString().substring(0, 10);
}
function amanha() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().substring(0, 10);
}
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const relatorio = {
    gerado_em: new Date().toISOString(),
    passo1: {},
    passo2: {},
    passo3: [],
    resumo: {}
  };

  console.log('\n========================================');
  console.log('TESTE DE DIAGNÓSTICO — OddsPapi x Estrela Bet');
  console.log('========================================\n');

  // ─── PASSO 1 — Fixtures hoje e amanhã ───────────────────────
  console.log('📡 PASSO 1 — Buscando fixtures hoje e amanhã...');

  let fixturesOddsPapi = [];

  if (!ODDSPAPI_KEY) {
    console.log('  ⚠️  ODDSPAPI_KEY não definida — pulando passo 1 e 3');
  } else {
    try {
      const url = `https://api.oddspapi.io/v4/fixtures?sportId=10&from=${hoje()}&to=${amanha()}&apiKey=${ODDSPAPI_KEY}`;
      const data = await get(url);
      const fixtures = data.fixtures || data.data || data || [];
      fixturesOddsPapi = Array.isArray(fixtures) ? fixtures : [];

      const comOdds = fixturesOddsPapi.filter(f => f.hasOdds === true || f.has_odds === true);

      console.log(`  Total fixtures encontrados: ${fixturesOddsPapi.length}`);
      console.log(`  Fixtures com hasOdds=true: ${comOdds.length}`);

      relatorio.passo1 = {
        total: fixturesOddsPapi.length,
        com_odds: comOdds.length,
        sample: fixturesOddsPapi.slice(0, 3).map(f => ({
          id: f.id || f.fixtureId,
          home: f.homeTeam?.name || f.home,
          away: f.awayTeam?.name || f.away,
          date: f.date || f.startDate,
          hasOdds: f.hasOdds || f.has_odds
        }))
      };

      // Mostrar amostra
      console.log('\n  Amostra dos primeiros fixtures:');
      fixturesOddsPapi.slice(0, 5).forEach(f => {
        const home = f.homeTeam?.name || f.home || '?';
        const away = f.awayTeam?.name || f.away || '?';
        const date = f.date || f.startDate || '?';
        const odds = f.hasOdds || f.has_odds;
        console.log(`    ${home} x ${away} | ${date} | hasOdds: ${odds}`);
      });

      // Filtrar apenas com odds para próximos passos
      fixturesOddsPapi = comOdds;

    } catch(e) {
      console.log(`  ❌ Erro passo 1: ${e.message}`);
      relatorio.passo1.erro = e.message;
    }
  }

  // ─── PASSO 2 — Cruzar com API-Football (Brasileirão) ────────
  console.log('\n📡 PASSO 2 — Cruzando com API-Football (Brasileirão Série A)...');

  let jogosBrasileiraoApiFootball = [];
  const cruzamentos = [];

  if (!API_FOOTBALL_KEY) {
    console.log('  ⚠️  API_FOOTBALL_KEY não definida — pulando passo 2');
  } else {
    try {
      const url = `https://v3.football.api-sports.io/fixtures?league=71&season=2026&next=5`;
      const data = await get(url, { 'x-apisports-key': API_FOOTBALL_KEY });
      jogosBrasileiraoApiFootball = data.response || [];

      console.log(`  Próximos jogos Série A encontrados: ${jogosBrasileiraoApiFootball.length}`);

      for (const fixture of jogosBrasileiraoApiFootball) {
        const home = fixture.teams?.home?.name || '';
        const away = fixture.teams?.away?.name || '';
        const date = fixture.fixture?.date?.substring(0, 10) || '';
        console.log(`  → ${home} x ${away} (${date})`);

        // Tentar encontrar na OddsPapi por nome + data
        const match = fixturesOddsPapi.find(f => {
          const fHome = norm(f.homeTeam?.name || f.home || '');
          const fAway = norm(f.awayTeam?.name || f.away || '');
          const fDate = (f.date || f.startDate || '').substring(0, 10);
          const normHome = norm(home);
          const normAway = norm(away);
          return fDate === date &&
            (fHome.includes(normHome.split(' ')[0]) || normHome.includes(fHome.split(' ')[0])) &&
            (fAway.includes(normAway.split(' ')[0]) || normAway.includes(fAway.split(' ')[0]));
        });

        if (match) {
          const fid = match.id || match.fixtureId;
          console.log(`    ✅ [ENCONTRADO] → OddsPapi fixtureId: ${fid}`);
          cruzamentos.push({ status: 'ENCONTRADO', home, away, date, oddspapi_id: fid });
        } else {
          console.log(`    ❌ [NÃO ENCONTRADO] na OddsPapi`);
          cruzamentos.push({ status: 'NÃO ENCONTRADO', home, away, date });
        }
      }
    } catch(e) {
      console.log(`  ❌ Erro passo 2: ${e.message}`);
    }
  }

  relatorio.passo2 = { cruzamentos };

  // ─── PASSO 3 — Odds da Estrela Bet ──────────────────────────
  console.log('\n📡 PASSO 3 — Buscando odds da Estrela Bet...');

  if (!ODDSPAPI_KEY) {
    console.log('  ⚠️  ODDSPAPI_KEY não definida — pulando passo 3');
  } else {
    // Testar nos encontrados no cruzamento + primeiros 3 com odds
    const idsParaTestar = [
      ...cruzamentos.filter(c => c.oddspapi_id).map(c => ({ id: c.oddspapi_id, label: `${c.home} x ${c.away}` })),
      ...fixturesOddsPapi.slice(0, 3).map(f => ({
        id: f.id || f.fixtureId,
        label: `${f.homeTeam?.name || f.home} x ${f.awayTeam?.name || f.away}`
      }))
    ].filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i); // deduplicar

    for (const { id, label } of idsParaTestar.slice(0, 5)) {
      console.log(`\n  Fixture: ${label} (id: ${id})`);
      try {
        const url = `https://api.oddspapi.io/v4/odds?fixtureId=${id}&bookmakers=estrelabet&apiKey=${ODDSPAPI_KEY}`;
        const data = await get(url);

        const odds = data.odds || data.bookmakerOdds || data;
        const estrelaBet = odds?.estrelabet || odds?.['Estrela Bet'] ||
          (Array.isArray(odds) ? odds.find(b => norm(b.bookmaker || b.name || '') === 'estrelabet') : null);

        if (estrelaBet) {
          console.log(`  ✅ Estrela Bet disponível!`);
          const mercados = estrelaBet.markets || estrelaBet.odds || estrelaBet;
          let todasApostas = [];

          if (Array.isArray(mercados)) {
            mercados.forEach(m => {
              const marketId = m.marketId || m.id;
              const marketName = m.marketName || m.name || 'Desconhecido';
              console.log(`    [${marketId}] ${marketName}`);
              const selecoes = m.selections || m.outcomes || m.odds || [];
              selecoes.forEach(s => {
                const nome = s.name || s.selection || s.label || '?';
                const odd = parseFloat(s.odds || s.price || s.value || 0);
                console.log(`      → ${nome}: ${odd}`);
                todasApostas.push({ marketId, marketName, nome, odd });
              });
            });
          } else if (typeof mercados === 'object') {
            Object.entries(mercados).forEach(([marketId, sels]) => {
              console.log(`    [${marketId}]`);
              if (Array.isArray(sels)) {
                sels.forEach(s => {
                  const odd = parseFloat(s.odds || s.price || s.value || 0);
                  console.log(`      → ${s.name || s.selection}: ${odd}`);
                  todasApostas.push({ marketId, nome: s.name || s.selection, odd });
                });
              }
            });
          }

          const acima125 = todasApostas.filter(a => a.odd >= 1.25).length;
          const marketIds = [...new Set(todasApostas.map(a => a.marketId))];

          console.log(`\n  Total apostas disponíveis: ${todasApostas.length}`);
          console.log(`  Apostas com odd >= 1.25: ${acima125}`);
          console.log(`  Market IDs: [${marketIds.join(', ')}]`);

          relatorio.passo3.push({
            fixture: label, id,
            estrelabet_disponivel: true,
            total_apostas: todasApostas.length,
            apostas_acima_125: acima125,
            market_ids: marketIds,
            apostas: todasApostas,
            raw: data
          });

        } else {
          console.log(`  ❌ Estrela Bet NÃO disponível`);
          console.log(`  Bookmakers disponíveis: ${Object.keys(odds || {}).join(', ') || 'nenhum'}`);
          relatorio.passo3.push({
            fixture: label, id,
            estrelabet_disponivel: false,
            bookmakers_disponiveis: Object.keys(odds || {}),
            raw: data
          });
        }

      } catch(e) {
        console.log(`  ❌ Erro: ${e.message}`);
        relatorio.passo3.push({ fixture: label, id, erro: e.message });
      }

      // Pausa para não sobrecarregar
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ─── RELATÓRIO FINAL ────────────────────────────────────────
  const encontrados = cruzamentos.filter(c => c.status === 'ENCONTRADO').length;
  const comEB = relatorio.passo3.filter(r => r.estrelabet_disponivel).length;

  relatorio.resumo = {
    fixtures_hoje_amanha: relatorio.passo1.total || 0,
    fixtures_com_odds: relatorio.passo1.com_odds || 0,
    jogos_brasileirao_testados: jogosBrasileiraoApiFootball.length,
    cruzamentos_encontrados: encontrados,
    cruzamentos_nao_encontrados: cruzamentos.length - encontrados,
    fixtures_testados_estrelabet: relatorio.passo3.length,
    fixtures_com_estrelabet: comEB,
  };

  console.log('\n========================================');
  console.log('RELATÓRIO FINAL');
  console.log('========================================');
  console.log(`Fixtures hoje/amanhã (sportId=10): ${relatorio.resumo.fixtures_hoje_amanha}`);
  console.log(`Fixtures com hasOdds=true: ${relatorio.resumo.fixtures_com_odds}`);
  console.log(`Jogos Série A testados no cruzamento: ${relatorio.resumo.jogos_brasileirao_testados}`);
  console.log(`  Encontrados na OddsPapi: ${relatorio.resumo.cruzamentos_encontrados}`);
  console.log(`  Não encontrados: ${relatorio.resumo.cruzamentos_nao_encontrados}`);
  console.log(`Fixtures testados com Estrela Bet: ${relatorio.resumo.fixtures_testados_estrelabet}`);
  console.log(`  Estrela Bet disponível: ${relatorio.resumo.fixtures_com_estrelabet}`);
  console.log('========================================\n');

  // Salvar JSON
  const outPath = './teste-oddspapi-resultado.json';
  fs.writeFileSync(outPath, JSON.stringify(relatorio, null, 2));
  console.log(`✅ Resultado completo salvo em: ${outPath}`);
}

main().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
