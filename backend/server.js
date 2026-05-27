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

const HEADERS_AF = () => ({
  'x-apisports-key': APIFOOTBALL_KEY
});

// IDs de liga na API-Football (api-sports.io)
const LIGAS_PRIORITY = {
  71:  { nome:'Série A',          tipo:'a',    pri:1 },
  72:  { nome:'Série B',          tipo:'b',    pri:2 },
  135: { nome:'Serie A 🇮🇹',      tipo:'it',   pri:3 },
  140: { nome:'La Liga 🇪🇸',       tipo:'es',   pri:4 },
  39:  { nome:'Premier League',   tipo:'eu',   pri:5 },
  78:  { nome:'Bundesliga',       tipo:'eu',   pri:6 },
  61:  { nome:'Ligue 1',          tipo:'eu',   pri:6 },
  94:  { nome:'Liga Portugal',    tipo:'eu',   pri:6 },
  13:  { nome:'Libertadores',     tipo:'copa', pri:7 },
  11:  { nome:'Sul-Americana',    tipo:'copa', pri:7 },
  3:   { nome:'Europa League',    tipo:'copa', pri:7 },
  2:   { nome:'Champions League', tipo:'copa', pri:7 },
};

// Ligas complementares
const LIGAS_COMP1 = [88, 144, 253, 179, 197, 207, 218, 98, 65, 113];
const LIGAS_COMP2 = [128, 131, 239, 265, 269, 273, 293, 308];

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

