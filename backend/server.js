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

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS() });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

async function buscarCategorias() {
  try {
    const json = await fetchJSON('https://sofascore.p.rapidapi.com/categories/list?sport=football');
    return (json.categories || []).map(c => c.id).filter(Boolean);
  } catch(e) {
    console.error('Erro categorias:', e.message);
    return [32, 35, 9, 1, 8, 4, 38, 108, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  }
}

async function buscarJogosCat(catId, data) {
  try {
    const json = await fetchJSON(
      `https://sofascore.p.rapidapi.com/tournaments/get-scheduled-events?categoryId=${catId}&date=${data}`
    );
    return json.events || [];
  } catch(e) {
    return [];
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/analisar', async (req, res) => {
  const { data, hora, meta } = req.body;

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'RAPIDAPI_KEY não configurada.' });
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const horaMin = hora || '13:00';
  const metaJogos = parseInt(meta) || 15;
  const [hM, mM] = horaMin.split(':').map(Number);
  const minMinutos = hM * 60 + mM;

  // Limites do dia em Brasília convertidos para UTC
  // Brasília = UTC-3, então início do dia Brasília = data 03:00 UTC
  const inicioDiaBrasilia = new Date(data + 'T03:00:00Z').getTime() / 1000;
  const fimDiaBrasilia = inicioDiaBrasilia + 86400;

  try {
    console.log(`\n=== Buscando jogos para ${data} (Brasília) ===`);
    console.log(`Janela UTC: ${new Date(inicioDiaBrasilia*1000).toISOString()} até ${new Date(fimDiaBrasilia*1000).toISOString()}`);

    const categorias = await buscarCategorias();
    console.log(`${categorias.length} categorias encontradas`);

    const jogosEncontrados = new Map();

    const lotes = [];
    for (let i = 0; i < categorias.length; i += 10) {
      lotes.push(categorias.slice(i, i + 10));
    }

    for (const lote of lotes) {
      const resultados = await Promise.all(lote.map(catId => buscarJogosCat(catId, data)));

      for (const eventos of resultados) {
        for (const ev of eventos) {
          const ligaId = ev.tournament?.uniqueTournament?.id;
          const liga = LIGAS[ligaId];
          if (!liga) continue;

          const ts = ev.startTimestamp;
          if (!ts) continue;

          // Verificar se está dentro do dia de Brasília
          if (ts < inicioDiaBrasilia || ts >= fimDiaBrasilia) continue;

          // Converter para horário Brasília (UTC-3)
          const dt = new Date(ts * 1000);
          const hBR = dt.getUTCHours() - 3;
          const mBR = dt.getUTCMinutes();
          const totalMin = hBR * 60 + mBR;
          if (totalMin < minMinutos) continue;

          const hStr = `${String(hBR).padStart(2,'0')}:${String(mBR).padStart(2,'0')}`;
          const key = `${ev.homeTeam?.name}-${ev.awayTeam?.name}`;

          if (!jogosEncontrados.has(key)) {
            jogosEncontrados.set(key, {
              liga: liga.nome,
              tipo: liga.tipo,
              pri: liga.pri,
              timeCasa: ev.homeTeam?.name,
              timeFora: ev.awayTeam?.name,
              horario: hStr
            });
          }
        }
      }
    }

    const jogos = Array.from(jogosEncontrados.values())
      .sort((a, b) => a.pri - b.pri || a.horario.localeCompare(b.horario))
      .slice(0, metaJogos);

    console.log(`\nJogos selecionados: ${jogos.length}`);
    jogos.forEach(j => console.log(`  ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`));

    if (!jogos.length) {
      return res.json({ jogos: [], aviso: 'Nenhum jogo encontrado nas ligas prioritárias.' });
    }

    const [ano, mes, dia] = data.split('-');
    const df = `${dia}/${mes}/${ano}`;
    const listaJogos = jogos.map((j, i) =>
      `${i+1}. ${j.liga} | ${j.timeCasa} x ${j.timeFora} | ${j.horario}`
    ).join('\n');

    console.log('\nEnviando para IA...');

    const prompt = `Você é um analista de apostas esportivas especializado. Analise os jogos CONFIRMADOS pela API Sofascore para ${df} e gere 1 aposta por jogo para a Estrela Bet.

JOGOS VALIDADOS:
${listaJogos}

REGRAS:
- Série A e Série B: análise OBRIGATÓRIA para todos
- Analise: últimos 10 jogos de cada time (gols, escanteios, vitórias, fase, tabela, cartões) + confronto direto último ano
- 1 aposta por jogo, mercado definido pelos dados: Over/Under gols, escanteios, cartões ou resultado

Retorne SOMENTE JSON válido:
{"jogos":[{"id":1,"liga":"Série A","tipo_liga":"a","time_casa":"Time A","time_fora":"Time B","horario":"16:00","aposta":"Over 2.5 gols","mercado":"gols","odd_sugerida":"1.85","confianca":"alta","media_gols_casa":"1.8","media_gols_fora":"1.2","media_escanteios":"9.4","media_cartoes":"3.1","forma_casa":"V V E D V","forma_fora":"D E V V D","justificativa":"3-4 linhas com dados que embasam a aposta."}]}

tipo_liga: a/b/it/es/eu/copa. mercado: gols/escanteios/cartoes/resultado. confianca: alta/media/baixa.`;

    // Tentar modelos em sequência até um funcionar
    const modelos = [
      'claude-3-5-sonnet-20241022',
      'claude-3-haiku-20240307',
      'claude-3-sonnet-20240229',
      'claude-3-opus-20240229'
    ];

    let iaJson = null;
    let modeloUsado = null;

    for (const modelo of modelos) {
      try {
        const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: modelo,
            max_tokens: 4000,
            messages: [{ role: 'user', content: prompt }]
          })
        });
        const json = await iaRes.json();
        if (!json.error) {
          iaJson = json;
          modeloUsado = modelo;
          console.log(`Modelo usado: ${modelo}`);
          break;
        }
        console.log(`Modelo ${modelo} falhou: ${json.error.message}`);
      } catch(e) {
        console.log(`Modelo ${modelo} erro: ${e.message}`);
      }
    }

    if (!iaJson) return res.status(500).json({ error: 'Nenhum modelo de IA disponível.' });

    const txt = (iaJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'Resposta inválida da IA.' });

    const parsed = JSON.parse(txt.slice(s, e + 1));
    console.log(`Apostas geradas: ${parsed.jogos?.length} com modelo ${modeloUsado}`);
    res.json(parsed);

  } catch (err) {
    console.error('Erro geral:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
