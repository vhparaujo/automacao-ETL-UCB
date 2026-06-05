'use strict';

require('dotenv').config();
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');
const { getAccessToken } = require('../auth/oauth');

const HOST = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';
const CSVS_DIR = process.env.CSVS_DIR || './csvs';
const ZIPS_DIR = path.join(CSVS_DIR, 'zips');
const VERSOES_LP = ['1.50', '1.48', '1.47', '1.46', '1.45', '1.44', '1.43', '1.30', '1.20', '1.13'];
const POLLING_INTERVALO = 10_000;
const POLLING_TIMEOUT = 30 * 60 * 1000;
// Status da API D2L: 0=processando, 1=erro, 2=completo
const STATUS = { PROCESSANDO: 0, ERRO: 1, COMPLETO: 2 };

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function descobrirVersaoAPI(token) {
  const tentativas = [];
  for (const versao of VERSOES_LP) {
    try {
      await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/list`, token);
      return versao;
    } catch (e) {
      tentativas.push(`  LP ${versao}: ${e.message.substring(0, 100)}`);
    }
  }
  throw new Error(`Nenhuma versão respondeu para /dataExport/list.\n${tentativas.join('\n')}`);
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

// Retorna todos os ADS disponíveis na API (usado pela CLI)
async function listar() {
  const token = await getAccessToken();
  const versao = await descobrirVersaoAPI(token);
  const resp = await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/list`, token);
  const lista = Array.isArray(resp) ? resp : resp.Objects || [];
  return lista.map((r) => ({ nome: r.Name, dataSetId: r.DataSetId, versao }));
}

async function processarJob(nome, config, versao, token) {
  const disponíveis = await requisicao(`${HOST}/d2l/api/lp/${versao}/dataExport/list`, token);
  const listaADS = Array.isArray(disponíveis) ? disponíveis : disponíveis.Objects || [];

  const match = listaADS.find((r) => (r.Name || '').toLowerCase() === nome.toLowerCase());
  if (!match) {
    const nomes = listaADS.map((r) => r.Name).join(', ');
    throw new Error(`Relatório "${nome}" não encontrado. Disponíveis: ${nomes}`);
  }

  const filtros = Object.entries(config)
    .filter(([k]) => !['ativo', 'automatico'].includes(k))
    .map(([k, v]) => ({
      Name: k,
      Value: Array.isArray(v) ? v.join(',') : String(v),
    }));

  const job = await requisicao(
    `${HOST}/d2l/api/lp/${versao}/dataExport/create`,
    token,
    { method: 'POST', body: { DataSetId: match.DataSetId, Filters: filtros } }
  );

  const jobId = job.ExportJobId;
  console.log(`      Job criado (ID: ${jobId}), aguardando...`);

  const inicio = Date.now();
  let tentativas = 0;

  while (Date.now() - inicio < POLLING_TIMEOUT) {
    await sleep(POLLING_INTERVALO);
    tentativas++;

    const jobData = await requisicao(
      `${HOST}/d2l/api/lp/${versao}/dataExport/jobs/${jobId}`,
      token
    );

    process.stdout.write(`\r      🔄 Processando... (${tentativas * (POLLING_INTERVALO / 1000)}s)   `);

    if (jobData.Status === STATUS.COMPLETO) {
      process.stdout.write('\n');
      const zipPath = path.join(ZIPS_DIR, `ADS_${nome.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
      await baixarArquivo(`${HOST}/d2l/api/lp/${versao}/dataExport/download/${jobId}`, zipPath, token);

      // Extrai o CSV com nome fixo (sem timestamp) baseado no nome do relatório
      const nomeFixo = nome.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + '.csv';
      const zip = new AdmZip(zipPath);
      zip.getEntries().forEach((entry) => {
        if (!entry.isDirectory && entry.entryName.endsWith('.csv')) {
          const destino = path.join(CSVS_DIR, nomeFixo);
          fs.writeFileSync(destino, entry.getData());
        }
      });
      fs.unlinkSync(zipPath);
      return true;
    }

    if (jobData.Status === STATUS.ERRO) {
      process.stdout.write('\n');
      throw new Error('Job falhou no servidor D2L.');
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

  const token = await getAccessToken();
  const versao = await descobrirVersaoAPI(token);
  const label = modo === 'auto' ? 'automáticos' : modo === 'todos' ? 'todos' : 'selecionados';

  console.log(`\n📊 ADS — Baixando ${relatorios.length} relatório(s) ${label} (API LP ${versao})...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let processados = 0, erros = 0;

  for (const [nome, config] of relatorios) {
    console.log(`\n  🚀 ${nome}`);
    try {
      await processarJob(nome, config, versao, token);
      console.log(`  ✅ ${nome} — extraído para ${CSVS_DIR}/`);
      processados++;
    } catch (e) {
      console.log(`  ❌ ${e.message.substring(0, 150)}`);
      erros++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ ADS: ${processados} processados, ${erros} erros`);
  return { processados, erros };
}

if (require.main === module) {
  download().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { download, listar };
