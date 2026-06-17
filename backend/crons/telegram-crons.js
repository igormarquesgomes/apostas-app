/**
 * Crons do Telegram — agendados em UTC para bater no horário BRT
 *
 *   09h UTC = 06h BRT → editar mensagem anterior com ✅/❌
 *   11h UTC = 08h BRT → enviar lista de hoje
 *
 * Usa o mesmo padrão setTimeout/setInterval do server.js principal.
 */

const telegramService = require('../services/telegramService');

function msAteProxima(horaUTC, minUTC = 0) {
  const agora = new Date();
  const prox = new Date(Date.UTC(
    agora.getUTCFullYear(),
    agora.getUTCMonth(),
    agora.getUTCDate(),
    horaUTC,
    minUTC,
    0
  ));
  if (prox <= agora) prox.setUTCDate(prox.getUTCDate() + 1);
  return prox.getTime() - agora.getTime();
}

function agendarCronTelegram() {
  // ── 09h UTC (06h BRT) — editar mensagem anterior ──────────────────────
  const msEditar = msAteProxima(9, 0);
  console.log(`⏰ [Telegram] Próxima edição de mensagem em ${Math.round(msEditar / 60000)} min`);
  setTimeout(function tick() {
    telegramService.editarMensagemAnterior()
      .then(() => console.log('✅ [Telegram 06h] editarMensagemAnterior concluído'))
      .catch(err => console.error('❌ [Telegram 06h] editarMensagemAnterior:', err.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msEditar);

  // ── 11h UTC (08h BRT) — enviar lista de hoje ──────────────────────────
  const msEnviar = msAteProxima(11, 0);
  console.log(`⏰ [Telegram] Próximo envio de lista em ${Math.round(msEnviar / 60000)} min`);
  setTimeout(function tick() {
    telegramService.enviarListaDeHoje()
      .then(() => console.log('✅ [Telegram 08h] enviarListaDeHoje concluído'))
      .catch(err => console.error('❌ [Telegram 08h] enviarListaDeHoje:', err.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msEnviar);
}

module.exports = { agendarCronTelegram };