async function dbDeleteCalibracao(tipo) {
  try {
    const rows = await dbGetCalibracoes(tipo, 100);
    if (rows.length <= 1) return;
    const ids = rows.slice(1).map(r => r.id).join(',');
    await fetch(`${SUPABASE_URL}/rest/v1/calibracao?id=in.(${ids})`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) { console.error('Erro dbDeleteCalibracao:', e.message); }
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

// ─── API-Football ─────────────────────────────────────────────
async function buscarFixturesPorData(data) {
  try {
    const url = `https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`;
    const res = await fetch(url, { headers: HEADERS_AF() });
    if (!res.ok) {
      console.log(`API-Football erro ${res.status}`);
      return [];
    }
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      console.log('API-Football errors:', JSON.stringify(json.errors));
      return [];
    }
    return json.response || [];
  } catch(e) {
    console.error('Erro buscarFixtures:', e.message);
    return [];
  }
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
        return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

// ─── Buscar memória de calibração ────────────────────────────
async function buscarMemoria() {
  const [semestral, mensal, semanal, diario] = await Promise.all([
    dbGetCalibracao('semestral'),
    dbGetCalibracao('mensal'),
    dbGetCalibracao('semanal'),
    dbGetCalibracao('diario')
  ]);
  let memoria = '';
  if (semestral) memoria += `\n[SEMESTRAL ${semestral.periodo_inicio} a ${semestral.periodo_fim} | ${semestral.assertividade}%]\n${semestral.relatorio}\n`;
  if (mensal)    memoria += `\n[MENSAL ${mensal.periodo_inicio} a ${mensal.periodo_fim} | ${mensal.assertividade}%]\n${mensal.relatorio}\n`;
  if (semanal)   memoria += `\n[SEMANAL ${semanal.periodo_inicio} a ${semanal.periodo_fim} | ${semanal.assertividade}%]\n${semanal.relatorio}\n`;
  if (diario)    memoria += `\n[DIÁRIO ${diario.periodo_inicio} | ${diario.assertividade}%]\n${diario.relatorio}\n`;
  return memoria;
}

// ─── Geração de apostas ──────────────────────────────────────
async function gerarApostas(data, horaMin, metaJogos) {
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;

  console.log(`Buscando fixtures para ${data} na API-Football...`);
  const fixtures = await buscarFixturesPorData(data);
  console.log(`Total de fixtures recebidos: ${fixtures.length}`);

  // Filtrar por horário e status (apenas jogos não iniciados)
  const agora = Math.floor(Date.now() / 1000);
  const jogosMap = new Map();
  const jogosComp = new Map();

  for (const f of fixtures) {
    const ts = f.fixture?.timestamp;
    const status = f.fixture?.status?.short;
    const ligaId = f.league?.id;
    const timeCasa = f.teams?.home?.name;
    const timeFora = f.teams?.away?.name;

    if (!ts || !timeCasa || !timeFora) continue;

    // Só jogos não iniciados
    if (status !== 'NS') continue;

    // Filtrar jogos Sub (U17, U18, U20, U21, U23, etc.)
    const subRegex = /\bU\d{2}\b/i;
    const ligaNomeCheck = f.league?.name || '';
    if (subRegex.test(timeCasa) || subRegex.test(timeFora) || subRegex.test(ligaNomeCheck)) continue;

    // Filtrar ligas amadoras e de base irrelevantes
    const ligaLower = ligaNomeCheck.toLowerCase();
    if (
      ligaLower.includes("amateur") || ligaLower.includes("amador") ||
      ligaLower.includes("reserve") || ligaLower.includes("reserva") ||
      ligaLower.includes("youth") || ligaLower.includes("juvenil")
    ) continue;

    // Converter timestamp para minutos do dia em Brasília (UTC-3)
    const dt = new Date(ts * 1000);
    const hBR = dt.getUTCHours() - 3;
    const mBR = dt.getUTCMinutes();
    const totalMin = hBR * 60 + mBR;
    if (totalMin < minMinutos) continue;

    const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
    const key = `${timeCasa}-${timeFora}`;
    const ligaNome = f.league?.name || `Liga ${ligaId}`;
    const pais = f.league?.country || '';

    if (LIGAS_PRIORITY[ligaId]) {
      const liga = LIGAS_PRIORITY[ligaId];
      if (!jogosMap.has(key)) {
        jogosMap.set(key, { liga: liga.nome, tipo: liga.tipo, pri: liga.pri, timeCasa, timeFora, horario: hStr });
      }
    } else if (jogosMap.size < metaJogos) {
      if (!jogosComp.has(key)) {
        jogosComp.set(key, { liga: `${ligaNome} (${pais})`, tipo: 'eu', pri: 8, timeCasa, timeFora, horario: hStr });
      }
    }
  }

  // Combinar prioritários + complementares até meta
  let jogos = Array.from(jogosMap.values()).sort((a,b) => a.pri - b.pri || a.horario.localeCompare(b.horario));

  if (jogos.length < metaJogos) {
    const comp = Array.from(jogosComp.values()).slice(0, metaJogos - jogos.length);
    jogos = [...jogos, ...comp];
  }

  console.log(`Jogos selecionados: ${jogos.length}`);
  jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

  if (!jogos.length) return null;

  const ano = parseInt(data.substring(0,4));
  const mes = parseInt(data.substring(5,7));
  const dia = parseInt(data.substring(8,10));
  const df = `${String(dia).padStart(2,'0')}/${String(mes).padStart(2,'0')}/${ano}`;
  const listaJogos = jogos.map((j,i) => `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`).join('\n');

  const memoria = await buscarMemoria();
  const blocoMemoria = memoria ? `\nHISTÓRICO DE CALIBRAÇÃO (use para melhorar suas apostas):\n${memoria}\n` : '';

  const prompt = `Você é um analista de apostas esportivas especializado e em constante aprendizado. Analise os jogos CONFIRMADOS pela API-Football para ${df} e gere 1 aposta por jogo para a Estrela Bet.
${blocoMemoria}
JOGOS VALIDADOS:
${listaJogos}

REGRAS:
- Série A e Série B têm análise OBRIGATÓRIA
- Analise últimos 10 jogos de cada time (gols, escanteios, vitórias, fase, tabela, cartões) + confronto direto último ano
- Use o histórico de calibração para evitar padrões que historicamente erram
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
  if (!row?.apostas?.jogos) { console.log('Sem apostas para validar'); return; }
  if (row.resultados) { console.log('Já validado'); return; }

  const jogos = row.apostas.jogos;
  const resultados = [];

  for (const jogo of jogos) {
    const prompt = `Você é um verificador de resultados de apostas esportivas. Use busca na web para encontrar o resultado real do jogo abaixo.

Jogo: ${jogo.time_casa} x ${jogo.time_fora}
Data: ${data}
Aposta feita: ${jogo.aposta}
Mercado: ${jogo.mercado}

Busque o resultado real. Determine se a aposta bateu (GREEN) ou não (RED).
Responda SOMENTE em JSON:
{"encontrado": true, "placar": "2-1", "resultado_aposta": "green", "motivo": "explicação breve"}
Se não encontrar: {"encontrado": false, "placar": null, "resultado_aposta": "pendente", "motivo": "não encontrado"}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 500,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const json = await res.json();
      const txt = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
      if (s !== -1) {
        const r = JSON.parse(txt.slice(s, e+1));
        resultados.push({ ...r, jogo_id: jogo.id, time_casa: jogo.time_casa, time_fora: jogo.time_fora, aposta: jogo.aposta });
      }
    } catch(err) {
      resultados.push({ encontrado: false, placar: null, resultado_aposta: 'pendente', motivo: err.message, jogo_id: jogo.id });
    }
    await sleep(500);
  }

  const green = resultados.filter(r => r.resultado_aposta === 'green').length;
  const red = resultados.filter(r => r.resultado_aposta === 'red').length;
  await dbSaveResultados(data, { validado_em: new Date().toISOString(), apostas: resultados });
  console.log(`✅ Validação salva: ${green} green, ${red} red`);
}

