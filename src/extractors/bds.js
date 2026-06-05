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
const VERSOES_LP = ['1.50', '1.48', '1.47', '1.46', '1.45', '1.44', '1.43'];

function requisicaoAPI(url, token) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Resposta inválida: ${data.substring(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function descobrirVersaoAPI(token) {
  const tentativas = [];
  for (const versao of VERSOES_LP) {
    try {
      await requisicaoAPI(`${HOST}/d2l/api/lp/${versao}/datasets/bds`, token);
      return versao;
    } catch (e) {
      tentativas.push(`  LP ${versao}: ${e.message.substring(0, 120)}`);
    }
  }
  throw new Error(
    `Nenhuma versão da API LP respondeu para /datasets/bds.\n` +
    `Diagnóstico:\n${tentativas.join('\n')}\n\n` +
    `→ Verifique se o scope 'datasets:bds:read' está no app OAuth do Brightspace e rode: npm run setup`
  );
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

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let baixados = 0;
          res.on('data', (chunk) => {
            baixados += chunk.length;
            const mb = (baixados / 1024 / 1024).toFixed(1);
            const totalMb = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : '';
            process.stdout.write(`\r      ${mb} MB${totalMb}   `);
          });

          const fileStream = fs.createWriteStream(destino);
          pipeline(res, fileStream)
            .then(() => { process.stdout.write('\n'); resolve(total || baixados); })
            .catch(reject);
        }
      );
      req.on('error', reject);
      req.end();
    };
    fazerRequisicao(downloadUrl);
  });
}

function extrairZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const csvs = [];
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory && entry.entryName.endsWith('.csv')) {
      zip.extractEntryTo(entry, destDir, false, true);
      csvs.push(path.join(destDir, path.basename(entry.entryName)));
    }
  }
  return csvs;
}

// Retorna todos os datasets disponíveis na API (usado pela CLI)
async function listar() {
  const token = await getAccessToken();
  const versao = await descobrirVersaoAPI(token);
  const lista = await requisicaoAPI(`${HOST}/d2l/api/lp/${versao}/datasets/bds`, token);
  return (lista.Objects || []).map((ds) => ({
    nome: ds.Full?.Name || 'Desconhecido',
    temExtract: !!(ds.Full?.ExtractsLink),
    extractLink: ds.Full?.ExtractsLink || null,
  }));
}

// Baixa os datasets conforme o modo:
//   'auto'     → apenas os listados em config/bds-selecao.json
//   'todos'    → todos os disponíveis
//   'selecao'  → lista de nomes passada em opcoes.nomes (usado pela CLI)
async function download(opcoes = {}) {
  const modo = opcoes.modo || 'auto';
  fs.mkdirSync(CSVS_DIR, { recursive: true });
  fs.mkdirSync(ZIPS_DIR, { recursive: true });

  const token = await getAccessToken();
  const versao = await descobrirVersaoAPI(token);

  const listaAPI = await requisicaoAPI(`${HOST}/d2l/api/lp/${versao}/datasets/bds`, token);
  const todosDatasets = listaAPI.Objects || [];

  let selecionados;

  if (modo === 'todos') {
    selecionados = todosDatasets;
  } else if (modo === 'selecao' && opcoes.nomes?.length > 0) {
    selecionados = todosDatasets.filter((ds) =>
      opcoes.nomes.some((n) => (ds.Full?.Name || '').toLowerCase() === n.toLowerCase())
    );
  } else {
    // modo 'auto': filtra pelos nomes do config
    const config = JSON.parse(fs.readFileSync('config/bds-selecao.json', 'utf8'));
    if (config.todos === true) {
      selecionados = todosDatasets;
    } else {
      const automaticos = (config.automaticos || []).map((n) => n.toLowerCase());
      selecionados = todosDatasets.filter((ds) =>
        automaticos.includes((ds.Full?.Name || '').toLowerCase())
      );
    }
  }

  if (selecionados.length === 0) {
    console.log('ℹ️  Nenhum dataset BDS para baixar com a seleção atual.');
    console.log('   Edite config/bds-selecao.json para adicionar datasets automáticos.');
    return { baixados: 0, pulados: 0, erros: 0 };
  }

  const label = modo === 'auto' ? 'automáticos' : modo === 'todos' ? 'todos' : 'selecionados';
  console.log(`\n📦 BDS — Baixando ${selecionados.length} dataset(s) ${label} (API LP ${versao})...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let baixados = 0, pulados = 0, erros = 0;
  const inicio = Date.now();

  for (let i = 0; i < selecionados.length; i++) {
    const ds = selecionados[i];
    const fullInfo = ds.Full;
    const nome = fullInfo?.Name || 'Desconhecido';

    process.stdout.write(`  📥 [${String(i + 1).padStart(3)}/${selecionados.length}] ${nome.padEnd(42)}`);

    if (!fullInfo?.ExtractsLink) {
      process.stdout.write(' — sem extract, pulando\n');
      pulados++;
      continue;
    }

    try {
      const extracts = await requisicaoAPI(fullInfo.ExtractsLink, token);
      const latest = (extracts.Objects || [])[0];

      if (!latest?.DownloadLink) {
        process.stdout.write(' — sem arquivo disponível, pulando\n');
        pulados++;
        continue;
      }

      process.stdout.write('\n');
      const zipPath = path.join(ZIPS_DIR, `${nome.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
      const bytes = await baixarArquivo(latest.DownloadLink, zipPath, token);
      const csvs = extrairZip(zipPath, CSVS_DIR);
      fs.unlinkSync(zipPath);

      console.log(`      ✅ ${(bytes / 1024 / 1024).toFixed(1)} MB — ${csvs.length} CSV(s)\n`);
      baixados++;
    } catch (e) {
      process.stdout.write(`\n      ⚠️  ${e.message.substring(0, 80)}\n\n`);
      erros++;
    }
  }

  const min = Math.floor((Date.now() - inicio) / 60000);
  const seg = Math.floor(((Date.now() - inicio) % 60000) / 1000);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ BDS: ${baixados} baixados, ${pulados} sem arquivo, ${erros} erros — ${min}m ${seg}s`);
  return { baixados, pulados, erros };
}

if (require.main === module) {
  download().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { download, listar };
