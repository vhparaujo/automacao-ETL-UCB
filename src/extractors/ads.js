'use strict';

require('dotenv').config();
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extrairCsvs } = require('../utils/zip');
const { getAccessToken } = require('../auth/oauth');
const { obterVersaoLP } = require('../utils/versao-api');
const { resolverPeriodo, lerArgsPeriodo } = require('../utils/datas');
const { mesmoNome } = require('../utils/nomes');
const { montarFiltros, nomeArquivoADS } = require('../utils/ads-config');
const { comRetentativa, erroDefinitivo } = require('../utils/retentativa');

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
            const erro = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`);
            erro.status = res.statusCode;
            return reject(erro);
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
          if (res.statusCode >= 400) {
            res.resume();
            const erro = new Error(`HTTP ${res.statusCode} ao baixar`);
            erro.status = res.statusCode;
            return reject(erro);
          }

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

// Aplica o período passado por --inicio/--fim. Só sobrescreve campos que o relatório já tem no
// config — não inventa startDate/endDate num ADS que não declara esses filtros.
function aplicarPeriodo(config, periodo) {
  if (!periodo) return config;
  const efetivo = { ...config };
  for (const chave of ['startDate', 'endDate']) {
    if (periodo[chave] !== undefined && config[chave] !== undefined) efetivo[chave] = periodo[chave];
  }
  return efetivo;
}

// Erros de configuração (nome do CSV, período) se repetiriam iguais: não ganham nova tentativa
function validarConfig(fn) {
  try { return fn(); }
  catch (e) { throw Object.assign(erroDefinitivo(e.message), { cause: e }); }
}

// Baixa o ZIP de um job concluído e extrai o CSV com o nome fixo
async function baixarJobConcluido(downloadUrl, nomeFixo) {
  const zipPath = path.join(ZIPS_DIR, `ADS_${path.basename(nomeFixo, '.csv')}.zip`);
  const token = await getAccessToken();
  await baixarArquivo(downloadUrl, zipPath, token);
  await extrairCsvs(zipPath, CSVS_DIR, () => nomeFixo); // streaming, salva com o nome fixo
  fs.unlinkSync(zipPath);
  return nomeFixo;
}

// estado: compartilhado entre as tentativas de download(). Se o job já foi concluído no
// Brightspace e só o download/extração falhou, a nova tentativa baixa o MESMO job em vez de
// gerar o relatório de novo.
async function processarJob(nome, config, versao, estado = {}) {
  if (estado.downloadUrl) {
    console.log(`      ♻️  Reaproveitando o job ${estado.jobId} (já concluído) — baixando de novo`);
    return baixarJobConcluido(estado.downloadUrl, estado.nomeFixo);
  }

  // O access token dura 1 h e um job pode levar mais de 30 min: pede um token válido antes de
  // cada chamada (getAccessToken() usa o cache e só renova quando falta < 60 s para expirar).
  // Antes o token era obtido uma vez no início — numa execução de 44 min os últimos relatórios
  // falhavam com HTTP 401.
  let token = await getAccessToken();
  // Resolve datas relativas ("hoje", "-180d", "inicio_semestre"…) no momento da execução.
  // Expressão inválida lança erro aqui — download() registra e segue para o próximo relatório.
  // Nome do CSV de saída (valida "arquivo_csv" antes de criar o job)
  const nomeFixo = validarConfig(() => nomeArquivoADS(nome, config));

  const periodo = validarConfig(() => resolverPeriodo(config, new Date()));
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
    throw erroDefinitivo(`Relatório "${nome}" não encontrado. Disponíveis: ${nomes}`);
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
      Object.assign(estado, { jobId, downloadUrl, nomeFixo });
      return baixarJobConcluido(downloadUrl, nomeFixo);
    }
  }

  process.stdout.write('\n');
  throw new Error(`Timeout após ${POLLING_TIMEOUT / 60000} minutos.`);
}

// Baixa os relatórios ADS conforme o modo:
//   'auto'    → apenas os com automatico: true no config
//   'todos'   → todos os ativos
//   'selecao' → lista de nomes passada em opcoes.nomes
// opcoes.periodo: { startDate?, endDate? } vindo de --inicio/--fim — vale para todos os relatórios
// desta execução, sem alterar config/ads-filters.json.
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
    return { processados: 0, erros: 0, falhas: [] };
  }

  await getAccessToken(); // valida a autenticação antes de começar
  const versao = await obterVersaoLP();
  const label = modo === 'auto' ? 'automáticos' : modo === 'todos' ? 'todos' : 'selecionados';

  console.log(`\n📊 ADS — Baixando ${relatorios.length} relatório(s) ${label} (API LP ${versao})...`);
  if (opcoes.periodo) {
    const p = opcoes.periodo;
    console.log(`  🗓️  Período sobrescrito pela linha de comando: início = ${p.startDate ?? '(do config)'}, fim = ${p.endDate ?? '(do config)'}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let processados = 0, erros = 0;
  const falhas = []; // { nome, mensagem, tentativas } — o pipeline grava no log
  const log = opcoes.log || (() => {});

  for (const [nome, config] of relatorios) {
    console.log(`\n  🚀 ${nome}`);
    const estado = {}; // job concluído, reaproveitado se só o download falhar
    try {
      // Falhou? Tenta mais uma vez (src/utils/retentativa.js) — erros de configuração não repetem
      const { valor: arquivo, tentativas } = await comRetentativa(
        () => processarJob(nome, aplicarPeriodo(config, opcoes.periodo), versao, estado),
        {
          tentativas: opcoes.tentativas,
          esperaMs: opcoes.esperaMs,
          aoFalhar: ({ tentativa, tentativas: total, erro, vaiRepetir, esperaMs }) => {
            if (!vaiRepetir) return;
            const espera = Math.round(esperaMs / 1000);
            console.log(`  🔁 Tentativa ${tentativa}/${total} falhou (${erro.message.substring(0, 120)}) — tentando de novo em ${espera}s...`);
            log('AVISO', `ADS "${nome}": tentativa ${tentativa}/${total} falhou (${erro.message.substring(0, 200)}) — nova tentativa em ${espera}s`);
          },
        }
      );
      console.log(`  ✅ ${nome} — extraído para ${path.join(CSVS_DIR, arquivo)}`);
      if (tentativas > 1) log('INFO', `ADS "${nome}": baixado na tentativa ${tentativas}`);
      processados++;
    } catch (e) {
      const tentativas = e.tentativas || 1;
      console.log(`  ❌ Falhou após ${tentativas} tentativa(s): ${e.message.substring(0, 300)}`);
      falhas.push({ nome, mensagem: e.message.substring(0, 300), tentativas });
      erros++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ ADS: ${processados} processados, ${erros} erros`);
  if (falhas.length) console.log(`❌ ${falhas.length} relatório(s) NÃO baixado(s): ${falhas.map((f) => f.nome).join(', ')}`);
  return { processados, erros, falhas };
}

if (require.main === module) {
  // node src/extractors/ads.js [--inicio <data>] [--fim <data>]
  let periodo;
  try { periodo = lerArgsPeriodo(process.argv.slice(2)); }
  catch (e) { console.error('❌', e.message); process.exit(1); }
  download({ periodo }).catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { download, listar, listarBruto, interpretarStatusJob, aplicarPeriodo };