// ─── AGENTE DIÁRIO ────────────────────────────────────────────
async function agentDiario(data) {
  console.log(`\n📊 Agente Diário — ${data}`);
  const row = await dbGet(data);
  if (!row?.resultados) { console.log('Sem resultados'); return; }

  const apostas = row.apostas?.jogos || [];
  const resultados = row.resultados?.apostas || [];
  const green = resultados.filter(r => r.resultado_aposta === 'green').length;
  const red = resultados.filter(r => r.resultado_aposta === 'red').length;
  const total = green + red;
  const assertividade = total > 0 ? ((green/total)*100).toFixed(2) : 0;

  const detalhes = resultados.map(r => {
    const a = apostas.find(x => x.id === r.jogo_id);
    return `- ${r.time_casa} x ${r.time_fora}: ${a?.aposta || r.aposta} → ${r.resultado_aposta?.toUpperCase()} (${r.placar || '-'}) | ${r.motivo}`;
  }).join('\n');

  const prompt = `Analise os resultados das apostas do dia ${data} e identifique padrões.

Assertividade: ${assertividade}% (${green} green, ${red} red de ${total})

Detalhes:
${detalhes}

Identifique: quais tipos erraram mais e por quê, padrões que enganaram a análise, o que melhorar.
Seja direto e técnico. Máximo 300 palavras.`;

  const relatorio = await chamarIA(prompt, 2000);
  if (!relatorio) return;
  await dbSaveCalibracao('diario', data, data, relatorio, parseFloat(assertividade));
  console.log(`✅ Relatório diário — assertividade: ${assertividade}%`);
}

