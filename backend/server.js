const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const HEADERS = () => ({
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': 'sofascore.p.rapidapi.com'
});

const CATEGORIAS = [13, 31, 32, 1, 30, 7, 44, 1470, 1465, 1468];

const LIGAS = {
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

function normalizarData(data) {
  if (!data) return null;
  if (data.includes('/')) {
    const p = data.split('/');
    if (p.length === 3) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }
  return data;
}

function diaAnterior(dataStr) {
  const ano = parseInt(dataStr.substring(0,4));
  const mes = parseInt(dataStr.substring(5,7));
  const dia = parseInt(dataStr.substring(8,10));
  let nDia = dia - 1, nMes = mes, nAno = ano;
  if (nDia < 1) {
    nMes--;
    if (nMes < 1) { nMes = 12; nAno--; }
    const dim = [0,31,28,31,30,31,30,31,31,30,31,30,31];
    if (nMes === 2 && ((nAno%4===0&&nAno%100!==0)||nAno%400===0)) nDia = 29;
    else nDia = dim[nMes];
  }
  return `${nAno}-${String(nMes).padStart(2,'0')}-${String(nDia).padStart(2,'0')}`;
}

async function buscarJogosCat(catId, data) {
  try {
    const res = await fetch(
      `https://sofascore.p.rapidapi.com/tournaments/get-scheduled-events?categoryId=${catId}&date=${data}`,
      { headers: HEADERS() }
    );
    if (!res.ok) {
      console.log(`  Cat ${catId}/${data}: HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    const eventos = json.events || [];
    if (eventos.length > 0) {
      console.log(`  Cat ${catId}/${data}: ${eventos.length} eventos`);
      // Log das ligas encontradas para debug
      const ligas = [...new Set(eventos.map(e => e.tournament?.uniqueTournament?.id))];
      const ligasPri = ligas.filter(id => LIGAS[id]);
      if (ligasPri.length > 0) console.log(`    Ligas prioritárias: ${ligasPri.map(id => LIGAS[id].nome).join(', ')}`);
    }
    return eventos;
  } catch(e) {
    console.log(`  Cat ${catId}/${data}: erro ${e.message}`);
    return [];
  }
}

async function chamarIA(prompt) {
  const modelos = ['claude-haiku-4-5','claude-sonnet-4-5','claude-3-5-haiku-20241022','claude-3-5-sonnet-20241022','claude-3-haiku-20240307'];
  for (const modelo of modelos) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
      });
      const json = await res.json();
      if (!json.error) { console.log(`✅ Modelo: ${modelo}`); return json; }
      console.log(`❌ ${modelo}: ${json.error.message}`);
    } catch(e) { console.log(`❌ ${modelo}: ${e.message}`); }
  }
  return null;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/analisar', async (req, res) => {
  let { data, hora, meta } = req.body;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY não configurada.' });
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  data = normalizarData(data);
  if (!data) return res.status(400).json({ error: 'Formato de data inválido.' });

  const horaMin = hora || '13:00';
  const metaJogos = parseInt(meta) || 15;
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;

  const ano = parseInt(data.substring(0,4));
  const mes = parseInt(data.substring(5,7)) - 1;
  const dia = parseInt(data.substring(8,10));
  const inicioDia = Math.floor(Date.UTC(ano, mes, dia, 3, 0, 0) / 1000);
  const fimDia = inicioDia + 86400;

  const anterior = diaAnterior(data);
  const datasParaBuscar = [anterior, data];

  try {
    console.log(`\n=== ${data} (Brasília) ===`);
    console.log(`Janela: ${new Date(inicioDia*1000).toISOString()} → ${new Date(fimDia*1000).toISOString()}`);
    console.log(`APIs: ${datasParaBuscar.join(' + ')}`);

    const jogosMap = new Map();
    let totalEventosBrutos = 0;
    let totalNaJanela = 0;

    const buscas = [];
    for (const catId of CATEGORIAS) {
      for (const d of datasParaBuscar) {
        buscas.push(buscarJogosCat(catId, d));
      }
    }
    const resultados = await Promise.all(buscas);

    for (const eventos of resultados) {
      totalEventosBrutos += eventos.length;
      for (const ev of eventos) {
        const ts = ev.startTimestamp;
        if (!ts) continue;
        if (ts >= inicioDia && ts < fimDia) totalNaJanela++;

        const ligaId = ev.tournament?.uniqueTournament?.id;
        const liga = LIGAS[ligaId];
        if (!liga) continue;
        if (ts < inicioDia || ts >= fimDia) continue;

        // Calcular horário Brasília
        const segundosNoDia = ts - inicioDia;
        const hBR = Math.floor(segundosNoDia / 3600);
        const mBR = Math.floor((segundosNoDia % 3600) / 60);
        const totalMin = hBR * 60 + mBR;
        if (totalMin < minMinutos) continue;

        const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
        const key = `${ev.homeTeam?.name}-${ev.awayTeam?.name}`;
        if (!jogosMap.has(key)) {
          jogosMap.set(key, {
            liga: liga.nome, tipo: liga.tipo, pri: liga.pri,
            timeCasa: ev.homeTeam?.name, timeFora: ev.awayTeam?.name, horario: hStr
          });
        }
      }
    }

    console.log(`\nDebug: ${totalEventosBrutos} eventos brutos, ${totalNaJanela} na janela Brasília`);

    const jogos = Array.from(jogosMap.values())
      .sort((a, b) => a.pri - b.pri || a.horario.localeCompare(b.horario))
      .slice(0, metaJogos);

    console.log(`Jogos prioritários encontrados: ${jogos.length}`);
    jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

    if (!jogos.length) return res.json({ jogos: [], aviso: 'Nenhum jogo encontrado nas ligas prioritárias.' });

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
    if (!iaJson) return res.status(500).json({ error: 'Nenhum modelo de IA disponível.' });

    const txt = (iaJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'Resposta inválida da IA.' });

    const parsed = JSON.parse(txt.slice(s, e + 1));
    console.log(`✅ ${parsed.jogos?.length} apostas geradas`);
    res.json(parsed);

  } catch (err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
