'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');

const { getAccessToken } = require('./auth/oauth');
const { download: downloadBDS } = require('./extractors/bds');
const { download: downloadADS } = require('./extractors/ads');
const { load, listarTabelas } = require('./loader/mysql-loader');
const { run: runTransforms, lerArgsSomente } = require('./transforms/engine');
const { notificarViews } = require('./exporter/powerbi');
const {
  ARQUIVO_ALERTA,
  MENSAGEM_REAUTENTICAR,
  ehErroDeAutenticacao,
  registrarFalhaAuth,
  limparFalhaAuth,
} = require('./utils/falha-auth');
const { gerarInventario } = require('./utils/inventario');
const { lerArgsPeriodo } = require('./utils/datas');
const { arquivarCsvsAnteriores, tabelasNaoAtualizadas, PASTA_ANTERIOR } = require('./utils/pasta-csvs');
const { lerAgendamentos, descreverEtapas } = require('./utils/agendamentos');

const LOGS_DIR = process.env.LOGS_DIR || './logs';
const CSVS_DIR = process.env.CSVS_DIR || './csvs';

function timestamp() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function dataHoje() {
  return new Date().toISOString().slice(0, 10);
}

function criarLogger() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, `pipeline-${dataHoje()}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });

  const log = (nivel, msg) => {
    const linha = `[${timestamp()}] [${nivel.padEnd(5)}] ${msg}`;
    console.log(linha);
    stream.write(linha + '\n');
  };

  const fechar = () => stream.end();
  return { log, fechar, logFile };
}

async function executarPipeline(opcoes = {}) {
  const { log, fechar, logFile } = criarLogger();
  const inicio = Date.now();

  const config = JSON.parse(fs.readFileSync('config/schedule.json', 'utf8'));
  const pipe = config.pipeline || {};

  const flags = {
    bds: opcoes.bds ?? pipe.baixar_bds ?? true,
    ads: opcoes.ads ?? pipe.baixar_ads ?? true,
    load: opcoes.load ?? pipe.carregar_mysql ?? true,
    transform: opcoes.transform ?? pipe.executar_transformacoes ?? true,
    exportarCsvs: opcoes.exportarCsvs ?? pipe.exportar_csvs ?? true,
  };
  // BDS completo (padrão) ou diferencial (--diferencial / agendamento com "bds": "diferencial")
  const tipoBDS = opcoes.bdsTipo || 'completo';

  console.log('\n🚀 Iniciando pipeline Brightspace ETL —', new Date().toLocaleString('pt-BR'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('INFO', `Pipeline iniciado. Log: ${logFile}`);
  if (opcoes.agendamento) log('INFO', `Agendamento: ${opcoes.agendamento}`);

  const resumo = { bds: null, ads: null, load: null, transform: null, erros: 0, falhaAuth: false };

  try {
    // Validar autenticação
    console.log('\n📡 Autenticação: validando token...');
    try {
      await getAccessToken();
    } catch (e) {
      if (!ehErroDeAutenticacao(e)) throw e; // erro de rede etc. → tratado como falha crítica genérica

      // Refresh token inválido/expirado: só volta a funcionar após "npm run setup".
      // Registra alerta e encerra sem tentar as etapas seguintes.
      resumo.falhaAuth = true;
      resumo.erros++;
      console.error('\n' + '█'.repeat(70));
      console.error(`  ${MENSAGEM_REAUTENTICAR}`);
      console.error('█'.repeat(70) + '\n');
      log('ERRO', MENSAGEM_REAUTENTICAR);
      log('ERRO', `Detalhe: ${e.message}`);
      try {
        registrarFalhaAuth(LOGS_DIR, e);
        log('ERRO', `Alerta gravado em ${path.join(LOGS_DIR, ARQUIVO_ALERTA)}`);
      } catch (erroAlerta) {
        log('ERRO', `Não foi possível gravar o alerta de autenticação: ${erroAlerta.message}`);
      }
      log('INFO', 'Pipeline encerrado: etapas seguintes não executadas.');
      fechar();
      return resumo;
    }
    console.log('   ✅ Token válido\n');
    log('INFO', 'Autenticação OK');
    limparFalhaAuth(LOGS_DIR);

    // Pipeline completo: a execução anterior vai para csvs/_anterior/ para não ser recarregada.
    // Execuções parciais (--apenas-*) e downloads sob demanda pela CLI não mexem na pasta.
    if (opcoes.completo && (flags.bds || flags.ads)) {
      const movidos = arquivarCsvsAnteriores(CSVS_DIR);
      console.log(`🗂️  ${movidos.length} item(ns) da execução anterior movido(s) para ${CSVS_DIR}/${PASTA_ANTERIOR}/\n`);
      log('INFO', `csvs/: ${movidos.length} item(ns) movido(s) para ${PASTA_ANTERIOR}/`);
    }

    // BDS
    if (flags.bds) {
      log('INFO', `Iniciando download BDS ${tipoBDS}`);
      resumo.bds = await downloadBDS({ tipo: tipoBDS, log });
      const difs = tipoBDS === 'diferencial' ? ` (${resumo.bds.arquivos || 0} diferencial(is))` : '';
      log('INFO', `BDS ${tipoBDS}: ${resumo.bds.baixados} baixados${difs}, ${resumo.bds.erros} erros`);
      for (const f of resumo.bds.falhas || []) {
        log('ERRO', `DOWNLOAD FALHOU — BDS ${tipoBDS} "${f.nome}" não baixado após ${f.tentativas} tentativa(s): ${f.mensagem}`);
      }
      resumo.erros += resumo.bds.erros;
    }

    // ADS
    if (flags.ads) {
      log('INFO', 'Iniciando download ADS');
      resumo.ads = await downloadADS({ periodo: opcoes.periodoADS, log });
      log('INFO', `ADS: ${resumo.ads.processados} processados, ${resumo.ads.erros} erros`);
      for (const f of resumo.ads.falhas || []) {
        log('ERRO', `DOWNLOAD FALHOU — ADS "${f.nome}" não baixado após ${f.tentativas} tentativa(s): ${f.mensagem}`);
      }
      resumo.erros += resumo.ads.erros;
    }

    // Carga MySQL
    if (flags.load) {
      log('INFO', 'Iniciando carga MySQL');
      resumo.load = await load();
      log('INFO', `MySQL: ${resumo.load.carregados} tabelas, ${resumo.load.totalLinhas} linhas`);
      const dif = resumo.load.diferencial;
      if (dif && (dif.aplicados || dif.pulados || dif.erros)) {
        log('INFO', `Diferencial: ${dif.aplicados} aplicado(s) em ${dif.tabelas.join(', ') || '—'}, ${dif.pulados} pulado(s), ${dif.erros} erro(s)`);
      }
      resumo.erros += resumo.load.erros;

      // Tabelas do banco cujo CSV não veio nesta execução (dados possivelmente defasados)
      try {
        resumo.naoAtualizadas = tabelasNaoAtualizadas(await listarTabelas(), resumo.load.tabelas);
        if (resumo.naoAtualizadas.length > 0) {
          log('AVISO', `Tabelas NÃO atualizadas nesta execução (CSV não baixado): ${resumo.naoAtualizadas.join(', ')}`);
        }
      } catch (e) {
        log('AVISO', `Não foi possível listar as tabelas do MySQL: ${e.message}`);
      }
    }

    // Transformações
    if (flags.transform) {
      log('INFO', 'Iniciando transformações');
      resumo.transform = await runTransforms({ exportarCsvs: flags.exportarCsvs });
      log('INFO', `Transformações: ${resumo.transform.executadas} executadas, ${resumo.transform.puladas} puladas`);
      resumo.erros += resumo.transform.erros;
      await notificarViews(resumo.transform.views);
    }

    // Inventário dos CSVs desta execução (só no pipeline completo) → exports/_inventario_csvs.md
    if (opcoes.completo) {
      try {
        resumo.inventario = await gerarInventario();
        log('INFO', `Inventário: ${resumo.inventario.total} CSV(s) → ${resumo.inventario.arquivo}`);
        resumo.erros += resumo.inventario.erros;
      } catch (e) {
        log('ERRO', `Inventário falhou: ${e.message}`);
        resumo.erros++;
      }
    }

  } catch (e) {
    log('ERRO', `Falha crítica: ${e.message}`);
    console.error('\n❌ Falha crítica:', e.message);
    resumo.erros++;
  }

  const duracaoMs = Date.now() - inicio;
  const min = Math.floor(duracaoMs / 60000);
  const seg = Math.floor((duracaoMs % 60000) / 1000);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Pipeline concluído em ${min}m ${seg}s`);
  if (resumo.bds) {
    const difs = resumo.bds.tipo === 'diferencial' ? ` (${resumo.bds.arquivos || 0} diferencial(is))` : '';
    console.log(`   📦 BDS ${resumo.bds.tipo || 'completo'}: ${resumo.bds.baixados} datasets${difs}`);
  }
  if (resumo.ads) console.log(`   📊 ADS: ${resumo.ads.processados} relatórios`);
  if (resumo.load) console.log(`   🗄️  MySQL: ${resumo.load.carregados} tabelas — ${(resumo.load.totalLinhas || 0).toLocaleString('pt-BR')} linhas`);
  if (resumo.load?.diferencial?.aplicados) {
    console.log(`   🔁 Diferencial: ${resumo.load.diferencial.aplicados} aplicado(s) → ${resumo.load.diferencial.tabelas.join(', ')}`);
  }
  if (resumo.transform) {
    const puladas = resumo.transform.puladas ? ` | ⏭️  ${resumo.transform.puladas} puladas (exportar_csvs = false)` : '';
    console.log(`   🔧 Transformações: ${resumo.transform.executadas} executadas${puladas}`);
    if (resumo.transform.views?.length) console.log(`   📊 Views atualizadas (PowerBI): ${resumo.transform.views.join(', ')}`);
  }
  if (resumo.inventario) console.log(`   📒 Inventário: ${resumo.inventario.arquivo}`);
  if (resumo.naoAtualizadas?.length > 0) {
    console.log(`   ⚠️  ${resumo.naoAtualizadas.length} tabela(s) NÃO atualizada(s) nesta execução: ${resumo.naoAtualizadas.join(', ')}`);
  }
  // Downloads que falharam mesmo após a nova tentativa: resumo no console E no arquivo de log
  const naoBaixados = [
    ...(resumo.bds?.falhas || []).map((f) => `BDS "${f.nome}"`),
    ...(resumo.ads?.falhas || []).map((f) => `ADS "${f.nome}"`),
  ];
  if (naoBaixados.length > 0) {
    console.log(`   ❌ ${naoBaixados.length} download(s) com falha após as tentativas: ${naoBaixados.join(', ')}`);
  }
  if (resumo.erros > 0) console.log(`   ⚠️  ${resumo.erros} erro(s) — ver ${logFile}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (naoBaixados.length > 0) {
    log('ERRO', `RESUMO — ${naoBaixados.length} download(s) NÃO concluído(s) (dados desatualizados): ${naoBaixados.join(', ')}`);
  }
  log('INFO', `Pipeline concluído em ${min}m ${seg}s. Erros: ${resumo.erros}`);
  fechar();

  return resumo;
}

// Agendamentos de config/schedule.json → "agendamentos" (ver src/utils/agendamentos.js).
// As execuções entram numa fila: se uma ainda estiver rodando (ex.: ADS das 6h às 9h de segunda),
// a próxima espera ela terminar em vez de rodar junto e disputar csvs/ e o MySQL.
function iniciarAgendamento() {
  const config = JSON.parse(fs.readFileSync('config/schedule.json', 'utf8'));
  let lidos;
  try {
    lidos = lerAgendamentos(config);
  } catch (e) {
    console.error(`❌ config/schedule.json: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const { fuso, agendamentos } = lidos;
  const ativos = agendamentos.filter((ag) => ag.ativo);
  if (ativos.length === 0) {
    console.log('ℹ️  Nenhum agendamento ativo em config/schedule.json');
    return;
  }

  for (const ag of ativos) {
    if (!cron.validate(ag.cron)) {
      console.error(`❌ Agendamento "${ag.nome}": cron inválido "${ag.cron}"`);
      process.exitCode = 1;
      return;
    }
  }

  const pipe = config.pipeline || {};
  let fila = Promise.resolve();
  let emExecucao = null;

  console.log(`\n⏰ ${ativos.length} agendamento(s) ativo(s) — fuso: ${fuso}`);
  for (const ag of ativos) {
    console.log(`   • ${ag.nome.padEnd(24)} ${ag.cron.padEnd(16)} → ${descreverEtapas(ag)}${ag.descricao ? ` — ${ag.descricao}` : ''}`);

    cron.schedule(ag.cron, () => {
      console.log(`\n⏰ Agendamento "${ag.nome}" disparado: ${new Date().toLocaleString('pt-BR')}`);
      if (emExecucao) console.log(`   ⏳ Aguardando "${emExecucao}" terminar...`);
      fila = fila.then(async () => {
        emExecucao = ag.nome;
        try {
          await executarPipeline({
            completo: true,
            agendamento: ag.nome,
            // As flags de config/schedule.json → pipeline continuam valendo como chave geral
            bds: Boolean(ag.bds) && (pipe.baixar_bds ?? true),
            bdsTipo: ag.bds || 'completo',
            ads: ag.ads && (pipe.baixar_ads ?? true),
          });
        } catch (e) {
          console.error(`❌ Erro no agendamento "${ag.nome}":`, e.message);
        } finally {
          emExecucao = null;
        }
      });
    }, { timezone: fuso });
  }
  console.log('\n   Pressione Ctrl+C para encerrar.\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);

  let somente = null;
  let periodoADS = null;
  try {
    somente = lerArgsSomente(args);
    // --inicio/--fim: sobrescrevem startDate/endDate de todos os ADS só nesta execução
    periodoADS = lerArgsPeriodo(args);
    if (periodoADS && args.includes('--watch')) {
      throw new Error('--inicio/--fim não valem com --watch (o agendamento usa config/ads-filters.json)');
    }
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  if (args.includes('--watch')) {
    iniciarAgendamento();
  } else if (somente) {
    // npm run transform -- --so <nome>: roda só as transformações pedidas, direto no MySQL.
    // Não autentica no Brightspace, não baixa nem carrega nada — para o analista testar a sua query.
    runTransforms({ somente })
      .then(async (r) => {
        await notificarViews(r.views);
        if (r.erros > 0) process.exitCode = 1;
      })
      .catch((e) => { console.error('❌', e.message); process.exit(1); });
  } else {
    const opcoes = {
      bds: args.includes('--apenas-bds') || !args.some((a) => a.startsWith('--apenas')),
      ads: args.includes('--apenas-ads') || !args.some((a) => a.startsWith('--apenas')),
      load: args.includes('--apenas-load') || !args.some((a) => a.startsWith('--apenas')),
      transform: args.includes('--apenas-transform') || !args.some((a) => a.startsWith('--apenas')),
    };

    if (args.includes('--apenas-bds')) { opcoes.ads = false; opcoes.load = false; opcoes.transform = false; }
    if (args.includes('--apenas-ads')) { opcoes.bds = false; opcoes.load = false; opcoes.transform = false; }
    if (args.includes('--apenas-load')) { opcoes.bds = false; opcoes.ads = false; opcoes.transform = false; }
    if (args.includes('--apenas-transform')) { opcoes.bds = false; opcoes.ads = false; opcoes.load = false; }

    // Sem --apenas-* = pipeline completo (arquiva csvs/ antes de baixar e roda o inventário no fim)
    opcoes.completo = !args.some((a) => a.startsWith('--apenas'));
    opcoes.periodoADS = periodoADS;
    // --diferencial: baixa o BDS diferencial do dia em vez do completo
    opcoes.bdsTipo = args.includes('--diferencial') ? 'diferencial' : 'completo';
    if (periodoADS && !opcoes.ads) {
      console.log('⚠️  --inicio/--fim ignorados: esta execução não baixa ADS');
    }

    executarPipeline(opcoes)
      .then((resumo) => { if (resumo.falhaAuth) process.exitCode = 1; })
      .catch((e) => { console.error('❌', e.message); process.exit(1); });
  }
}

module.exports = { executarPipeline };