// ─── AGENTE SEMANAL ───────────────────────────────────────────
async function agentSemanal() {
  const hoje = hojeStr();
  const diarios = await dbGetCalibracoes('diario', 7);
  if (!diarios.length) { console.log('Sem diários para consolidar'); return; }

  const media = (diarios.reduce((s,d) => s + (parseFloat(d.assertividade)||0), 0) / diarios.length).toFixed(2);
  const textos = diarios.map((d,i) => `Dia ${i+1} (${d.periodo_inicio}) — ${d.assertividade}%:\n${d.relatorio}`).join('\n---\n');
  const inicio = diarios[diarios.length-1].periodo_inicio;

  const prompt = `Consolide os relatórios diários desta semana em um único relatório semanal.
Período: ${inicio} a ${hoje} | Assertividade média: ${media}%

${textos}

Gere relatório semanal: padrões recorrentes, mercados melhores/piores, recomendações. Máximo 400 palavras.`;

  const relatorio = await chamarIA(prompt, 2000);
  if (!relatorio) return;
  await dbSaveCalibracao('semanal', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracao('diario');
  console.log(`✅ Relatório semanal — média: ${media}%`);
}

// ─── AGENTE MENSAL ────────────────────────────────────────────
async function agentMensal() {
  const hoje = hojeStr();
  const semanais = await dbGetCalibracoes('semanal', 5);
  if (!semanais.length) { console.log('Sem semanais'); return; }

  const media = (semanais.reduce((s,x) => s + (parseFloat(x.assertividade)||0), 0) / semanais.length).toFixed(2);
  const textos = semanais.map((s,i) => `Semana ${i+1} (${s.periodo_inicio} a ${s.periodo_fim}) — ${s.assertividade}%:\n${s.relatorio}`).join('\n---\n');
  const inicio = semanais[semanais.length-1].periodo_inicio;

  const prompt = `Consolide os relatórios semanais em um relatório mensal.
Período: ${inicio} a ${hoje} | Assertividade média: ${media}%

${textos}

${parseFloat(media) >= 80 ? 'Acima de 80% — mantenha os padrões.' : 'Abaixo de 80% — identifique o que mudar.'}
Gere relatório mensal com diretrizes para o próximo mês. Máximo 500 palavras.`;

  const relatorio = await chamarIA(prompt, 3000);
  if (!relatorio) return;
  await dbSaveCalibracao('mensal', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracao('semanal');
  console.log(`✅ Relatório mensal — média: ${media}%`);
}

// ─── AGENTE SEMESTRAL ─────────────────────────────────────────
async function agentSemestral() {
  const hoje = hojeStr();
  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length < 3) { console.log('Poucos mensais'); return; }

  const media = (mensais.reduce((s,m) => s + (parseFloat(m.assertividade)||0), 0) / mensais.length).toFixed(2);
  const textos = mensais.map((m,i) => `Mês ${i+1} (${m.periodo_inicio} a ${m.periodo_fim}) — ${m.assertividade}%:\n${m.relatorio}`).join('\n---\n');
  const inicio = mensais[mensais.length-1].periodo_inicio;

  const prompt = `Consolide os relatórios mensais em um relatório semestral.
Período: ${inicio} a ${hoje} | Assertividade média: ${media}%

${textos}

Gere relatório semestral profundo: evolução da assertividade, padrões persistentes, estratégias para próximo semestre. Máximo 600 palavras.`;

  const relatorio = await chamarIA(prompt, 4000);
  if (!relatorio) return;
  await dbSaveCalibracao('semestral', inicio, hoje, relatorio, parseFloat(media));
  await dbDeleteCalibracao('mensal');
  console.log(`✅ Relatório semestral — média: ${media}%`);
}

// ─── ROTINA NOTURNA ───────────────────────────────────────────
async function rotinaNoturna() {
  const hoje = hojeStr();
  const ontem = diaOffset(hoje, -1);
  console.log(`\n🌙 Rotina noturna — ${hoje}`);

  await agentValidar(ontem);
  await agentDiario(ontem);

  if (diaSemana(hoje) === 0) await agentSemanal();

  const diaAtual = hoje.substring(8,10);
  if (diaAtual === ultimoDiaMes(hoje)) await agentMensal();

  const mensais = await dbGetCalibracoes('mensal', 6);
  if (mensais.length >= 6) await agentSemestral();

  console.log('✅ Rotina noturna concluída');
}

// ─── Endpoints ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', api: 'API-Football v3' }));

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
      await dbSave(data, resultado);
      console.log('✅ Salvo no banco');
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
    if (cached?.apostas) return res.json({ data: dataConsulta, ...cached.apostas, resultados: cached.resultados });
    return res.json({ data: dataConsulta, jogos: [], aviso: `Apostas para ${dataConsulta} ainda não foram geradas.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/rotina-noturna', async (req, res) => {
  res.json({ mensagem: 'Rotina iniciada em segundo plano' });
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
