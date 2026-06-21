/**
 * Crons Telegram — mesmo padrão setTimeout/setInterval do server.js
 *
 * Horários BRT → UTC:
 *   06h BRT = 09h UTC — editar lista anterior + reply análises
 *   08h BRT = 11h UTC — enviar lista de hoje
 *   12h-23h BRT = 15h-02h UTC — enviar análises individuais (a cada minuto)
 */

const telegramService = require('../services/telegramService');

function msAteProxima(horaUTC, minUTC = 0) {
  const agora = new Date();
  const prox = new Date(Date.UTC(
    agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(),
    horaUTC, minUTC, 0
  ));
  if (prox <= agora) prox.setUTCDate(prox.getUTCDate() + 1);
  return prox.getTime() - agora.getTime();
}

// Hora atual em BRT (número 0-23)
function horaBRT() {
  return parseInt(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
}

function agendarCronTelegram() {
  // ── 09h UTC (06h BRT) — editar lista + reply análises ─────────────────
  const ms06h = msAteProxima(9, 0);
  console.log(`⏰ [Telegram] Edição/reply em ${Math.round(ms06h / 60000)} min`);
  setTimeout(function tick06h() {
    Promise.all([
      telegramService.editarMensagemListaAnterior(),
      telegramService.responderValidacoesAnalises(),
    ]).catch(err => console.error('❌ [Telegram 06h]:', err.message));
    setTimeout(tick06h, 24 * 60 * 60 * 1000);
  }, ms06h);

  // ── 11h UTC (08h BRT) — enviar lista de hoje ──────────────────────────
  const ms08h = msAteProxima(11, 0);
  console.log(`⏰ [Telegram] Envio lista em ${Math.round(ms08h / 60000)} min`);
  setTimeout(function tick08h() {
    telegramService.enviarListaDeDia()
      .catch(err => console.error('❌ [Telegram 08h]:', err.message));
    setTimeout(tick08h, 24 * 60 * 60 * 1000);
  }, ms08h);

  // ── A cada minuto (ativo 12h-23h BRT) — análises individuais ──────────
  console.log(`⏰ [Telegram] Poll análises a cada minuto`);
  setInterval(() => {
    const hora = horaBRT();
    if (hora < 12 || hora > 23) return; // só ativa na janela 12h-23h BRT
    telegramService.enviarMensagensAnalisesAgendasPremium()
      .catch(err => console.error('❌ [Telegram Análises]:', err.message));
  }, 60 * 1000);
}

module.exports = { agendarCronTelegram };
