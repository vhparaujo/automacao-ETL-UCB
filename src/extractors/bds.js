'use strict';

require('dotenv').config();
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extrairCsvs } = require('../utils/zip');
const { getAccessToken } = require('../auth/oauth');
const { obterVersaoLP } = require('../utils/versao-api');
const { mesmoNome, nomesNaoEncontrados } = require('../utils/nomes');
const { selecionarExtractMaisRecente } = require('../utils/bds-extracts');
const {
  pastaDiferencial, selecionarDiferencialDoDia, registrarNoManifesto,
} = require('../utils/bds-diferencial');
const { comRetentativa } = require('../utils/retentativa');

const HOST = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';
const CSVS_DIR = process.env.CSVS_DIR || './csvs';
const ZIPS_DIR = path.join(CSVS_DIR, 'zips');

// Aviso de "extract sem data" é emitido uma única vez por processo
let avisoSemDataEmitido = false;

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
            const erro = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`);
            erro.status = res.statusCode;
            return reject(erro);
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

// Retorna todos os datasets disponíveis na API (usado pela CLI)
async function listar() {
  const token = await getAccessToken();
  const versao = await obterVersaoLP();
  const lista = await requisicaoAPI(`${HOST}/d2l/api/lp/${versao}/datasets/bds`, token);
  return (lista.Objects || []).map((ds) => ({
    nome: ds.Full?.Name || 'Desconhecido',
    temExtract: !!(ds.Full?.ExtractsLink),
    extractLink: ds.Full?.ExtractsLink || null,
  }));
}

// Baixa um ZIP de extract e extrai os CSVs em destinoDir. Retorna { bytes, csvs }.
async function baixarExtract(extract, nomeArquivo, destinoDir, token) {
  fs.mkdirSync(destinoDir, { recursive: true });
  const zipPath = path.join(ZIPS_DIR, `${nomeArquivo.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
  const bytes = await baixarArquivo(extract.DownloadLink, zipPath, token);
  const csvs = await extrairCsvs(zipPath, destinoDir); // streaming: CSVs de vários GB
  fs.unlinkSync(zipPath);
  return { bytes, csvs };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Completo: o extract Full mais recente → CSVs em csvs/ + registro em csvs/_bds_extracts.json
async function baixarCompleto(ds, nome, token) {
  const extracts = await requisicaoAPI(ds.Full.ExtractsLink, token);
  // Escolhe explicitamente o mais recente por CreatedDate (a API não garante a ordem)
  const { extract: latest, data: dataExtract, semDatas } = selecionarExtractMaisRecente(extracts.Objects);
  if (semDatas && !avisoSemDataEmitido) {
    avisoSemDataEmitido = true;
    process.stdout.write('\n      ⚠️  Extracts sem CreatedDate/QueuedForProcessingDate — usando a ordem retornada pela API');
  }
  if (!latest?.DownloadLink) return { pulado: 'sem arquivo disponível' };

  process.stdout.write('\n');
  const { bytes, csvs } = await baixarExtract(latest, nome, CSVS_DIR, token);
  // O loader usa o manifesto para saber de qual completo veio cada tabela (base dos diferenciais)
  registrarNoManifesto(CSVS_DIR, csvs, { dataset: nome, tipo: 'Full', criado: dataExtract });
  const quando = dataExtract ? ` — extract de ${dataExtract}` : '';
  console.log(`      ✅ ${mb(bytes)} — ${csvs.length} CSV(s)${quando}\n`);
  return { arquivos: 1 };
}

// Diferencial: só o extract Differential gerado hoje (selecionarDiferencialDoDia) — os de dias
// anteriores não são baixados. Os CSVs vão direto para csvs/diferencial/ (sobrescrevem o do dia
// anterior, como no completo) e o registro { dataset, tipo, criado, base, anterior } vai para
// csvs/diferencial/_bds_extracts.json.
async function baixarDiferencialDoDia(ds, nome, token) {
  if (!ds.Differential?.ExtractsLink) return { pulado: 'sem diferencial na API' };

  const completos = ds.Full?.ExtractsLink ? await requisicaoAPI(ds.Full.ExtractsLink, token) : { Objects: [] };
  const { data: base } = selecionarExtractMaisRecente(completos.Objects);
  const extracts = await requisicaoAPI(ds.Differential.ExtractsLink, token);
  const escolhido = selecionarDiferencialDoDia(extracts.Objects, base);
  if (escolhido.motivo) return { pulado: escolhido.motivo };

  const { extract, criado, anterior } = escolhido;
  process.stdout.write('\n');
  const pasta = pastaDiferencial(CSVS_DIR);
  const { bytes, csvs } = await baixarExtract(extract, `${nome}_dif`, pasta, token);
  registrarNoManifesto(pasta, csvs, { dataset: nome, tipo: 'Differential', criado, base, anterior });
  console.log(`      ✅ ${mb(bytes)} — ${csvs.length} CSV(s) — diferencial de ${criado}\n`);
  return { arquivos: 1 };
}

// Baixa os datasets conforme o modo:
//   'auto'     → apenas os listados em config/bds-selecao.json
//   'todos'    → todos os disponíveis
//   'selecao'  → lista de nomes passada em opcoes.nomes (usado pela CLI)
// e o tipo:
//   'completo'    (padrão) → último extract Full de cada dataset
//   'diferencial'          → só o extract Differential gerado hoje
async function download(opcoes = {}) {
  const modo = opcoes.modo || 'auto';
  const tipo = opcoes.tipo || 'completo';
  if (!['completo', 'diferencial'].includes(tipo)) throw new Error(`Tipo de BDS inválido: "${tipo}" (use completo ou diferencial)`);
  fs.mkdirSync(CSVS_DIR, { recursive: true });
  fs.mkdirSync(ZIPS_DIR, { recursive: true });

  let token = await getAccessToken();
  const versao = await obterVersaoLP();

  const listaAPI = await requisicaoAPI(`${HOST}/d2l/api/lp/${versao}/datasets/bds`, token);
  const todosDatasets = listaAPI.Objects || [];

  let selecionados;
  let nomesConfigurados = [];

  if (modo === 'todos') {
    selecionados = todosDatasets;
  } else if (modo === 'selecao' && opcoes.nomes?.length > 0) {
    selecionados = todosDatasets.filter((ds) =>
      opcoes.nomes.some((n) => mesmoNome(ds.Full?.Name || '', n))
    );
  } else {
    // modo 'auto': filtra pelos nomes do config
    const config = JSON.parse(fs.readFileSync('config/bds-selecao.json', 'utf8'));
    if (config.todos === true) {
      selecionados = todosDatasets;
    } else {
      // Comparação normalizada: "Usuarios" e "Usuários" são o mesmo dataset
      const automaticos = config.automaticos || [];
      nomesConfigurados = automaticos;
      selecionados = todosDatasets.filter((ds) =>
        automaticos.some((n) => mesmoNome(ds.Full?.Name || '', n))
      );
    }
  }

  // Nomes configurados (ou pedidos pela CLI) que não existem na API: avisa com sugestões e segue
  const pedidos = modo === 'selecao' ? opcoes.nomes || [] : modo === 'todos' ? [] : nomesConfigurados;
  const nomesAPI = todosDatasets.map((ds) => ds.Full?.Name).filter(Boolean);
  for (const { nome, sugestoes } of nomesNaoEncontrados(pedidos, nomesAPI)) {
    const dica = sugestoes.length ? ` Parecidos: ${sugestoes.map((x) => `"${x}"`).join(', ')}` : ' Nenhum nome parecido na API.';
    console.log(`⚠️  BDS "${nome}" não encontrado.${dica}`);
  }

  if (selecionados.length === 0) {
    console.log('ℹ️  Nenhum dataset BDS para baixar com a seleção atual.');
    console.log('   Edite config/bds-selecao.json para adicionar datasets automáticos.');
    return { tipo, baixados: 0, pulados: 0, erros: 0, arquivos: 0, falhas: [] };
  }

  const label = modo === 'auto' ? 'automáticos' : modo === 'todos' ? 'todos' : 'selecionados';
  const rotuloTipo = tipo === 'diferencial' ? 'DIFERENCIAL' : 'COMPLETO';
  console.log(`\n📦 BDS ${rotuloTipo} — ${selecionados.length} dataset(s) ${label} (API LP ${versao})...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let baixados = 0, pulados = 0, erros = 0, arquivos = 0;
  const falhas = []; // { nome, mensagem, tentativas } — o pipeline grava no log
  const log = opcoes.log || (() => {});
  const inicio = Date.now();

  for (let i = 0; i < selecionados.length; i++) {
    const ds = selecionados[i];
    const nome = ds.Full?.Name || ds.Differential?.Name || 'Desconhecido';

    process.stdout.write(`  📥 [${String(i + 1).padStart(3)}/${selecionados.length}] ${nome.padEnd(42)}`);

    if (tipo === 'completo' && !ds.Full?.ExtractsLink) {
      process.stdout.write(' — sem extract, pulando\n');
      pulados++;
      continue;
    }

    try {
      // Falhou? Tenta mais uma vez (src/utils/retentativa.js). O token é pedido a cada tentativa
      // para evitar 401 em sessões longas; o ZIP e os CSVs são sobrescritos na nova tentativa.
      const { valor: r, tentativas } = await comRetentativa(
        async () => {
          token = await getAccessToken();
          return tipo === 'diferencial' ? baixarDiferencialDoDia(ds, nome, token) : baixarCompleto(ds, nome, token);
        },
        {
          tentativas: opcoes.tentativas,
          esperaMs: opcoes.esperaMs,
          aoFalhar: ({ tentativa, tentativas: total, erro, vaiRepetir, esperaMs }) => {
            if (!vaiRepetir) return;
            const msg = `BDS ${tipo} "${nome}": tentativa ${tentativa}/${total} falhou (${erro.message.substring(0, 200)}) — nova tentativa em ${Math.round(esperaMs / 1000)}s`;
            process.stdout.write(`\n      🔁 Falhou (${erro.message.substring(0, 80)}) — tentando de novo em ${Math.round(esperaMs / 1000)}s...\n`);
            log('AVISO', msg);
          },
        }
      );
      if (r.pulado) {
        process.stdout.write(` — ${r.pulado}, pulando\n`);
        pulados++;
        continue;
      }
      if (tentativas > 1) log('INFO', `BDS ${tipo} "${nome}": baixado na tentativa ${tentativas}`);
      baixados++;
      arquivos += r.arquivos;
    } catch (e) {
      const tentativas = e.tentativas || 1;
      const mensagem = e.message.substring(0, 300);
      process.stdout.write(`\n      ❌ Falhou após ${tentativas} tentativa(s): ${e.message.substring(0, 120)}\n\n`);
      falhas.push({ nome, mensagem, tentativas });
      erros++;
    }
  }

  const min = Math.floor((Date.now() - inicio) / 60000);
  const seg = Math.floor(((Date.now() - inicio) % 60000) / 1000);
  const extra = tipo === 'diferencial' ? ` (${arquivos} diferencial(is))` : '';
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ BDS ${tipo}: ${baixados} baixados${extra}, ${pulados} pulados, ${erros} erros — ${min}m ${seg}s`);
  if (falhas.length) {
    console.log(`❌ ${falhas.length} dataset(s) NÃO baixado(s): ${falhas.map((f) => f.nome).join(', ')}`);
  }
  return { tipo, baixados, pulados, erros, arquivos, falhas };
}

if (require.main === module) {
  const tipo = process.argv.includes('--diferencial') ? 'diferencial' : 'completo';
  download({ tipo }).catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { download, listar };
