'use strict';

require('dotenv').config();
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extrairCsvs } = require('../utils/zip');
const { getAccessToken } = require('../auth/oauth');
const { obterVersaoLP } = require('../utils/versao-api');
const { resolverPeriodo } = require('../utils/datas');
const { mesmoNome } = require('../utils/nomes');
const { montarFiltros, nomeArquivoADS } = require('../utils/ads-config');

const HOST = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';
const CSVS_DIR = process.env.CSVS_DIR || './csvs';
const ZIPS_DIR = path.join(CSVS_DIR, 'zips');
const POLLING_INTERVALO = 10_000;
const POLLING_TIMEOUT = 30 * 60 * 1000;

function requisicao(url, token, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const { method = 'GET', body } = opcoes;
    const bodyStr = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
          }
          try { resolve(data ? JSON.parse(data) : {}); }
          catch { reject(new Error(`Resposta inválida: ${data.substring(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Status do ExportJob (API Brightspace): 0 na fila, 1 processando, 2 concluído, 3 erro, 4 apagado
const STATUS_JOB = { 0: 'na fila', 1: 'processando', 2: 'concluído', 3: 'erro', 4: 'apagado' };

function interpretarStatusJob(status) {
  const descricao = `Status ${status} = ${STATUS_JOB[status] ?? 'desconhecido'}`;
  return {
    pronto: status === 2,
    falhou: status === 3 || status === 4 || !(status in STATUS_JOB),
    descricao,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 965000 → "16 min 05s"
function formatarMinutos(ms) {
  const totalSeg = Math.floor(ms / 1000);
  return `${Math.floor(totalSeg / 60)} min ${String(totalSeg % 60).padStart(2, '0')}s`;
}

function baixarArquivo(downloadUrl, destino, token) {
  return new Promise((resolve, reject) => {
    const fazerRequisicao = (url, redirecionamentos = 0) => {
      if (redirecionamentos > 5) return reject(new Error('Muitos redirecionamentos'));
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : require('node:http');
      const ehUCB = parsed.hostname.includes('brightspace') || parsed.hostname.includes('catolica');

      const req = proto.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: ehUCB ? { Authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            req.destroy();
            return fazerRequisicao(res.headers.location, redirecionamentos + 1);
          }
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ao baixar`));

          const fileStream = fs.createWriteStream(destino);
          pipeline(res, fileStream).then(resolve).catch(reject);
        }
      );
      req.on('error', reject);
      req.end();
    };
    fazerRequisicao(downloadUrl);
  });
}

