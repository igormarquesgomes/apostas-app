/**
 * Rotas para agendamento de listas Telegram
 *
 * POST /api/telegram/salvar      — cria ou atualiza agendo (status=salvo)
 * POST /api/telegram/agendar     — confirma agendo (status=agendado, irreversível via UI)
 * GET  /api/telegram/lista/:data — busca agendo + apostas do dia
 */

const express = require('express');
const router  = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? Number(process.env.TELEGRAM_CHAT_ID)
  : null;

async function supaFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// POST /api/telegram/salvar
// Body: { data: 'YYYY-MM-DD', jogos: [{jogo_id, time_casa, time_fora, aposta, odd, horario, link_afiliado}] }
router.post('/salvar', async (req, res) => {
  try {
    const { data, jogos } = req.body;
    if (!data || !Array.isArray(jogos)) {
      return res.status(400).json({ error: 'data e jogos são obrigatórios' });
    }

    // Verifica se já existe um agendo para esta data
    const existing = await supaFetch(
      `agendos_telegram?data_envio=eq.${data}&select=id,status`
    );
    const agendo = existing?.[0];

    if (agendo?.status === 'agendado') {
      return res.status(409).json({
        error: 'Este agendo já está confirmado e não pode ser editado pela UI',
        agendo_id: agendo.id,
      });
    }

    if (agendo?.id) {
      // UPDATE
      await supaFetch(`agendos_telegram?id=eq.${agendo.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          jogos,
          status: 'salvo',
          updated_at: new Date().toISOString(),
        }),
      });
      return res.json({ success: true, agendo_id: agendo.id, action: 'updated' });
    }

    // INSERT
    const inserted = await supaFetch('agendos_telegram', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        data_envio: data,
        jogos,
        status: 'salvo',
        chat_id: DEFAULT_CHAT_ID,
      }),
    });
    const novoId = inserted?.[0]?.id;
    return res.json({ success: true, agendo_id: novoId, action: 'created' });

  } catch (err) {
    console.error('Erro /api/telegram/salvar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/agendar
// Body: { agendo_id: 'uuid' }
router.post('/agendar', async (req, res) => {
  try {
    const { agendo_id } = req.body;
    if (!agendo_id) return res.status(400).json({ error: 'agendo_id obrigatório' });

    const rows = await supaFetch(
      `agendos_telegram?id=eq.${agendo_id}&select=id,status,data_envio`
    );
    const agendo = rows?.[0];

    if (!agendo) return res.status(404).json({ error: 'Agendo não encontrado' });
    if (agendo.status === 'agendado') {
      return res.json({ success: true, warning: 'Já estava agendado', agendo_id });
    }

    await supaFetch(`agendos_telegram?id=eq.${agendo_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'agendado',
        updated_at: new Date().toISOString(),
      }),
    });

    res.json({
      success: true,
      agendo_id,
      warning: 'Agendado! Será enviado no horário configurado. Cancelamento apenas via banco de dados.',
    });

  } catch (err) {
    console.error('Erro /api/telegram/agendar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/telegram/lista/:data
router.get('/lista/:data', async (req, res) => {
  try {
    const { data } = req.params;

    // Busca agendo
    const agendoRows = await supaFetch(
      `agendos_telegram?data_envio=eq.${data}&select=*`
    );
    const agendo = agendoRows?.[0] || null;

    // Busca apostas do dia (para exibir jogos disponíveis)
    const diasRows = await supaFetch(
      `apostas_dia?data=eq.${data}&select=apostas`
    );
    const apostas = diasRows?.[0]?.apostas?.jogos || [];

    res.json({
      data,
      apostas,
      agendo_id: agendo?.id || null,
      status: agendo?.status || null,
      jogos: agendo?.jogos || [],
      enviado_em: agendo?.enviado_em || null,
    });

  } catch (err) {
    console.error('Erro /api/telegram/lista:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
