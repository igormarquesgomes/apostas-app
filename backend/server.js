const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const LIGAS = {
  325:  { nome:'Série A',          tipo:'a',    pri:1 },
  390:  { nome:'Série B',          tipo:'b',    pri:2 },
  23:   { nome:'Serie A IT',       tipo:'it',   pri:3 },
  8:    { nome:'La Liga',          tipo:'es',   pri:4 },
  17:   { nome:'Premier League',   tipo:'eu',   pri:5 },
  35:   { nome:'Bundesliga',       tipo:'eu',   pri:6 },
  34:   { nome:'Ligue 1',          tipo:'eu',   pri:6 },
  238:  { nome:'Liga Portugal',    tipo:'eu',   pri:6 },
  384:  { nome:'Libertadores',     tipo:'copa', pri:7 },
  480:  { nome:'Sul-Americana',    tipo:'copa', pri:7 },
  679:  { nome:'Europa League',    tipo:'copa', pri:7 },
  7:    { nome:'Champions League', tipo:'copa', pri:7 },
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/analisar', async (req, res) => {
  const { data, hora, meta } = req.body;

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY não configurada.' });
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const horaMin = hora || '13:00';
  const metaJogos = parseInt(meta) || 15;

  try {
    // PASSO 1: Buscar jogos na API Sofascore
    console.log(`Buscando jogos para ${data}...`);
    const sofaRes = await fetch(`https://sofascore.p.rapidapi.com/matches/get-by-date?date=${data}&page=0`, {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'sofascore.p.rapidapi.com'
      }
    });

    if (!sofaRes.ok) {
      const err = await sofaRes.text();
      return res.status(500).json({ error: `Sofascore API erro ${sofaRes.status}: ${err}` });
    }

    const sofaJson = await sofaRes.json();
    const eventos = sofaJson.events || sofaJson.data || [];
    console.log(`Total de eventos encontrados: ${eventos.length}`);

    // PASSO 2: Filtrar por ligas prioritárias e horário
    const [hM, mM] = horaMin.split(':').map(Number);
    const minMinutos = hM * 60 + mM;

    const jogos = [];
    for (const ev of eventos) {
      const ligaId = ev.tournament?.uniqueTournament?.id;
      const liga = LIGAS[ligaId];
      if (!liga) continue;

      const ts = ev.startTimestamp;
      if (!ts) continue;

      // Converter para horário Brasília (UTC-3)
      const dt = new Date(ts * 1000);
      const hBR = dt.getUTCHours() - 3;
      const mBR = dt.getUTCMinutes();
      const totalMin = hBR * 60 + mBR;
      if (totalMin < minMinutos) continue;

      const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;

      jogos.push({
        liga: liga.nome,
        tipo: liga.tipo,
        pri: liga.pri,
        timeCasa: ev.homeTeam?.name,
        timeFora: ev.awayTeam?.name,
        horario: hStr
      });
    }

    // Ordenar por prioridade e limitar
    jogos.sort((a, b) => a.pri - b.pri);
    const selecionados = jogos.slice(0, metaJogos);
    console.log(`Jogos selecionados: ${selecionados.length}`);

    if (!selecionados.length) {
      return res.status(200).json({ jogos: [], aviso: 'Nenhum jogo encontrado nas ligas prioritárias para este dia e horário.' });
    }

    // PASSO 3: Enviar para IA analisar
    const [ano, mes, dia] = data.split('-');
    const df = `${dia}/${mes}/${ano}`;

    const listaJogos = selecionados.map((j, i) =>
      `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`
    ).join('\n');

    const prompt = `Você é um analista de apostas esportivas especializado. Analise os seguintes jogos CONFIRMADOS e VALIDADOS pela API do Sofascore para ${df} e gere 1 aposta por jogo para a Estrela Bet.

JOGOS VALIDADOS PELA API SOFASCORE:
${listaJogos}

REGRAS:
- Todos os jogos da Série A e Série B têm análise OBRIGATÓRIA
- Para cada jogo analise: últimos 10 jogos de cada time (gols, escanteios, vitórias, fase atual, posição na tabela, cartões) e confronto direto do último ano
- Defina 1 aposta por jogo com o mercado mais indicado pelos dados: Over/Under gols, escanteios, cartões ou resultado

Retorne SOMENTE JSON válido sem texto antes ou depois:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"Time","time_fora":"Time","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"3-4 linhas explicando os dados que embasam a aposta."}]}

tipo_liga: a=Série A, b=Série B, it=Serie A italiana, es=La Liga, eu=outras europeias, copa=copas.
mercado: gols/escanteios/cartoes/resultado.
confianca: alta/media/baixa.`;

    const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const iaJson = await iaRes.json();
    if (iaJson.error) return res.status(500).json({ error: iaJson.error.message });

    const txt = (iaJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = txt.indexOf('{');
    const e = txt.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'Resposta inválida da IA.' });

    const parsed = JSON.parse(txt.slice(s, e + 1));
    console.log(`Apostas geradas: ${parsed.jogos?.length}`);
    res.json(parsed);

  } catch (err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
