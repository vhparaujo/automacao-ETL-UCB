'use strict';

// Altera startDate/endDate dos relatórios em config/ads-filters.json pela linha de comando —
// para não precisar abrir o JSON no servidor. Grava no arquivo (vale para o cron também).
//
//   npm run ads:periodo                                   → mostra o período atual de cada ADS
//   npm run ads:periodo -- --inicio 2026-08-01            → startDate de TODOS os ADS
//   npm run ads:periodo -- --inicio inicio_semestre --fim agora
//   npm run ads:periodo -- --inicio -30d --so "Uso do Aluno,Notas finais"   → só esses
//
// Valores: os mesmos de startDate/endDate (agora, hoje, -Nd, inicio_semestre, YYYY-MM-DD, ISO…).
// Só altera relatórios que já têm a chave (não cria startDate num ADS que não usa esse filtro).
// Não precisa de autenticação.

const fs = require('node:fs');
const path = require('node:path');
const { lerArgsPeriodo, resolverPeriodo } = require('./datas');
const { mesmoNome, sugerirNomes } = require('./nomes');

const ARQUIVO = path.join('config', 'ads-filters.json');
const LINHA = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// Lê --so "Nome A,Nome B" (ou --so=…). Retorna null se ausente.
function lerArgsRelatorios(args) {
  for (let i = 0; i < args.length; i++) {
    let valor;
    if (args[i] === '--so') valor = args[i + 1];
    else if (args[i].startsWith('--so=')) valor = args[i].slice(5);
    else continue;
    if (!valor || valor.startsWith('--')) throw new Error('--so precisa do nome do relatório (ex.: --so "Uso do Aluno")');
    return valor.split(',').map((n) => n.trim()).filter(Boolean);
  }
  return null;
}

// Função pura: devolve { config: novoConfig, alterados: [{ nome, chave, de, para }] }.
// nomes = null → todos os relatórios. Nome inexistente → erro com sugestões.
function atualizarPeriodos(config, periodo, nomes = null) {
  const relatorios = Object.keys(config).filter((k) => !k.startsWith('_'));
  if (nomes) {
    const faltando = nomes.filter((n) => !relatorios.some((r) => mesmoNome(r, n)));
    if (faltando.length) {
      const sugestoes = faltando.flatMap((n) => sugerirNomes(n, relatorios));
      throw new Error(`Relatório(s) não encontrado(s) em ${ARQUIVO}: ${faltando.join(', ')}. ` +
        `Configurados: ${relatorios.join(', ')}${sugestoes.length ? ` (você quis dizer: ${[...new Set(sugestoes)].join(', ')}?)` : ''}`);
    }
  }

  const novo = JSON.parse(JSON.stringify(config));
  const alterados = [];
  for (const nome of relatorios) {
    if (nomes && !nomes.some((n) => mesmoNome(nome, n))) continue;
    for (const chave of ['startDate', 'endDate']) {
      if (periodo[chave] === undefined || novo[nome][chave] === undefined) continue;
      if (novo[nome][chave] === periodo[chave]) continue;
      alterados.push({ nome, chave, de: novo[nome][chave], para: periodo[chave] });
      novo[nome][chave] = periodo[chave];
    }
    // Garante que o par resultante (ex.: novo início + fim antigo) não fica invertido
    try { resolverPeriodo(novo[nome], new Date()); }
    catch (e) { throw new Error(`"${nome}": ${e.message} — nada foi gravado`); }
  }
  return { config: novo, alterados };
}

function mostrarPeriodos(config) {
  for (const [nome, c] of Object.entries(config)) {
    if (nome.startsWith('_')) continue;
    if (c.startDate === undefined && c.endDate === undefined) {
      console.log(`  • ${nome}: (sem filtro de data)`);
      continue;
    }
    let efetivo = '';
    try {
      const p = resolverPeriodo(c, new Date());
      efetivo = `  →  hoje resolve para ${p.startDate ?? '—'} → ${p.endDate ?? '—'}`;
    } catch (e) { efetivo = `  ⚠️  ${e.message}`; }
    const status = c.ativo === false ? ' [inativo]' : c.automatico ? '' : ' [sob demanda]';
    console.log(`  • ${nome}${status}: ${c.startDate ?? '—'} → ${c.endDate ?? '—'}${efetivo}`);
  }
}

function main(args) {
  const config = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  const periodo = lerArgsPeriodo(args);
  const nomes = lerArgsRelatorios(args);

  if (!periodo) {
    console.log(`\n🗓️  Período dos ADS em ${ARQUIVO}\n${LINHA}`);
    mostrarPeriodos(config);
    console.log(`\nPara alterar: npm run ads:periodo -- --inicio 2026-08-01 [--fim agora] [--so "Nome do ADS"]`);
    return;
  }

  const { config: novo, alterados } = atualizarPeriodos(config, periodo, nomes);
  if (alterados.length === 0) {
    console.log('ℹ️  Nada a alterar: os relatórios já estão com esses valores (ou não têm filtro de data).');
    return;
  }

  // Grava de forma atômica (arquivo temporário + rename): um erro no meio não corrompe o JSON
  const tmp = `${ARQUIVO}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n');
  fs.renameSync(tmp, ARQUIVO);

  console.log(`\n✅ ${ARQUIVO} atualizado (${alterados.length} alteração(ões))\n${LINHA}`);
  for (const a of alterados) console.log(`  • ${a.nome} — ${a.chave}: ${a.de} → ${a.para}`);
  console.log(`\n${LINHA}`);
  mostrarPeriodos(novo);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('❌', e.message); process.exit(1); }
}

module.exports = { atualizarPeriodos, lerArgsRelatorios };
