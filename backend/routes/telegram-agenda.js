/**
 * Rotas Telegram
 *
 * OddLab Lista (tabela: agendos_telegram)
 *   POST /api/telegram/lista/salvar
 *   POST /api/telegram/lista/agendar
 *   GET  /api/telegram/lista/:data
 *
 * OddLab Análises (tabela: agendos_telegram_analises)
 *   POST /api/telegram/analises/agendar
 *   POST /api/telegram/analises/editar
 *   GET  /api/telegram/analises/:data
 */

const express = require('express');
const router  = express.Router();

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;
const DEFAULT_CHAT_LISTA  = process.env.TELEGRAM_CHAT_ID_LISTA   || process.env.TELEGRAM_CHAT_ID   || null;
const DEFAULT_CHAT_ANALISES = process.env.TELEGRAM_CHAT_ID_ANALISES || process.env.TELEGRAM_CHAT_ID || null;

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

// ══════════════════════════════════════════════════════════════════════════
// OddLab Lista
// ══════════════════════════════════════════════════════════════════════════

// POST /api/telegram/lista/salvar
router.post('/lista/salvar', async (req, res) => {
  try {
    const { data, jogos } = req.body;
    if (!data || !Array.isArray(jogos)) return res.status(400).json({ error: 'data e jogos obrigatórios' });

    const existing = await supaFetch(`agendos_telegram?data_envio=eq.${data}&select=id,status`);
    const agendo = existing?.[0];

    if (agendo?.status === 'agendado') {
      return res.status(409).json({ error: 'Já agendado — edição bloqueada pela UI', agendo_id: agendo.id });
    }

    if (agendo?.id) {
      await supaFetch(`agendos_telegram?id=eq.${agendo.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ jogos, status: 'salvo', updated_at: new Date().toISOString() }),
      });
      return res.json({ success: true, agendo_id: agendo.id, action: 'updated' });
    }

    const inserted = await supaFetch('agendos_telegram', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ data_envio: data, jogos, status: 'salvo', chat_id: DEFAULT_CHAT_LISTA ? Number(DEFAULT_CHAT_LISTA) : null }),
    });
    return res.json({ success: true, agendo_id: inserted?.[0]?.id, action: 'created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/lista/agendar
router.post('/lista/agendar', async (req, res) => {
  try {
    const { agendo_id } = req.body;
    if (!agendo_id) return res.status(400).json({ error: 'agendo_id obrigatório' });

    const rows = await supaFetch(`agendos_telegram?id=eq.${agendo_id}&select=id,status,data_envio,enviado_em`);
    const agendo = rows?.[0];
    if (!agendo) return res.status(404).json({ error: 'Agendo não encontrado' });
    if (agendo.status === 'agendado') return res.json({ success: true, warning: 'Já estava agendado' });

    await supaFetch(`agendos_telegram?id=eq.${agendo_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'agendado', updated_at: new Date().toISOString() }),
    });

    // Se for hoje e já passou das 8h BRT (11h UTC), envia imediatamente
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .split('/').reverse().join('-');
    const horaBRT = parseInt(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);

    if (agendo.data_envio === hoje && horaBRT >= 8 && !agendo.enviado_em) {
      console.log(`⚡ [Lista] Agendado após 8h — enviando imediatamente`);
      const svc = require('../services/telegramService');
      svc.enviarListaDeDia().catch(err => console.error('Erro envio imediato Lista:', err.message));
      return res.json({ success: true, agendo_id, enviando_agora: true, warning: 'Já passou das 8h — enviando agora!' });
    }

    res.json({ success: true, agendo_id, warning: 'Agendado! Será enviado às 8h.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/telegram/lista/:data
router.get('/lista/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const [agendoRows, diasRows] = await Promise.all([
      supaFetch(`agendos_telegram?data_envio=eq.${data}&select=*`),
      supaFetch(`apostas_dia?data=eq.${data}&select=apostas`),
    ]);
    const agendo = agendoRows?.[0] || null;
    const apostas = (diasRows?.[0]?.apostas?.jogos || []).filter(j => !j.descartado && j.odd_mercado);
    res.json({ data, apostas, agendo_id: agendo?.id || null, status: agendo?.status || null, jogos: agendo?.jogos || [], enviado_em: agendo?.enviado_em || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// OddLab Análises
// ══════════════════════════════════════════════════════════════════════════

// POST /api/telegram/analises/agendar
// Body: { data, jogos: [{jogo_id, time_casa, time_fora, aposta, odd, horario, link_afiliado, horario_envio}] }
router.post('/analises/agendar', async (req, res) => {
  try {
    const { data, jogos } = req.body;
    if (!data || !Array.isArray(jogos)) return res.status(400).json({ error: 'data e jogos obrigatórios' });

    // Apaga registros existentes para esta data antes de reinserir
    await supaFetch(`agendos_telegram_analises?data_envio=eq.${data}&status=eq.pendente`, { method: 'DELETE' });

    const rows = jogos.map(j => ({
      data_envio: data,
      jogo_id: j.jogo_id,
      jogo: {
        jogo_id:       j.jogo_id,
        time_casa:     j.time_casa,
        time_fora:     j.time_fora,
        aposta:        j.aposta,
        odd:           j.odd,
        horario:       j.horario,
        link_afiliado: j.link_afiliado || '',
      },
      horario_envio: j.horario_envio,
      status: 'pendente',
      chat_id: DEFAULT_CHAT_ANALISES ? Number(DEFAULT_CHAT_ANALISES) : null,
    }));

    const inserted = await supaFetch('agendos_telegram_analises', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });

    // Se for hoje e já passou das 12h BRT, dispara envio imediato dos que já venceram
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .split('/').reverse().join('-');
    const horaBRT = parseInt(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);

    if (data === hoje && horaBRT >= 12) {
      console.log(`⚡ [Análises] Agendado após 12h — disparando envio imediato dos pendentes`);
      const svc = require('../services/telegramService');
      svc.enviarMensagensAnalisesAgendasPremium().catch(err => console.error('Erro envio imediato Análises:', err.message));
      return res.json({ success: true, agendo_ids: (inserted || []).map(r => r.id), enviando_agora: true });
    }

    res.json({ success: true, agendo_ids: (inserted || []).map(r => r.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/analises/editar
// Body: { agendo_id, horario_envio }
router.post('/analises/editar', async (req, res) => {
  try {
    const { agendo_id, horario_envio } = req.body;
    if (!agendo_id || !horario_envio) return res.status(400).json({ error: 'agendo_id e horario_envio obrigatórios' });

    const rows = await supaFetch(`agendos_telegram_analises?id=eq.${agendo_id}&select=id,status`);
    if (!rows?.[0]) return res.status(404).json({ error: 'Agendo não encontrado' });
    if (rows[0].status === 'enviado') return res.status(409).json({ error: 'Já enviado — não pode editar' });

    await supaFetch(`agendos_telegram_analises?id=eq.${agendo_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ horario_envio, updated_at: new Date().toISOString() }),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/telegram/analises/:data
router.get('/analises/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const [analisesRows, diasRows] = await Promise.all([
      supaFetch(`agendos_telegram_analises?data_envio=eq.${data}&select=*&order=horario_envio.asc`),
      supaFetch(`apostas_dia?data=eq.${data}&select=apostas`),
    ]);
    const apostas = (diasRows?.[0]?.apostas?.jogos || []).filter(j => !j.descartado && j.odd_mercado);
    res.json({ data, apostas, analises: analisesRows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
