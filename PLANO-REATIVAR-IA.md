# Plano — reativar a geração com IA

> **Status atual:** a geração com IA está **desligada**. A lista oficial vem 100%
> do engine (custo Anthropic zero). Este arquivo é a checagem obrigatória antes
> de religar a IA — a reativação exige **aprovação superior**.

---

## Como religar (mecânica)

1. No Render, definir a env var **`IA_ATIVA=true`**.
2. Redeploy.

Nenhuma rotina foi removida — a flag só controla o **agendamento**. Com
`IA_ATIVA` off, o agendador (`backend/server.js`, `agendarRotina`, ~linha 9051)
não programa nenhuma rotina que chame a Anthropic. Ligar a flag reprograma tudo.

Referência da flag: `backend/server.js:924` (`const IA_ATIVA`).

---

## ⚠️ Corrigir ANTES de religar: justificativa incoerente na lista da IA

### O problema

Na lista da IA, a aposta e a justificativa podem se contradizer. Caso real
observado em 08/08 (Kauno Žalgiris x Hegelmann Litauen):

```
Aposta exibida:  "Over 2.5" @1.65
Justificativa:   "As duas equipes somam 1.7 gols por jogo..."
```

Over 2.5 precisa de 3+ gols, mas o texto afirma média de 1.7. Contradição direta
na tela do cliente.

### A causa

A IA escolhe a aposta por conta própria (web search + critérios dela), mas
quando cai no **fallback de odds** o texto público é montado por
`justificativaEngine()` — `backend/server.js:659`. Essa função calcula a média a
partir de `media_gols_casa + media_gols_fora` e afirma essa média no texto.

Ou seja: **quem decide a aposta (IA) não é quem calcula a média (o helper do
engine)**. Quando os dois discordam, a justificativa contradiz a aposta.

No engine puro isso não acontece: o mesmo cálculo que escolhe o pick monta o
texto, então são sempre coerentes. Por isso o problema **só existe no caminho da
IA**.

### Correção sugerida (escolher uma)

- **Opção 1 — a IA gera a própria justificativa.** No fallback, em vez de chamar
  `justificativaEngine`, pedir à IA um texto curto coerente com a aposta que ela
  escolheu. Custa uma chamada Anthropic a mais por jogo em fallback.

- **Opção 2 — o fallback não afirma média que não usou.** Reescrever o texto do
  fallback para falar só de fatores que sustentam a aposta escolhida (forma,
  H2H, contexto), sem cravar uma média de gols que pode contradizer o pick.
  Sem custo adicional.

Recomendação: **Opção 2** — mais barata e resolve a raiz.

### Onde mexer

- `backend/server.js:659` — `jogo.justificativa = justificativaEngine({...})`
  dentro de `aplicarOddsEPivotar` (fallback de odds).
- `backend/server.js:8675` — `function justificativaEngine` (a função em si;
  serve bem ao engine, o problema é usá-la no caminho da IA).

---

## Verificação depois de religar

1. Gerar a lista da IA de um dia (`POST /analisar` ou aguardar a rotina 03h30).
2. Conferir alguns jogos: a aposta exibida bate com a justificativa? A média
   citada no texto é coerente com o mercado escolhido?
3. Acompanhar o custo em `GET /health` → `custo_hoje_usd` (alerta em $0.50).

---

## Contexto de custo

Referência do que a IA consumia antes de desligar (04/08): **$0.65/dia**, acima
do alerta de $0.50 — 35 chamadas Sonnet + 102 Haiku. As rotinas que gastam:
geração 03h30, validações (00h/03h/parciais), complemento diurno (07h/12h),
múltiplas e relatórios de calibração. Ver commit do desligamento para a lista
completa.
