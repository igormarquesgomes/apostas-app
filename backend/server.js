const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/analisar', async (req, res) => {
  const { data, hora, meta } = req.body;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Chave da API não configurada no servidor.' });
  }

  const prompt = `Você é um analista de apostas esportivas especializado. Para a data ${data}, busque jogos nas ligas prioritárias: Brasileirão Série A e B, Premier League (atenção: jogos da Premier League geralmente são às 12h horário de Brasília — verifique o horário antes de incluir), Bundesliga, Ligue 1, La Liga, Liga Portugal, Serie A italiana, Libertadores, Sul-Americana, Europa League, Champions League.

REGRAS OBRIGATÓRIAS:
1. Filtre APENAS jogos confirmados a partir das ${hora} (horário de Brasília). Não inclua jogos com horário inferior.
2. Todos os jogos da Série A e Série B do Brasileirão que estiverem no filtro de horário DEVEM obrigatoriamente ter uma aposta.
3. Se não atingir ${meta} jogos pelas ligas prioritárias, complemente com times conhecidos de outras ligas.
4. Valide os horários cruzando múltiplas fontes antes de incluir qualquer jogo.

Para cada jogo, analise os últimos 10 jogos de cada time e o confronto direto do último ano: gols marcados/sofridos, escanteios, vitórias/empates/derrotas, fase atual, posição na tabela e cartões. Defina 1 aposta por jogo com o mercado definido pelos dados.

Retorne SOMENTE JSON válido sem nenhum texto antes ou depois:
{
  "data": "${data}",
  "jogos": [
    {
      "id": 1,
      "liga": "Série A",
      "tipo_liga": "a",
      "time_casa": "Time A",
      "time_fora": "Time B",
      "horario": "16:00",
      "aposta": "Over 2.5 gols",
      "mercado": "gols",
      "odd_sugerida": "1.85",
      "confianca": "alta",
      "media_gols_casa": "1.8",
      "media_gols_fora": "1.2",
      "media_escanteios": "9.4",
      "media_cartoes": "3.1",
      "forma_casa": "V V E D V",
      "forma_fora": "D E V V D",
      "justificativa": "Explicação detalhada de 3-4 linhas com os dados que embasam a aposta."
    }
  ]
}

tipo_liga: "a" para Série A, "b" para Série B, "eu" para ligas europeias, "it" para Serie A italiana, "es" para La Liga, "copa" para copas continentais.
mercado: "gols", "escanteios", "cartoes" ou "resultado".
confianca: "alta", "media" ou "baixa".
Gere exatamente ${meta} jogos se possível.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data2 = await response.json();

    if (data2.error) {
      return res.status(500).json({ error: data2.error.message });
    }

    const textos = (data2.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const start = textos.indexOf('{');
    const end = textos.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'Resposta inválida da IA.' });
    }

    const parsed = JSON.parse(textos.slice(start, end + 1));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
