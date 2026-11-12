'use strict';

require('dotenv').config();
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolverData, EXPRESSOES_VALIDAS } = require('./utils/datas');
const { lerFalhaAuth } = require('./utils/falha-auth');
const { lerAgendamentos, descreverEtapas, AGENDAMENTOS_PADRAO } = require('./utils/agendamentos');

const LOGS_DIR = process.env.LOGS_DIR || './logs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const perguntar = (texto) => new Promise((r) => rl.question(texto, r));
const limparTela = () => process.stdout.write('\x1Bc');

function cabecalho() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Brightspace ETL — UCB  v1.0            ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

async function menuPrincipal() {
  limparTela();
  cabecalho();
  console.log('  [1] Configurar autenticação OAuth');
  console.log('  [2] Gerenciar datasets automáticos (BDS/ADS)');
  console.log('  [3] Configurar agendamento');
  console.log('  [4] Gerenciar transformações SQL');
  console.log('  [5] Rodar pipeline agora');
  console.log('  [6] Download sob demanda');
  console.log('  [7] Ver último log');
  console.log('  [0] Sair\n');
  return perguntar('  Opção: ');
}

// ──────────────────────────────────────────────────────
// [1] Autenticação
// ──────────────────────────────────────────────────────
async function configurarAuth() {
  limparTela();
  console.log('🔐 Configurando autenticação OAuth 2.0\n');

  if (!fs.existsSync('.env')) {
    console.log('⚠️  Arquivo .env não encontrado.');
    console.log('   Copie .env.example para .env e preencha as credenciais.\n');
    await perguntar('Pressione Enter para voltar...');
    return;
  }

  console.log('⚠️  IMPORTANTE: antes de continuar, verifique se o app OAuth no Brightspace');
  console.log('   tem os seguintes scopes registrados:');
  console.log('   • datahub:dataExports:download');
  console.log('   • datahub:dataExports:read');
  console.log('   • datasets:bds:read');
  console.log('   • core:*:*\n');
  console.log('   Admin → Manage Extensibility → OAuth 2.0 → editar o app\n');

  const confirma = await perguntar('Continuar com o setup? (s/N): ');
  if (confirma.toLowerCase() !== 's') return;

  console.log('\nO navegador vai abrir. Aceite o aviso de certificado autoassinado.\n');
  const proc = spawn('node', ['src/auth/oauth.js', '--setup'], { stdio: 'inherit' });
  await new Promise((r) => proc.on('close', r));
  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [2] Gerenciar automáticos
// ──────────────────────────────────────────────────────
async function gerenciarAutomaticos() {
  limparTela();
  console.log('⚙️  Gerenciar datasets automáticos\n');
  console.log('  [1] BDS — editar lista de downloads automáticos');
  console.log('  [2] ADS — ativar/desativar relatórios automáticos');
  console.log('  [3] Adicionar novo relatório ADS');
  console.log('  [V] Voltar\n');

  const op = (await perguntar('  Opção: ')).trim().toUpperCase();

  if (op === '1') await editarBDSAutomaticos();
  else if (op === '2') await toggleADS();
  else if (op === '3') await adicionarADS();
}

async function editarBDSAutomaticos() {
  limparTela();
  console.log('📦 BDS — Downloads automáticos\n');
  const config = JSON.parse(fs.readFileSync('config/bds-selecao.json', 'utf8'));

  console.log(`  Modo atual: ${config.todos ? '✅ TODOS os BDS' : '📋 Lista personalizada'}`);
  if (!config.todos) {
    console.log(`  Automáticos (${config.automaticos.length}): ${config.automaticos.join(', ')}\n`);
  }

  console.log('  [1] Alternar entre "todos" e "lista personalizada"');
  console.log('  [2] Adicionar dataset à lista automática');
  console.log('  [3] Remover dataset da lista automática');
  console.log('  [V] Voltar\n');

  const op = (await perguntar('  Opção: ')).trim().toUpperCase();

  if (op === '1') {
    config.todos = !config.todos;
    fs.writeFileSync('config/bds-selecao.json', JSON.stringify(config, null, 2));
    console.log(`✅ Modo alterado para: ${config.todos ? 'TODOS os BDS' : 'lista personalizada'}`);
  } else if (op === '2') {
    const nome = await perguntar('Nome exato do dataset (ex: Users): ');
    if (nome.trim() && !config.automaticos.includes(nome.trim())) {
      config.automaticos.push(nome.trim());
      fs.writeFileSync('config/bds-selecao.json', JSON.stringify(config, null, 2));
      console.log(`✅ "${nome.trim()}" adicionado.`);
    }
  } else if (op === '3') {
    config.automaticos.forEach((n, i) => console.log(`  [${i + 1}] ${n}`));
    const idx = parseInt(await perguntar('\nNúmero para remover: '), 10) - 1;
    if (idx >= 0 && idx < config.automaticos.length) {
      const removido = config.automaticos.splice(idx, 1)[0];
      fs.writeFileSync('config/bds-selecao.json', JSON.stringify(config, null, 2));
      console.log(`✅ "${removido}" removido.`);
    }
  }

  await perguntar('\nPressione Enter para voltar...');
}

async function toggleADS() {
  limparTela();
  console.log('📊 ADS — Relatórios automáticos\n');
  const config = JSON.parse(fs.readFileSync('config/ads-filters.json', 'utf8'));
  const relatorios = Object.entries(config).filter(([k]) => !k.startsWith('_'));

  relatorios.forEach(([nome, v], i) => {
    const auto = v.automatico === true ? '🔄 automático' : '🖱️  sob demanda';
    const ativo = v.ativo === false ? ' (desativado)' : '';
    console.log(`  [${i + 1}] ${nome} — ${auto}${ativo}`);
  });

  console.log('\n  Digite o número para alternar automático/sob demanda, ou V para voltar.\n');
  const op = (await perguntar('  Opção: ')).trim().toUpperCase();

  if (op !== 'V') {
    const idx = parseInt(op, 10) - 1;
    if (idx >= 0 && idx < relatorios.length) {
      const [nome] = relatorios[idx];
      config[nome].automatico = !config[nome].automatico;
      fs.writeFileSync('config/ads-filters.json', JSON.stringify(config, null, 2));
      console.log(`✅ "${nome}" agora é ${config[nome].automatico ? '🔄 automático' : '🖱️  sob demanda'}.`);
    }
  }

  await perguntar('\nPressione Enter para voltar...');
}

// Explica os formatos aceitos nos campos de data dos filtros ADS
function explicarFormatosData() {
  console.log('\n  📅 Datas aceitam:');
  console.log('     • YYYY-MM-DD           → data fixa (ex.: 2026-01-01)');
  console.log('     • agora                → data e horário exatos da execução (UTC)');
  console.log('     • hoje                 → dia da execução (início 00:00 / fim 23:59:59.999 UTC)');
  console.log('     • -Nd                  → N dias atrás (ex.: -180d)');
  console.log('     • inicio_ano, fim_ano  → ano corrente');
  console.log('     • inicio_semestre, fim_semestre → semestre corrente (1 = jan–jun, 2 = jul–dez)');
  console.log('     Expressões relativas são recalculadas a cada execução do pipeline.\n');
}

// Pergunta uma data e retorna o valor a salvar no ads-filters.json.
// YYYY-MM-DD vira ISO UTC (comportamento anterior); expressões relativas são salvas como texto.
async function perguntarData(rotulo, campo, padrao) {
  while (true) {
    const entrada = (await perguntar(`${rotulo} [${padrao}]: `)).trim() || padrao;
    const valor = /^\d{4}-\d{2}-\d{2}$/.test(entrada)
      ? `${entrada}${campo === 'inicio' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
      : entrada;
    try {
      const resolvida = resolverData(valor, campo, new Date());
      if (resolvida !== valor) console.log(`     → agora equivale a ${resolvida}`);
      return valor;
    } catch {
      console.log(`  ❌ Valor inválido. Use: YYYY-MM-DD, ${EXPRESSOES_VALIDAS}`);
    }
  }
}

async function adicionarADS() {
  limparTela();
  console.log('➕ Adicionar relatório ADS\n');
  const config = JSON.parse(fs.readFileSync('config/ads-filters.json', 'utf8'));

  const nome = await perguntar('Nome do relatório (como aparece no Brightspace): ');
  if (!nome.trim()) return;

  const orgUnitId = (await perguntar(`OrgUnitId [6606]: `)).trim() || '6606';
  explicarFormatosData();
  const startDate = await perguntarData('Data início', 'inicio', '2025-01-01');
  const endDate = await perguntarData('Data fim', 'fim', 'agora');
  const rolesStr = await perguntar('IDs das roles (vírgula, ex: 109,110) ou Enter para pular: ');
  const roles = rolesStr.trim() ? rolesStr.split(',').map((r) => r.trim()) : [];
  const autoStr = await perguntar('Baixar automaticamente no pipeline? (s/N): ');

  config[nome.trim()] = {
    automatico: autoStr.toLowerCase() === 's',
    ativo: true,
    parentOrgUnitId: orgUnitId,
    startDate,
    endDate,
    ...(roles.length > 0 ? { roles } : {}),
  };

  fs.writeFileSync('config/ads-filters.json', JSON.stringify(config, null, 2));
  console.log(`\n✅ Relatório "${nome.trim()}" adicionado.`);
  await perguntar('Pressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [3] Agendamento
// ──────────────────────────────────────────────────────
async function configurarAgendamento() {
  limparTela();
  console.log('⏰ Configurar agendamentos (npm start)\n');
  const config = JSON.parse(fs.readFileSync('config/schedule.json', 'utf8'));

  let lidos;
  try {
    lidos = lerAgendamentos(config);
  } catch (e) {
    console.log(`❌ config/schedule.json: ${e.message}`);
    await perguntar('\nPressione Enter para voltar...');
    return;
  }
  // Formato antigo (um único "agendamento") é convertido para a lista ao salvar
  const salvar = (lista) => {
    delete config.agendamento;
    config.fuso_horario = lidos.fuso;
    config.agendamentos = lista;
    fs.writeFileSync('config/schedule.json', JSON.stringify(config, null, 2) + '\n');
  };
  const lista = lidos.agendamentos;

  console.log(`  Fuso: ${lidos.fuso}\n`);
  if (lista.length === 0) console.log('  (nenhum agendamento)\n');
  lista.forEach((ag, i) => {
    console.log(`  ${i + 1}. ${ag.ativo ? '✅' : '⏸️ '} ${ag.nome.padEnd(24)} ${ag.cron.padEnd(16)} → ${descreverEtapas(ag)}`);
    if (ag.descricao) console.log(`        ${ag.descricao}`);
  });

  console.log('\n  [A] Ativar/desativar um agendamento');
  console.log('  [C] Alterar o cron de um agendamento');
  console.log('  [P] Restaurar o padrão (todo dia 6h BDS diferencial + ADS; seg 9h BDS completo)');
  console.log('  [V] Voltar\n');

  const op = (await perguntar('  Opção: ')).trim().toUpperCase();
  const escolher = async () => {
    const n = parseInt((await perguntar('  Número do agendamento: ')).trim(), 10);
    if (!(n >= 1 && n <= lista.length)) { console.log('❌ Número inválido.'); return null; }
    return lista[n - 1];
  };

  if (op === 'A') {
    const ag = await escolher();
    if (ag) {
      ag.ativo = !ag.ativo;
      salvar(lista);
      console.log(`✅ "${ag.nome}" ${ag.ativo ? 'ativado' : 'desativado'}.`);
    }
  } else if (op === 'C') {
    const ag = await escolher();
    if (ag) {
      const novo = (await perguntar(`  Cron (atual: ${ag.cron}): `)).trim();
      if (!require('node-cron').validate(novo)) {
        console.log('❌ Cron inválido — nada alterado. Ex.: "0 6 * * *" (minuto hora dia mês dia-da-semana)');
      } else {
        ag.cron = novo;
        const desc = (await perguntar('  Descrição (Enter = manter): ')).trim();
        if (desc) ag.descricao = desc;
        salvar(lista);
        console.log('✅ Agendamento atualizado.');
      }
    }
  } else if (op === 'P') {
    salvar(AGENDAMENTOS_PADRAO.map((ag) => ({ ...ag })));
    console.log('✅ Agendamentos padrão restaurados.');
  }
  if (['A', 'C', 'P'].includes(op)) console.log('   Reinicie o "npm start" para valer.');

  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [4] Transformações
// ──────────────────────────────────────────────────────
async function gerenciarTransformacoes() {
  limparTela();
  console.log('🔧 Gerenciar transformações SQL\n');
  const config = JSON.parse(fs.readFileSync('config/transforms.json', 'utf8'));
  const lista = config.transformacoes || [];

  if (lista.length === 0) {
    console.log('Nenhuma transformação configurada.');
    console.log('Crie .sql em src/transforms/queries/ e adicione em config/transforms.json.\n');
    await perguntar('Pressione Enter para voltar...');
    return;
  }

  lista.forEach((t, i) => {
    const status = t.ativo === false ? '⏸️ ' : '✅';
    console.log(`  [${i + 1}] ${status} ${t.nome} (${t.tipo})`);
  });

  console.log('\n  [T] Ativar/desativar | [V] Voltar\n');
  const op = (await perguntar('  Opção: ')).trim().toUpperCase();

  if (op === 'T') {
    const idx = parseInt(await perguntar('Número: '), 10) - 1;
    if (idx >= 0 && idx < lista.length) {
      lista[idx].ativo = lista[idx].ativo === false;
      fs.writeFileSync('config/transforms.json', JSON.stringify(config, null, 2));
      console.log(`✅ "${lista[idx].nome}" ${lista[idx].ativo ? 'ativado' : 'desativado'}.`);
    }
  }

  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [5] Rodar pipeline
// ──────────────────────────────────────────────────────
async function rodarPipeline() {
  limparTela();
  console.log('🚀 Rodar pipeline\n');
  console.log('  [1] Pipeline completo (apenas automáticos)');
  console.log('  [2] Apenas BDS automáticos');
  console.log('  [3] Apenas ADS automáticos');
  console.log('  [4] Apenas carga MySQL');
  console.log('  [5] Apenas transformações SQL');
  console.log('  [6] Pipeline completo com BDS DIFERENCIAL (só o do dia)');
  console.log('  [7] Apenas BDS diferencial');
  console.log('  [V] Voltar\n');

  const op = (await perguntar('  Opção: ')).trim();
  const flags = {
    '1': [], '2': ['--apenas-bds'], '3': ['--apenas-ads'], '4': ['--apenas-load'], '5': ['--apenas-transform'],
    '6': ['--diferencial'], '7': ['--apenas-bds', '--diferencial'],
  };
  if (!flags[op]) return;

  // Pipeline completo ou só ADS: permite trocar a data de início de todos os ADS nesta execução
  const args = [...flags[op]];
  if (op === '1' || op === '3' || op === '6') {
    const inicio = (await perguntar('  Data de início dos ADS (ex.: 2026-08-01, -30d, inicio_semestre — Enter = usar o config): ')).trim();
    if (inicio) args.push('--inicio', inicio);
  }

  console.log('\n' + '─'.repeat(42) + '\n');
  const proc = spawn('node', ['src/pipeline.js', ...args], { stdio: 'inherit' });
  await new Promise((r) => proc.on('close', r));
  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [6] Download sob demanda
// ──────────────────────────────────────────────────────
async function downloadSobDemanda() {
  limparTela();
  console.log('🖱️  Download sob demanda\n');
  console.log('  [1] Baixar BDS específico(s)');
  console.log('  [2] Baixar todos os BDS disponíveis');
  console.log('  [3] Baixar relatório ADS específico');
  console.log('  [V] Voltar\n');

  const op = (await perguntar('  Opção: ')).trim().toUpperCase();

  if (op === '1') await demandaBDSEspecificos();
  else if (op === '2') await demandaBDSTodos();
  else if (op === '3') await demandaADSEspecifico();
}

async function demandaBDSEspecificos() {
  limparTela();
  console.log('📦 BDS — Selecionar datasets para baixar agora\n');
  console.log('⏳ Carregando lista da API...\n');

  let datasets;
  try {
    const { listar } = require('./extractors/bds');
    datasets = await listar();
  } catch (e) {
    console.log(`❌ Erro ao listar: ${e.message}`);
    await perguntar('\nPressione Enter para voltar...');
    return;
  }

  if (datasets.length === 0) {
    console.log('Nenhum dataset disponível.');
    await perguntar('Pressione Enter para voltar...');
    return;
  }

  datasets.forEach((ds, i) => {
    const status = ds.temExtract ? '✅' : '⚠️ ';
    console.log(`  [${String(i + 1).padStart(3)}] ${status} ${ds.nome}`);
  });

  console.log('\n  Digite os números separados por vírgula (ex: 1,5,12)');
  console.log('  ou "todos" para baixar todos listados acima.\n');
  const entrada = (await perguntar('  Seleção: ')).trim();

  let nomesSelecionados;
  if (entrada.toLowerCase() === 'todos') {
    nomesSelecionados = datasets.map((d) => d.nome);
  } else {
    const indices = entrada.split(',').map((n) => parseInt(n.trim(), 10) - 1);
    nomesSelecionados = indices
      .filter((i) => i >= 0 && i < datasets.length)
      .map((i) => datasets[i].nome);
  }

  if (nomesSelecionados.length === 0) {
    console.log('Nenhum dataset selecionado.');
    await perguntar('Pressione Enter para voltar...');
    return;
  }

  console.log(`\n⬇️  Baixando: ${nomesSelecionados.join(', ')}\n`);
  const { download } = require('./extractors/bds');
  await download({ modo: 'selecao', nomes: nomesSelecionados });
  await perguntar('\nPressione Enter para voltar...');
}

async function demandaBDSTodos() {
  limparTela();
  console.log('📦 BDS — Baixar TODOS os datasets\n');
  console.log('⚠️  Isso pode demorar muito e usar bastante espaço em disco.');
  const confirma = await perguntar('Confirmar download de todos os BDS? (s/N): ');
  if (confirma.toLowerCase() !== 's') return;

  const { download } = require('./extractors/bds');
  await download({ modo: 'todos' });
  await perguntar('\nPressione Enter para voltar...');
}

async function demandaADSEspecifico() {
  limparTela();
  console.log('📊 ADS — Selecionar relatório para baixar agora\n');
  console.log('⏳ Carregando lista da API...\n');

  let disponiveis;
  try {
    const { listar } = require('./extractors/ads');
    disponiveis = await listar();
  } catch (e) {
    console.log(`❌ Erro ao listar: ${e.message}`);
    await perguntar('\nPressione Enter para voltar...');
    return;
  }

  const config = JSON.parse(fs.readFileSync('config/ads-filters.json', 'utf8'));
  const configurados = Object.keys(config).filter((k) => !k.startsWith('_'));

  console.log('Relatórios disponíveis na API:\n');
  disponiveis.forEach((r, i) => {
    const temConfig = configurados.includes(r.nome) ? '⚙️  configurado' : '🆕 sem config';
    console.log(`  [${i + 1}] ${r.nome} — ${temConfig}`);
  });

  console.log('');
  const idx = parseInt((await perguntar('  Número do relatório: ')).trim(), 10) - 1;
  if (idx < 0 || idx >= disponiveis.length) return;

  const nomeEscolhido = disponiveis[idx].nome;
  let configRelatorio = config[nomeEscolhido];

  if (!configRelatorio) {
    console.log(`\n"${nomeEscolhido}" não tem configuração salva. Preencha os filtros:\n`);
    const orgUnitId = (await perguntar('OrgUnitId [6606]: ')).trim() || '6606';
    explicarFormatosData();
    const startDate = await perguntarData('Data início', 'inicio', '2025-01-01');
    const endDate = await perguntarData('Data fim', 'fim', 'agora');
    const rolesStr = await perguntar('IDs das roles (vírgula) ou Enter para pular: ');
    const roles = rolesStr.trim() ? rolesStr.split(',').map((r) => r.trim()) : [];

    configRelatorio = {
      parentOrgUnitId: orgUnitId,
      startDate,
      endDate,
      ...(roles.length > 0 ? { roles } : {}),
    };

    const salvar = await perguntar('Salvar esta configuração para uso futuro? (s/N): ');
    if (salvar.toLowerCase() === 's') {
      config[nomeEscolhido] = { automatico: false, ativo: true, ...configRelatorio };
      fs.writeFileSync('config/ads-filters.json', JSON.stringify(config, null, 2));
      console.log('✅ Configuração salva.');
    }
  }

  console.log(`\n⬇️  Baixando "${nomeEscolhido}"...\n`);
  const { download } = require('./extractors/ads');
  await download({ modo: 'selecao', nomes: [nomeEscolhido] });
  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// [7] Ver log
// ──────────────────────────────────────────────────────
async function verUltimoLog() {
  limparTela();

  // Alerta de falha de autenticação no último pipeline (gravado por src/pipeline.js)
  const falhaAuth = lerFalhaAuth(LOGS_DIR);
  if (falhaAuth) {
    console.log('█'.repeat(60));
    console.log('  🔐 ATENÇÃO: a última execução falhou na autenticação!');
    console.log('     Rode "npm run setup" (ou [1] no menu) para reautenticar.\n');
    console.log(falhaAuth.trim().split('\n').map((l) => `     ${l}`).join('\n'));
    console.log('█'.repeat(60) + '\n');
  }

  if (!fs.existsSync(LOGS_DIR) || fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')).length === 0) {
    console.log('Nenhum log encontrado ainda.\n');
    await perguntar('Pressione Enter para voltar...');
    return;
  }

  const ultimo = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse()[0];

  const conteudo = fs.readFileSync(path.join(LOGS_DIR, ultimo), 'utf8');
  console.log(`📋 ${ultimo}\n${'─'.repeat(60)}`);
  console.log(conteudo.split('\n').slice(-50).join('\n'));
  console.log('─'.repeat(60));
  await perguntar('\nPressione Enter para voltar...');
}

// ──────────────────────────────────────────────────────
// Loop principal
// ──────────────────────────────────────────────────────
async function main() {
  while (true) {
    const op = (await menuPrincipal()).trim();
    switch (op) {
      case '1': await configurarAuth(); break;
      case '2': await gerenciarAutomaticos(); break;
      case '3': await configurarAgendamento(); break;
      case '4': await gerenciarTransformacoes(); break;
      case '5': await rodarPipeline(); break;
      case '6': await downloadSobDemanda(); break;
      case '7': await verUltimoLog(); break;
      case '0':
        console.log('\nAté logo!\n');
        rl.close();
        process.exit(0);
      default:
        console.log('\nOpção inválida.\n');
    }
  }
}

main().catch((e) => { console.error('❌', e.message); rl.close(); process.exit(1); });
