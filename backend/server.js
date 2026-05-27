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

const HEADERS_SOFA = () => ({
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': 'sofascore.p.rapidapi.com'
});

const CATEGORIAS = [13, 31, 32, 1, 30, 7, 44, 1470, 1465, 1468];
const CATEGORIAS_COMP1 = [35, 77, 86, 152, 47, 23, 24, 25];
const CATEGORIAS_COMP2 = [48, 49, 165, 274, 280, 281, 20, 57];

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
  const ultimo = new Date(Date.UTC(ano, mes, 0));
  return String(ultimo.getUTCDate()).padStart(2,'0');
}

function diaSemana(dataStr) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7)) - 1;
  const dia = parseInt(dataStr.substring(8,10));
  return new Date(Date.UTC(ano, mes, dia)).getUTCDay(); // 0=domingo
}

// ─── Supabase ────────────────────────────────────────────────
async function dbGet(data) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}&select=apostas,resultados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (rows && rows.length > 0) return rows[0];
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
  } catch(e) { console.error('Erro dbSave:', e.message); }
}

async function dbSaveResultados(data, resultados) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/apostas_dia?data=eq.${data}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
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
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tipo,
        periodo_inicio: periodoInicio,
        periodo_fim: periodoFim,
        relatorio,
        assertividade
      })
    });
  } catch(e) { console.error('Erro dbSaveCalibracao:', e.message); }
}

async function dbDeleteCalibracao(tipo, antes) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.${tipo}&criado_em=lt.${antes}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) { console.error('Erro dbDeleteCalibracao:', e.message); }
}

