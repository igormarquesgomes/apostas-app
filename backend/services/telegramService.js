/**
 * Telegram Service
 *
 * Grupos:
 *   OddLab Lista    → TELEGRAM_CHAT_ID_LISTA    — lista consolidada 08h + relatório 06h
 *   OddLab Análises → TELEGRAM_CHAT_ID_ANALISES — mensagens individuais 12h-23h + reply 06h
 */

const TELEGRAM_BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID_LISTA          = process.env.TELEGRAM_CHAT_ID_LISTA   || process.env.TELEGRAM_CHAT_ID;
const CHAT_ID_ANALISES       = process.env.TELEGRAM_CHAT_ID_ANALISES || process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL           = process.env.SUPABASE_URL;
const SUPABASE_KEY           = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ── helpers ────────────────────────────────────────────────────────────────

function dataHoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function dataOntem() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function fmtData(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// Hora atual em BRT no formato HH:MM
function horaBRT() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

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

async function tgCall(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

// ── formatação ─────────────────────────────────────────────────────────────

function formatarListaDia(data, jogos) {
  const linhas = jogos
    .slice()
    .sort((a, b) => (a.horario || '').localeCompare(b.horario || ''))
    .map(j => {
      const linkParte = j.link_afiliado
        ? `\n🔗 <a href="${j.link_afiliado}">Link da Aposta</a>`
        : '';
      return [
        `🕐 <b>${j.horario || '--:--'}</b>`,
        `⚽ <b>${j.time_casa} x ${j.time_fora}</b>`,
        `📊 ${j.aposta}`,
        `📈 Odd: <b>${j.odd || '-'}</b>${linkParte}`,
      ].join('\n');
    });

  return `<b>${fmtData(data)} — ANÁLISES DO DIA</b>\n\n${linhas.join('\n\n')}`;
}

function formatarRelatorioLista(data, jogos) {
  let acertos = 0, erros = 0, pendentes = 0;

  const linhas = jogos
    .slice()
    .sort((a, b) => (a.horario || '').localeCompare(b.horario || ''))
    .map(j => {
      const icone = j.resultado === 'green' ? '✅' : j.resultado === 'red' ? '❌' : '⏳';
      if (j.resultado === 'green') acertos++;
      else if (j.resultado === 'red') erros++;
      else pendentes++;
      return `${icone} ${j.time_casa} x ${j.time_fora} — ${j.aposta} @ ${j.odd || '-'}`;
    });

  const total = acertos + erros;
  const taxa = total > 0 ? ((acertos / total) * 100).toFixed(1) : '—';

  return [
    `<b>${fmtData(data)} — RELATÓRIO FINAL</b>`,
    '',
    linhas.join('\n'),
    '',
    '──────────────────────',
    `✅ Acertos: ${acertos}`,
    `❌ Erros: ${erros}`,
    `⏳ Pendentes: ${pendentes}`,
    `📊 Taxa: ${taxa}%`,
  ].join('\n');
}

function formatarMensagemAnalise(jogo) {
  const linkParte = jogo.link_afiliado
    ? `<a href="${jogo.link_afiliado}">🔗 Link da Aposta Pronta ✅</a>`
    : '🔗 Link da Aposta Pronta ✅';

  return [
    '🚨 ATENÇÃO 🚨',
    '',
    '⚽ Oportunidade identificada no jogo',
    `👥 <b>${jogo.time_casa} x ${jogo.time_fora}</b>`,
    '',
    '💡 Sugestão dos nossos Analistas para esse jogo:',
    `📊 <b>${jogo.aposta}</b>`,
    '',
    '💰 Gestão de Banca: 3%',
    '',
    linkParte,
    '',
    '🎰 Jogue com Responsabilidade',
  ].join('\n');
}

// ── busca resultados do apostas_dia para enriquecer os jogos ───────────────

async function buscarResultados(data) {
  const rows = await supaFetch(`apostas_dia?data=eq.${data}&select=resultados`);
  return rows?.[0]?.resultados?.apostas || [];
}

// ══════════════════════════════════════════════════════════════════════════
// GRUPO: OddLab Lista
// ══════════════════════════════════════════════════════════════════════════

/**
 * 06h BRT — edita a mensagem de ontem com resultados ✅/❌
 */
async function editarMensagemListaAnterior() {
  if (!TELEGRAM_BOT_TOKEN) { console.log('⚠️ TELEGRAM_BOT_TOKEN ausente'); return; }

  const data = dataOntem();
  const rows = await supaFetch(`agendos_telegram?data_envio=eq.${data}&status=eq.agendado&select=*`);
  const agendo = rows?.[0];

  if (!agendo?.message_id) {
    console.log(`📭 [Lista] Sem message_id para ${data}`);
    return;
  }

  const resultados = await buscarResultados(data);
  const jogosComRes = agendo.jogos.map(j => {
    const res = resultados.find(r => r.time_casa === j.time_casa && r.time_fora === j.time_fora);
    return { ...j, resultado: res?.resultado_aposta || null };
  });

  const texto = formatarRelatorioLista(data, jogosComRes);
  await tgCall('editMessageText', {
    chat_id: agendo.chat_id || CHAT_ID_LISTA,
    message_id: agendo.message_id,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  console.log(`✅ [Lista] Mensagem editada para ${data}`);
}

/**
 * 08h BRT — envia a lista consolidada de hoje
 */
async function enviarListaDeDia() {
  if (!TELEGRAM_BOT_TOKEN) { console.log('⚠️ TELEGRAM_BOT_TOKEN ausente'); return; }

  const data = dataHoje();
  const rows = await supaFetch(`agendos_telegram?data_envio=eq.${data}&status=eq.agendado&select=*`);
  const agendo = rows?.[0];

  if (!agendo) { console.log(`📭 [Lista] Sem agendo para ${data}`); return; }
  if (agendo.enviado_em) { console.log(`⚠️ [Lista] Já enviado às ${agendo.enviado_em}`); return; }

  const texto = formatarListaDia(data, agendo.jogos);
  const chatId = agendo.chat_id || CHAT_ID_LISTA;

  const msg = await tgCall('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  await supaFetch(`agendos_telegram?id=eq.${agendo.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      message_id: msg.message_id,
      enviado_em: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  console.log(`✅ [Lista] Enviada para ${data} — message_id: ${msg.message_id}`);
}

// ══════════════════════════════════════════════════════════════════════════
// GRUPO: OddLab Análises
// ══════════════════════════════════════════════════════════════════════════

/**
 * A cada minuto (12h-23h BRT) — envia mensagens individuais cujo horario_envio já passou
 */
async function enviarMensagensAnalisesAgendasPremium() {
  if (!TELEGRAM_BOT_TOKEN) return;

  const data = dataHoje();
  const horaAgora = horaBRT(); // HH:MM

  // Busca pendentes com horario_envio <= agora
  const rows = await supaFetch(
    `agendos_telegram_analises?data_envio=eq.${data}&status=eq.pendente&horario_envio=lte.${horaAgora}&select=*&order=horario_envio.asc`
  );

  if (!rows?.length) return;

  console.log(`📤 [Análises] ${rows.length} mensagem(ns) para enviar`);

  for (const agendo of rows) {
    try {
      const texto = formatarMensagemAnalise(agendo.jogo);
      const chatId = agendo.chat_id || CHAT_ID_ANALISES;

      const msg = await tgCall('sendMessage', {
        chat_id: chatId,
        text: texto,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });

      await supaFetch(`agendos_telegram_analises?id=eq.${agendo.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'enviado',
          message_id: msg.message_id,
          enviado_em: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });

      console.log(`  ✅ [Análises] ${agendo.jogo.time_casa} x ${agendo.jogo.time_fora} — msg_id: ${msg.message_id}`);
    } catch (err) {
      console.error(`  ❌ [Análises] Erro ${agendo.jogo?.time_casa}: ${err.message}`);
    }
  }
}

/**
 * 06h BRT — responde às mensagens de ontem com ✅✅✅ ou ❌❌❌
 */
async function responderValidacoesAnalises() {
  if (!TELEGRAM_BOT_TOKEN) return;

  const data = dataOntem();
  const rows = await supaFetch(
    `agendos_telegram_analises?data_envio=eq.${data}&status=eq.enviado&select=*`
  );

  if (!rows?.length) { console.log(`📭 [Análises] Sem enviados para ${data}`); return; }

  const resultados = await buscarResultados(data);

  for (const agendo of rows) {
    if (!agendo.message_id) continue;

    const res = resultados.find(r =>
      r.time_casa === agendo.jogo.time_casa && r.time_fora === agendo.jogo.time_fora
    );
    const resultado = res?.resultado_aposta;
    if (!resultado || resultado === 'pendente') continue;

    const reply = resultado === 'green' ? '✅ ✅ ✅ ✅' : '❌ ❌ ❌';
    const chatId = agendo.chat_id || CHAT_ID_ANALISES;

    try {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: reply,
        reply_to_message_id: agendo.message_id,
      });
      console.log(`  ↩️ [Análises] Reply ${agendo.jogo.time_casa} x ${agendo.jogo.time_fora}: ${reply}`);
    } catch (err) {
      console.error(`  ❌ [Análises] Reply erro: ${err.message}`);
    }
  }
}

module.exports = {
  // Lista
  editarMensagemListaAnterior,
  enviarListaDeDia,
  // Análises
  enviarMensagensAnalisesAgendasPremium,
  responderValidacoesAnalises,
};