// Resposta bruta de GET /dataExport/list (array de DataSetData) — usada por src/utils/ads-filtros.js
async function listarBruto() {
  const token = await getAccessToken();
  const versao = await obterVersaoLP();
  const resp = await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/list`, token);
  return { versao, resposta: resp, lista: Array.isArray(resp) ? resp : resp.Objects || [] };
}

// Retorna todos os ADS disponíveis na API (usado pela CLI)
async function listar() {
  const { versao, lista } = await listarBruto();
  return lista.map((r) => ({ nome: r.Name, dataSetId: r.DataSetId, versao }));
}

async function processarJob(nome, config, versao) {
  // O access token dura 1 h e um job pode levar mais de 30 min: pede um token válido antes de
  // cada chamada (getAccessToken() usa o cache e só renova quando falta < 60 s para expirar).
  // Antes o token era obtido uma vez no início — numa execução de 44 min os últimos relatórios
  // falhavam com HTTP 401.
  let token = await getAccessToken();
  // Resolve datas relativas ("hoje", "-180d", "inicio_semestre"…) no momento da execução.
  // Expressão inválida lança erro aqui — download() registra e segue para o próximo relatório.
  // Nome do CSV de saída (valida "arquivo_csv" antes de criar o job)
  const nomeFixo = nomeArquivoADS(nome, config);

  const periodo = resolverPeriodo(config, new Date());
  const configEfetiva = { ...config, ...periodo };
  if (periodo.startDate || periodo.endDate) {
    console.log(`      📅 Período: ${periodo.startDate || '(sem início)'} → ${periodo.endDate || '(sem fim)'}`);
  }

  const disponíveis = await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/list`, token);
  const listaADS = Array.isArray(disponíveis) ? disponíveis : disponíveis.Objects || [];

  // Comparação normalizada (sem acento, case-insensitive, ignora espaços/_/-)
  const match = listaADS.find((r) => mesmoNome(r.Name || '', nome));
  if (!match) {
    const nomes = listaADS.map((r) => r.Name).join(', ');
    throw new Error(`Relatório "${nome}" não encontrado. Disponíveis: ${nomes}`);
  }

  // ativo, automatico, arquivo_csv e chaves "_*" nunca vão para a API
  const filtros = montarFiltros(configEfetiva);

  const job = await requisicao(
    `${HOST}/d2l/api/lp/${versao}/dataExport/create`,
    token,
    { method: 'POST', body: { DataSetId: match.DataSetId, Filters: filtros } }
  );

  const jobId = job.ExportJobId;
  const downloadUrl = `${HOST}/d2l/api/lp/${versao}/dataExport/download/${jobId}`;
  console.log(`      Job criado (ID: ${jobId}), aguardando...`);

  const inicio = Date.now();

  while (Date.now() - inicio < POLLING_TIMEOUT) {
    await sleep(POLLING_INTERVALO);
    token = await getAccessToken();
    process.stdout.write(`\r      🔄 Processando... (${formatarMinutos(Date.now() - inicio)})   `);

    // Status real do job (GET /dataExport/jobs/{id}). Antes usávamos HEAD no download (404 = processando),
    // mas um job com ERRO também devolve 404 para sempre — o código esperava os 30 min à toa.
    const { Status } = await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/jobs/${jobId}`, token);
    const status = interpretarStatusJob(Status);
    if (status.falhou) {
      process.stdout.write('\n');
      throw new Error(`Brightspace não conseguiu gerar o relatório (job ${jobId}: ${status.descricao}) — tente um período menor`);
    }
    const pronto = status.pronto;

    if (pronto) {
      process.stdout.write('\n');
      const zipPath = path.join(ZIPS_DIR, `ADS_${path.basename(nomeFixo, '.csv')}.zip`);
      token = await getAccessToken();
      await baixarArquivo(downloadUrl, zipPath, token);

      await extrairCsvs(zipPath, CSVS_DIR, () => nomeFixo); // streaming, salva com o nome fixo
      fs.unlinkSync(zipPath);
      return nomeFixo;
    }
  }

  process.stdout.write('\n');
  throw new Error(`Timeout após ${POLLING_TIMEOUT / 60000} minutos.`);
}

// Baixa os relatórios ADS conforme o modo:
//   'auto'    → apenas os com automatico: true no config
//   'todos'   → todos os ativos
//   'selecao' → lista de nomes passada em opcoes.nomes
async function download(opcoes = {}) {
  const modo = opcoes.modo || 'auto';
  fs.mkdirSync(CSVS_DIR, { recursive: true });
  fs.mkdirSync(ZIPS_DIR, { recursive: true });

  const filtrosConfig = JSON.parse(fs.readFileSync('config/ads-filters.json', 'utf8'));

  let relatorios;

  if (modo === 'selecao' && opcoes.nomes?.length > 0) {
    // Sob demanda: pode não ter config salvo — usa defaults
    relatorios = opcoes.nomes.map((nome) => [nome, filtrosConfig[nome] || {}]);
  } else if (modo === 'todos') {
    relatorios = Object.entries(filtrosConfig).filter(([k, v]) => !k.startsWith('_') && v.ativo !== false);
  } else {
    // 'auto': apenas os marcados como automatico: true
    relatorios = Object.entries(filtrosConfig).filter(
      ([k, v]) => !k.startsWith('_') && v.ativo !== false && v.automatico === true
    );
  }

  if (relatorios.length === 0) {
    console.log('ℹ️  Nenhum relatório ADS para baixar com a seleção atual.');
    console.log('   Edite config/ads-filters.json e defina "automatico": true nos desejados.');
    return { processados: 0, erros: 0 };
  }

  await getAccessToken(); // valida a autenticação antes de começar
  const versao = await obterVersaoLP();
  const label = modo === 'auto' ? 'automáticos' : modo === 'todos' ? 'todos' : 'selecionados';

  console.log(`\n📊 ADS — Baixando ${relatorios.length} relatório(s) ${label} (API LP ${versao})...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let processados = 0, erros = 0;
  const falhas = []; // { nome, mensagem } — o pipeline grava no log

  for (const [nome, config] of relatorios) {
    console.log(`\n  🚀 ${nome}`);
    try {
      const arquivo = await processarJob(nome, config, versao);
      console.log(`  ✅ ${nome} — extraído para ${path.join(CSVS_DIR, arquivo)}`);
      processados++;
    } catch (e) {
      console.log(`  ❌ ${e.message.substring(0, 150)}`);
      falhas.push({ nome, mensagem: e.message.substring(0, 300) });
      erros++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ ADS: ${processados} processados, ${erros} erros`);
  return { processados, erros, falhas };
}

if (require.main === module) {
  download().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { download, listar, listarBruto, interpretarStatusJob };
