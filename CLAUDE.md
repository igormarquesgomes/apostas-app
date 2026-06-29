# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OddLab** is an AI-powered sports betting analysis platform (Portuguese-language). It generates daily football/soccer betting recommendations using multi-stage AI analysis, self-calibration, and real-time odds integration.

## Running the Project

```bash
node server.js
```

No build step. No package.json — dependencies are managed externally. The server runs on `PORT` (default 3000) and self-schedules all daily routines via `node-cron`.

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API (Haiku 4.5 + Sonnet 4.5) |
| `APIFOOTBALL_KEY` | API-Football v3 (1000 req/day limit) |
| `SUPABASE_URL` | Supabase REST endpoint |
| `SUPABASE_KEY` | Supabase anon key |
| `ODDS_API_KEY` | The Odds API (25 req/month hard limit) |

## Architecture

The entire backend lives in `server.js` (~179KB). Frontend is static HTML files served by Express.

### Daily Automation Pipeline (Scheduled via cron, Brazil/São_Paulo timezone)

```
03:00 → agentValidar()      — validate yesterday's bets, run calibration reports
03:30 → gerarApostas()      — generate today + tomorrow bets
04:00 → integrity check     — fill any gaps in data
04:30 → gerarMultiplas()    — create parlay suggestions
```

### Bet Generation Flow (`gerarApostas`)

1. `buscarFixturesPorData()` — fetch matches from API-Football, filter by `LIGAS_PRIORITY` map
2. Two-stage Claude analysis to manage costs:
   - **Lote 1** (first 8 matches): Claude Sonnet 4.5 with `web_search` tool
   - **Lote 2** (remaining): Claude Haiku 4.5 without web search
3. Per-match: fetch form (last 5), H2H, corners, cards stats → AI picks market + line
4. `buscarOddsDia()` — enrich with real bookmaker odds (cached, rate-limited)
5. Store to `apostas_dia` in Supabase

### Self-Calibration System

After validation, AI generates reports at 4 timescales stored in `calibracao` table:
- **Daily**: what worked/failed, next-day action items
- **Weekly**: patterns by league/market
- **Monthly**: strategy trends
- **Semestral**: 6-month strategic review (max 2/year)

The calibration report from the previous day is injected into today's AI prompts as "memory."

### Smart Pivoting

If a recommended odd drops below market minimums, the system auto-swaps to the `apostas_backup` field before display. This logic is in `buscarOddsDia()`.

## Database Schema (Supabase)

| Table | Key Columns |
|---|---|
| `apostas_dia` | `data`, `apostas` (JSON), `resultados` (JSON), `multiplas`, `resultados_multiplas` |
| `ligas_conhecidas` | `liga_id`, `nome`, `pais`, `green`, `red`, `mercados` (JSONB), `media_escanteios`, `media_cartoes` |
| `calibracao` | `tipo` (diario/semanal/mensal/semestral), `periodo_inicio`, `periodo_fim`, `relatorio`, `assertividade` |
| `oddlab_usuarios` | `device_id`, `nome`, `acessos`, `primeiro_acesso`, `ultimo_acesso` |

## API Endpoints

**Analysis (manual triggers):**
- `POST /analisar` — generate bets for a date
- `POST /validar/:data` — validate results for a date
- `POST /validar-agora` — real-time partial validation
- `GET /apostas-resultado/:data` — fetch bets + results
- `GET /multiplas/:data` — fetch parlays
- `GET /calibracao` — fetch latest calibration reports

**Admin/Automation:**
- `POST /rotina-04h`, `/rotina-04h30`, `/rotina-05h` — manual cron triggers
- `POST /validar-pendentes` — 03:00 validation routine
- `POST /sincronizar-ligas` — bulk-sync 60-day league history

**Public App:**
- `POST /oddlab/registrar` — user registration
- `GET /oddlab/usuario/:device_id` — user access
- `GET /health` — server health + daily Anthropic spend

## Frontend Pages

All static HTML, no framework:
- `index.html` — main betting dashboard
- `dashboard.html` — performance analytics
- `relatorios.html` — calibration reports viewer
- `ligas.html` — league stats
- `publico.html` — public sign-up / landing
- `oddlab-sw.js` / `oddlab-manifest.json` — PWA service worker + manifest

## Cost Management

- Daily Anthropic spend alert threshold: **$0.50** (checked in `/health`)
- Token usage tracked per-request; logged to console
- Odds API: 25 req/month — odds are **cached per day** in `apostas_dia`, never re-fetched intraday
- API-Football: 1000 req/day — fixture fetches are batched, not per-match

## Key Implementation Notes

- All dates handled in **America/São_Paulo (UTC-3)**; use `new Date().toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'})` pattern
- League priority is defined in the `LIGAS_PRIORITY` constant map (liga_id → priority number; lower = higher priority)
- `assertividade` (accuracy %) is the primary metric tracked across all calibration reports
- Result validation uses API-Football first; falls back to Claude + `web_search` for pending/missing results
- Parlays target two bands: Múltipla A (3.50–4.50 combined odds) and Múltipla B (2.50–3.49)
