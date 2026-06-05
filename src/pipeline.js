'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');

const { getAccessToken } = require('./auth/oauth');
const { download: downloadBDS } = require('./extractors/bds');
const { download: downloadADS } = require('./extractors/ads');
const { load } = require('./loader/mysql-loader');
const { run: runTransforms } = require('./transforms/engine');
const { exportarTodos } = require('./exporter/csv-exporter');
const { notificarViews } = require('./exporter/powerbi');

const LOGS_DIR = process.env.LOGS_DIR || './logs';

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
  };

  console.log('\n🚀 Iniciando pipeline Brightspace ETL —', new Date().toLocaleString('pt-BR'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('INFO', `Pipeline iniciado. Log: ${logFile}`);

  const resumo = { bds: null, ads: null, load: null, transform: null, erros: 0 };

  try {
    // Validar autenticação
    console.log('\n📡 Autenticação: validando token...');
    await getAccessToken();
    console.log('   ✅ Token válido\n');
    log('INFO', 'Autenticação OK');

    // BDS
    if (flags.bds) {
      log('INFO', 'Iniciando download BDS');
      resumo.bds = await downloadBDS();
      log('INFO', `BDS: ${resumo.bds.baixados} baixados, ${resumo.bds.erros} erros`);
      resumo.erros += resumo.bds.erros;
    }

    // ADS
    if (flags.ads) {
      log('INFO', 'Iniciando download ADS');
      resumo.ads = await downloadADS();
      log('INFO', `ADS: ${resumo.ads.processados} processados, ${resumo.ads.erros} erros`);
      resumo.erros += resumo.ads.erros;
    }

    // Carga MySQL
    if (flags.load) {
      log('INFO', 'Iniciando carga MySQL');
      resumo.load = await load();
      log('INFO', `MySQL: ${resumo.load.carregados} tabelas, ${resumo.load.totalLinhas} linhas`);
      resumo.erros += resumo.load.erros;
    }

    // Transformações
    if (flags.transform) {
      log('INFO', 'Iniciando transformações');
      resumo.transform = await runTransforms();
      log('INFO', `Transformações: ${resumo.transform.executadas} executadas`);
      resumo.erros += resumo.transform.erros;
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
  if (resumo.bds) console.log(`   📦 BDS: ${resumo.bds.baixados} datasets`);
  if (resumo.ads) console.log(`   📊 ADS: ${resumo.ads.processados} relatórios`);
  if (resumo.load) console.log(`   🗄️  MySQL: ${resumo.load.carregados} tabelas — ${(resumo.load.totalLinhas || 0).toLocaleString('pt-BR')} linhas`);
  if (resumo.transform) console.log(`   🔧 Transformações: ${resumo.transform.executadas} executadas`);
  if (resumo.erros > 0) console.log(`   ⚠️  ${resumo.erros} erro(s) — ver ${logFile}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  log('INFO', `Pipeline concluído em ${min}m ${seg}s. Erros: ${resumo.erros}`);
  fechar();

  return resumo;
}

function iniciarAgendamento() {
  const config = JSON.parse(fs.readFileSync('config/schedule.json', 'utf8'));
  const ag = config.agendamento;

  if (!ag || !ag.ativo) {
    console.log('ℹ️  Agendamento desativado em config/schedule.json');
    return;
  }

  const tz = ag.fuso_horario || 'America/Sao_Paulo';
  console.log(`\n⏰ Agendamento ativo: "${ag.descricao}" (${ag.cron}) — fuso: ${tz}`);
  console.log('   Pipeline rodará automaticamente conforme configurado.');
  console.log('   Pressione Ctrl+C para encerrar.\n');

  cron.schedule(ag.cron, () => {
    console.log(`\n⏰ Agendamento disparado: ${new Date().toLocaleString('pt-BR')}`);
    executarPipeline().catch((e) => console.error('❌ Erro no agendamento:', e.message));
  }, { timezone: tz });
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--watch')) {
    iniciarAgendamento();
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

    executarPipeline(opcoes).catch((e) => { console.error('❌', e.message); process.exit(1); });
  }
}

module.exports = { executarPipeline };