async function dbGetCalibracoes(tipo, limit) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calibracao?tipo=eq.${tipo}&order=criado_em.desc&limit=${limit}&select=relatorio,assertividade,periodo_inicio,periodo_fim`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    return await res.json() || [];
  } catch(e) { return []; }
}

async function dbGetApostasIntervalo(dataInicio, dataFim) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apostas_dia?data=gte.${dataInicio}&data=lte.${dataFim}&select=data,apostas,resultados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    return await res.json() || [];
  } catch(e) { return []; }
}

// ─── IA ──────────────────────────────────────────────────────
async function chamarIA(prompt, maxTokens = 8000) {
  const modelos = ['claude-haiku-4-5','claude-sonnet-4-5','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
      });
      const json = await res.json();
      if (!json.error) {
        console.log(`✅ Modelo: ${modelo}`);
        return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

// ─── Buscar memória de calibração ────────────────────────────
async function buscarMemoria() {
  const semestral = await dbGetCalibracao('semestral');
  const mensal    = await dbGetCalibracao('mensal');
  const semanal   = await dbGetCalibracao('semanal');
  const diario    = await dbGetCalibracao('diario');

  let memoria = '';
  if (semestral) memoria += `\n[SEMESTRAL - ${semestral.periodo_inicio} a ${semestral.periodo_fim} | Assertividade: ${semestral.assertividade}%]\n${semestral.relatorio}\n`;
  if (mensal)    memoria += `\n[MENSAL - ${mensal.periodo_inicio} a ${mensal.periodo_fim} | Assertividade: ${mensal.assertividade}%]\n${mensal.relatorio}\n`;
  if (semanal)   memoria += `\n[SEMANAL - ${semanal.periodo_inicio} a ${semanal.periodo_fim} | Assertividade: ${semanal.assertividade}%]\n${semanal.relatorio}\n`;
  if (diario)    memoria += `\n[DIÁRIO - ${diario.periodo_inicio} | Assertividade: ${diario.assertividade}%]\n${diario.relatorio}\n`;

  return memoria;
}

// ─── Sofascore ───────────────────────────────────────────────
async function buscarJogosCat(catId, data) {
  try {
    const res = await fetch(
      `https://sofascore.p.rapidapi.com/tournaments/get-scheduled-events?categoryId=${catId}&date=${data}`,
      { headers: HEADERS_SOFA() }
    );
    if (!res.ok) {
      if (res.status === 429) { await sleep(2000); }
      return [];
    }
    return (await res.json()).events || [];
  } catch(e) { return []; }
}

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
          novos.set(key, {
            liga: ev.tournament?.name || `Liga ${catId}`,
            tipo: 'eu', pri: 8,
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

// ─── Geração de apostas ──────────────────────────────────────
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

  for (const catId of CATEGORIAS) {
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

  if (jogosMap.size < metaJogos) {
    const extras = await buscarJogosLivres(CATEGORIAS_COMP1, datasParaBuscar, inicioDia, fimDia, minMinutos, jogosMap);
    extras.slice(0, metaJogos - jogosMap.size).forEach(j => jogosMap.set(`${j.timeCasa}-${j.timeFora}`, j));
  }

  if (jogosMap.size < metaJogos) {
    const extras = await buscarJogosLivres(CATEGORIAS_COMP2, datasParaBuscar, inicioDia, fimDia, minMinutos, jogosMap);
    extras.slice(0, metaJogos - jogosMap.size).forEach(j => jogosMap.set(`${j.timeCasa}-${j.timeFora}`, j));
  }

  const jogos = Array.from(jogosMap.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));
  console.log(`Jogos encontrados: ${jogos.length}`);
  if (!jogos.length) return null;

  const df = `${String(dia).padStart(2,'0')}/${String(mes+1).padStart(2,'0')}/${ano}`;
  const listaJogos = jogos.map((j,i) => `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`).join('\n');

  // Buscar memória de calibração
  const memoria = await buscarMemoria();
  const blocoMemoria = memoria ? `\nHISTÓRICO E CALIBRAÇÃO (use para melhorar suas apostas):\n${memoria}\n` : '';

  const prompt = `Você é um analista de apostas esportivas especializado e em constante aprendizado. Analise os jogos CONFIRMADOS pela API Sofascore para ${df} e gere 1 aposta por jogo para a Estrela Bet.
${blocoMemoria}
JOGOS VALIDADOS:
${listaJogos}

REGRAS:
- Série A e Série B têm análise OBRIGATÓRIA
- Analise últimos 10 jogos de cada time (gols, escanteios, vitórias, fase, tabela, cartões) + confronto direto último ano
- Use o histórico de calibração acima para evitar padrões que historicamente erram
- 1 aposta por jogo com mercado definido pelos dados

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"Time A","time_fora":"Time B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"3-4 linhas com dados que embasam a aposta."}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;

  const txt = await chamarIA(prompt);
  if (!txt) return null;
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  return JSON.parse(txt.slice(s, e+1));
}

// ─── AGENTE VALIDADOR ─────────────────────────────────────────
async function agentValidar(data) {
  console.log(`\n🔍 Agente Validador — ${data}`);
  const row = await dbGet(data);
  if (!row || !row.apostas || !row.apostas.jogos) {
    console.log('Sem apostas para validar');
    return;
  }
  if (row.resultados) {
    console.log('Já validado');
    return;
  }

  const jogos = row.apostas.jogos;
  const resultados = [];

  for (const jogo of jogos) {
    const query = `${jogo.time_casa} x ${jogo.time_fora} resultado ${data}`;
    console.log(`Buscando: ${query}`);

    const prompt = `Você é um verificador de resultados de futebol. 
    
Jogo: ${jogo.time_casa} x ${jogo.time_fora}
Data: ${data}
Aposta feita: ${jogo.aposta}
Mercado: ${jogo.mercado}
Justificativa original: ${jogo.justificativa}

Busque o resultado real deste jogo. Se encontrar, determine se a aposta bateu (GREEN) ou não bateu (RED).

Responda SOMENTE em JSON:
{"encontrado": true/false, "placar": "2-1", "resultado_aposta": "green"/"red", "motivo": "breve explicação"}

Se não encontrar o resultado, responda: {"encontrado": false, "placar": null, "resultado_aposta": "pendente", "motivo": "jogo não encontrado"}`;

    const tools = [{
      type: "web_search_20250305",
      name: "web_search"
    }];

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1000,
          tools,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const json = await res.json();
      const txt = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
      if (s !== -1 && e !== -1) {
        const r = JSON.parse(txt.slice(s, e+1));
        resultados.push({ ...r, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
      }
    } catch(err) {
      console.log(`Erro ao validar ${jogo.time_casa} x ${jogo.time_fora}: ${err.message}`);
      resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: err.message, jogo_id: jogo.id });
    }

    await sleep(500);
  }

  await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: resultados });
  console.log(`✅ Validação salva para ${data}: ${resultados.filter(r => r.resultado_aposta === 'green').length} green, ${resultados.filter(r => r.resultado_aposta === 'red').length} red`);
  return resultados;
}

// ─── AGENTE DIÁRIO ────────────────────────────────────────────
async function agentDiario(data) {
  console.log(`\n📊 Agente Diário — ${data}`);
  const row = await dbGet(data);
  if (!row || !row.resultados) {
    console.log('Sem resultados para analisar');
    return;
  }

  const apostas = row.apostas?.jogos || [];
  const resultados = row.resultados?.apostas || [];
  const green = resultados.filter(r => r.resultado_aposta === 'green').length;
  const red = resultados.filter(r => r.resultado_aposta === 'red').length;
  const total = green + red;
  const assertividade = total > 0 ? ((green / total) * 100).toFixed(2) : 0;

  const detalhes = resultados.map(r => {
    const aposta = apostas.find(a => a.id === r.jogo_id);
    return `- ${r.time_casa} x ${r.time_fora}: ${r.aposta || aposta?.aposta} → ${r.resultado_aposta?.toUpperCase()} (${r.placar || 'sem placar'}) | Motivo: ${r.motivo}`;
  }).join('\n');

  const prompt = `Você é um analista de apostas esportivas especializado em identificar padrões de acerto e erro.

Data: ${data}
Assertividade do dia: ${assertividade}% (${green} green, ${red} red de ${total} apostas)

Detalhes das apostas:
${detalhes}

Analise os padrões de erro e acerto deste dia. Identifique:
1. Quais tipos de aposta erraram mais e por quê
2. Quais padrões estatísticos enganaram a análise
3. O que poderia ter sido diferente na análise
4. Recomendações específicas para apostas futuras

Seja direto, objetivo e técnico. Máximo 300 palavras.`;

  const relatorio = await chamarIA(prompt, 2000);
  if (!relatorio) return;

  await dbSaveCalibracao('diario', data, data, relatorio, parseFloat(assertividade));
  console.log(`✅ Relatório diário salvo — assertividade: ${assertividade}%`);
}

// ─── AGENTE SEMANAL ───────────────────────────────────────────
async function agentSemanal() {
  const hoje = hojeStr();
  console.log(`\n📅 Agente Semanal — consolidando semana até ${hoje}`);

  const inicioSemana = diaOffset(hoje, -6);
  const diarios = await dbGetCalibracoes('diario', 7);

  if (diarios.length === 0) {
    console.log('Sem relatórios diários para consolidar');
    return;
  }

  const totalAssertividade = diarios.reduce((sum, d) => sum + (parseFloat(d.assertividade) || 0), 0);
  const mediaAssert = (totalAssertividade / diarios.length).toFixed(2);

  const textos = diarios.map((d, i) => `Dia ${i+1} (${d.periodo_inicio}) — ${d.assertividade}%:\n${d.relatorio}`).join('\n\n---\n\n');

  const prompt = `Você é um analista de apostas esportivas. Consolide os relatórios diários desta semana em um único relatório semanal.

Período: ${inicioSemana} a ${hoje}
Assertividade média da semana: ${mediaAssert}%

Relatórios diários:
${textos}

Gere um relatório semanal consolidado que:
1. Identifique os padrões recorrentes de erro e acerto
2. Destaque quais mercados performaram melhor/pior
3. Aponte tendências importantes para as próximas apostas
4. Dê recomendações claras baseadas na semana

Seja direto e técnico. Máximo 400 palavras.`;

  const relatorio = await chamarIA(prompt, 2000);
  if (!relatorio) return;

  await dbSaveCalibracao('semanal', inicioSemana, hoje, relatorio, parseFloat(mediaAssert));

  // Apagar relatórios diários da semana
  const ontem = diaOffset(hoje, -1);
  await dbDeleteCalibracao('diario', new Date().toISOString());
  console.log(`✅ Relatório semanal salvo — média: ${mediaAssert}%`);
}

// ─── AGENTE MENSAL ────────────────────────────────────────────
async function agentMensal() {
  const hoje = hojeStr();
  console.log(`\n📆 Agente Mensal — consolidando mês`);

  const semanais = await dbGetCalibracoes('semanal', 5);
  if (semanais.length === 0) {
    console.log('Sem relatórios semanais para consolidar');
    return;
  }

  const totalAssert = semanais.reduce((sum, s) => sum + (parseFloat(s.assertividade) || 0), 0);
  const mediaAssert = (totalAssert / semanais.length).toFixed(2);
  const inicioMes = semanais[semanais.length - 1].periodo_inicio;

  const textos = semanais.map((s, i) => `Semana ${i+1} (${s.periodo_inicio} a ${s.periodo_fim}) — ${s.assertividade}%:\n${s.relatorio}`).join('\n\n---\n\n');

  const prompt = `Você é um analista de apostas esportivas. Consolide os relatórios semanais deste mês em um relatório mensal.

Período: ${inicioMes} a ${hoje}
Assertividade média do mês: ${mediaAssert}%

Relatórios semanais:
${textos}

Gere um relatório mensal que:
1. Avalie a performance geral do mês
2. Identifique padrões persistentes de erro
3. Destaque o que funcionou bem
4. ${parseFloat(mediaAssert) >= 80 ? 'Parabéns! Assertividade acima de 80%. Mantenha os padrões que funcionaram.' : 'Assertividade abaixo de 80%. Identifique claramente o que precisa mudar.'}
5. Dê diretrizes claras para o próximo mês

Seja técnico e objetivo. Máximo 500 palavras.`;

  const relatorio = await chamarIA(prompt, 3000);
  if (!relatorio) return;

  await dbSaveCalibracao('mensal', inicioMes, hoje, relatorio, parseFloat(mediaAssert));
  await dbDeleteCalibracao('semanal', new Date().toISOString());
  console.log(`✅ Relatório mensal salvo — média: ${mediaAssert}%`);
}

// ─── AGENTE SEMESTRAL ─────────────────────────────────────────
async function agentSemestral() {
  const hoje = hojeStr();
  console.log(`\n🗓️ Agente Semestral — consolidando 6 meses`);

  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length < 3) {
    console.log('Sem mensais suficientes para semestral');
    return;
  }

  const totalAssert = mensais.reduce((sum, m) => sum + (parseFloat(m.assertividade) || 0), 0);
  const mediaAssert = (totalAssert / mensais.length).toFixed(2);
  const inicioSemestre = mensais[mensais.length - 1].periodo_inicio;

  const textos = mensais.map((m, i) => `Mês ${i+1} (${m.periodo_inicio} a ${m.periodo_fim}) — ${m.assertividade}%:\n${m.relatorio}`).join('\n\n---\n\n');

  const prompt = `Você é um analista de apostas esportivas sênior. Consolide os relatórios mensais dos últimos ${mensais.length} meses em um relatório semestral.

Período: ${inicioSemestre} a ${hoje}
Assertividade média do semestre: ${mediaAssert}%

Relatórios mensais:
${textos}

Gere um relatório semestral profundo que:
1. Avalie a evolução da assertividade ao longo do semestre
2. Identifique os padrões mais consistentes de erro e acerto
3. Analise quais mercados, ligas e tipos de aposta performaram melhor
4. Proponha estratégias específicas para o próximo semestre
5. Estabeleça metas realistas baseadas no histórico

Este relatório será a base principal para calibrar a IA nos próximos meses. Seja técnico, preciso e abrangente. Máximo 600 palavras.`;

  const relatorio = await chamarIA(prompt, 4000);
  if (!relatorio) return;

  await dbSaveCalibracao('semestral', inicioSemestre, hoje, relatorio, parseFloat(mediaAssert));
  await dbDeleteCalibracao('mensal', new Date().toISOString());
  console.log(`✅ Relatório semestral salvo — média: ${mediaAssert}%`);
}

// ─── ROTINA NOTURNA ───────────────────────────────────────────
async function rotinaNoturna() {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);

  console.log(`\n🌙 Rotina noturna — ${hoje}`);

  // 1. Validar apostas de ontem
  await agentValidar(ontem);

  // 2. Gerar relatório diário de ontem
  await agentDiario(ontem);

  // 3. Se for domingo (dia 0), consolidar semana
  if (diaSemana(hoje) === 0) {
    await agentSemanal();
  }

  // 4. Se for último dia do mês, consolidar mês
  const diaAtual = hoje.substring(8, 10);
  const ultimoDia = ultimoDiaMes(hoje);
  if (diaAtual === ultimoDia) {
    await agentMensal();
  }

  // 5. Verificar se tem 6 mensais para semestral
  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length >= 6) {
    await agentSemestral();
  }

  console.log('✅ Rotina noturna concluída');
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
      if (cached && cached.apostas) {
        console.log(`✅ Cache hit`);
        return res.json(cached.apostas);
      }
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
  const hoje = hojeStr();
  let dataConsulta;
  if (periodo === 'ontem') dataConsulta = diaOffset(hoje, -1);
  else if (periodo === 'hoje') dataConsulta = hoje;
  else if (periodo === 'amanha') dataConsulta = diaOffset(hoje, 1);
  else return res.status(400).json({ error: 'Use: ontem, hoje ou amanha.' });
  try {
    const cached = await dbGet(dataConsulta);
    if (cached && cached.apostas) return res.json({ data: dataConsulta, ...cached.apostas, resultados: cached.resultados });
    return res.json({ data: dataConsulta, jogos: [], aviso: `Apostas para ${dataConsulta} ainda não foram geradas.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para disparar rotina noturna manualmente (para testes)
app.post('/rotina-noturna', async (req, res) => {
  res.json({ mensagem: 'Rotina iniciada em segundo plano' });
  rotinaNoturna().catch(console.error);
});

// Endpoint para validar um dia específico manualmente
app.post('/validar/:data', async (req, res) => {
  const data = normalizarData(req.params.data);
  if (!data) return res.status(400).json({ error: 'Data inválida.' });
  res.json({ mensagem: `Validação de ${data} iniciada` });
  agentValidar(data).then(() => agentDiario(data)).catch(console.error);
});

// Endpoint para ver relatórios de calibração
app.get('/calibracao', async (req, res) => {
  const semestral = await dbGetCalibracao('semestral');
  const mensal    = await dbGetCalibracao('mensal');
  const semanal   = await dbGetCalibracao('semanal');
  const diario    = await dbGetCalibracao('diario');
  res.json({ semestral, mensal, semanal, diario });
});

// Rotina automática: roda todo dia à meia-noite UTC
function agendarRotina() {
  const agora = new Date();
  const proximaMeia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() + 1, 0, 5, 0));
  const ms = proximaMeia.getTime() - agora.getTime();
  console.log(`⏰ Próxima rotina noturna em ${Math.round(ms/60000)} minutos`);
  setTimeout(() => {
    rotinaNoturna().catch(console.error);
    setInterval(() => rotinaNoturna().catch(console.error), 24 * 60 * 60 * 1000);
  }, ms);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarRotina();
});
