/**
 * Telegram Service — envio e edição de mensagens no canal
 *
 * Crons que usam este serviço:
 *   09h UTC (06h BRT) — editarMensagemAnterior: adiciona ✅/❌ na lista de ontem
 *   11h UTC (08h BRT) — enviarListaDeHoje: envia apostas agendadas para hoje
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ── helpers ────────────────────────────────────────────────────────────────

function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function ontem() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function fmtData(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}`;
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

function formatarRelatorio(data, jogos) {
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

// ── busca resultados do apostas_dia para enriquecer os jogos agendados ─────

async function enriquecerComResultados(data, jogos) {
  const rows = await supaFetch(
    `apostas_dia?data=eq.${data}&select=resultados`
  );
  const resultados = rows?.[0]?.resultados?.jogos || [];

  return jogos.map(j => {
    const res = resultados.find(
      r => r.time_casa === j.time_casa && r.time_fora === j.time_fora
    );
    return { ...j, resultado: res?.resultado || null };
  });
}

// ── funções públicas ────────────────────────────────────────────────────────

/**
 * 06h BRT — edita a mensagem de ontem com os resultados ✅/❌
 */
async function editarMensagemAnterior() {
  if (!TELEGRAM_BOT_TOKEN) { console.log('⚠️ TELEGRAM_BOT_TOKEN ausente — skip editarMensagemAnterior'); return; }

  const dataOntem = ontem();
  const rows = await supaFetch(
    `agendos_telegram?data_envio=eq.${dataOntem}&status=eq.agendado&select=*`
  );
  const agendo = rows?.[0];

  if (!agendo?.message_id) {
    console.log(`📭 Nenhum agendo com message_id para ${dataOntem}`);
    return;
  }

  const jogosComRes = await enriquecerComResultados(dataOntem, agendo.jogos);
  const texto = formatarRelatorio(dataOntem, jogosComRes);
  const chatId = agendo.chat_id || TELEGRAM_CHAT_ID;

  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: agendo.message_id,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  console.log(`✅ Mensagem editada para ${dataOntem}`);
}

/**
 * 08h BRT — envia a lista de hoje para o canal
 */
async function enviarListaDeHoje() {
  if (!TELEGRAM_BOT_TOKEN) { console.log('⚠️ TELEGRAM_BOT_TOKEN ausente — skip enviarListaDeHoje'); return; }

  const dataHoje = hoje();
  const rows = await supaFetch(
    `agendos_telegram?data_envio=eq.${dataHoje}&status=eq.agendado&select=*`
  );
  const agendo = rows?.[0];

  if (!agendo) {
    console.log(`📭 Nenhum agendo para ${dataHoje}`);
    return;
  }

  if (agendo.enviado_em) {
    console.log(`⚠️ Lista de ${dataHoje} já foi enviada às ${agendo.enviado_em}`);
    return;
  }

  const texto = formatarListaDia(dataHoje, agendo.jogos);
  const chatId = agendo.chat_id || TELEGRAM_CHAT_ID;

  const msg = await tgCall('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  // Persiste message_id para edição posterior
  await supaFetch(
    `agendos_telegram?id=eq.${agendo.id}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        message_id: msg.message_id,
        enviado_em: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    }
  );

  console.log(`✅ Lista enviada para ${dataHoje} — message_id: ${msg.message_id}`);
}

module.exports = { editarMensagemAnterior, enviarListaDeHoje };
