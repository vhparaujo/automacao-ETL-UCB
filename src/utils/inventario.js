'use strict';

// Inventário dos CSVs baixados → exports/_inventario_csvs.md
//
//   npm run inventario
//
// Para cada CSV de csvs/ (ignorando _anterior/ e zips/): tamanho, número de registros (via stream),
// tabela MySQL de destino, schema fixo ou TEXT, origem (BDS/ADS), colunas na ordem do cabeçalho,
// formato das colunas de data/hora e se as colunas de ID são numéricas.
//
// PRIVACIDADE: o único valor real exibido é um exemplo das colunas de data/hora em formato
// reconhecido. Nenhum outro valor (nome, e-mail, matrícula…) entra no inventário; colunas de data
// com formato "outro" mostram só uma máscara (dígitos → 9, letras → x).

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { criarParserCSV } = require('./csv');
const { encontrarSchema, mesmoNome, normalizarNome } = require('./nomes');
const { nomeArquivoADS } = require('./ads-config');
const { listarCsvs } = require('./pasta-csvs');

const CSVS_DIR = process.env.CSVS_DIR || './csvs';
const EXPORTS_DIR = process.env.EXPORTS_DIR || './exports';
const ARQUIVO_SAIDA = '_inventario_csvs.md';
const LINHAS_AMOSTRA = 1000;

// 'access' = equivalente em inglês de 'acesso' (colunas BDS como LastAccessed, DayAccessed)
const TERMOS_DATA = ['date', 'time', 'data', 'acesso', 'access', 'modifica', 'ultima', 'ultimo', 'timestamp'];

// ── Detecções (funções puras) ─────────────────────────────────────

function semAcento(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function ehColunaData(nome) {
  const n = semAcento(nome);
  return TERMOS_DATA.some((t) => n.includes(t));
}

// "UserId", "OrgDefinedId", "ID definido da organização", "id", "Identifier", "Identificador"
function ehColunaId(nome) {
  const s = String(nome ?? '');
  return /(^|[^a-z])id([^a-z]|$)/i.test(s) || /[a-z0-9]Id([A-Z0-9_]|$)/.test(s) || /^identifi/i.test(semAcento(s));
}

function detectarFormatoData(valor) {
  const v = String(valor ?? '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/i.test(v)) return 'ISO com Z';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:?\d{2}$/.test(v)) return 'ISO com offset';
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(v)) return 'ISO sem fuso';
  if (/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}(:\d{2})?$/.test(v)) return 'dd/mm/aaaa hh:mm';
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return 'dd/mm/aaaa';
  return 'outro';
}

// Mostra o formato sem expor o conteúdo: dígitos → 9, letras → x
function mascarar(valor) {
  return String(valor).substring(0, 40).replace(/\d/g, '9').replace(/\p{L}/gu, 'x');
}

function ehNumerico(valor) {
  return /^-?\d+$/.test(String(valor).trim());
}

// ── Origem e destino ──────────────────────────────────────────────

function lerJSON(caminho, padrao) {
  try { return JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch { return padrao; }
}

// Origem pelo nome configurado: ADS (nome gerado por nomeArquivoADS) ou BDS (bds-selecao/aliases)
function identificarOrigem(arquivo, { adsConfig = {}, bdsSelecao = {}, schemas = {} } = {}) {
  const nomeArq = path.basename(arquivo).toLowerCase();
  for (const [nome, cfg] of Object.entries(adsConfig)) {
    if (nome.startsWith('_') || !cfg || typeof cfg !== 'object') continue;
    try {
      if (nomeArquivoADS(nome, cfg).toLowerCase() === nomeArq) return `ADS — "${nome}"`;
    } catch { /* arquivo_csv inválido: ignora */ }
  }

  const base = path.basename(arquivo, path.extname(arquivo));
  const entrada = encontrarSchema(base, schemas);
  const candidatos = [base, ...(entrada ? [entrada.chave, ...(entrada.schema.aliases || [])] : [])];
  for (const nome of bdsSelecao.automaticos || []) {
    if (candidatos.some((c) => mesmoNome(c, nome))) return `BDS — "${nome}"`;
  }
  return 'não identificada pelo nome (não é nenhum ADS configurado → provavelmente BDS)';
}

function destinoTabela(arquivo, schemas) {
  const base = path.basename(arquivo, '.csv');
  const entrada = encontrarSchema(base, schemas);
  const tabela = entrada?.schema?.tabela || base.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const inferir = String(process.env.INFERIR_TIPOS || '').trim().toLowerCase() === 'true';
  const tipo = entrada
    ? `schema fixo (config/schemas.json → "${entrada.chave}")`
    : inferir ? 'sem schema → tipos inferidos (INFERIR_TIPOS=true)' : 'sem schema → todas as colunas TEXT';
  return { tabela, tipo, schemaFixo: !!entrada };
}

// ── Análise de um CSV (stream) ────────────────────────────────────

function analisarCSV(caminho, { linhasAmostra = LINHAS_AMOSTRA } = {}) {
  return new Promise((resolve, reject) => {
    let cabecalho = null;
    let registros = 0; // sem contar o cabeçalho
    let datas = [];
    let ids = [];

    const parser = criarParserCSV((campos) => {
      if (!cabecalho) {
        cabecalho = campos;
        datas = campos.map((nome, i) => (ehColunaData(nome) ? { i, nome, exemplo: null, formatos: {}, vazios: 0 } : null)).filter(Boolean);
        ids = campos.map((nome, i) => (ehColunaId(nome) ? { i, nome, preenchidos: 0, naoNumericos: 0 } : null)).filter(Boolean);
        return;
      }
      registros++;
      if (registros > linhasAmostra) return;

      for (const d of datas) {
        const v = campos[d.i] ?? '';
        if (v === '') { d.vazios++; continue; }
        const formato = detectarFormatoData(v);
        d.formatos[formato] = (d.formatos[formato] || 0) + 1;
        if (d.exemplo === null) d.exemplo = { valor: v, formato };
      }
      for (const c of ids) {
        const v = campos[c.i] ?? '';
        if (v === '') continue;
        c.preenchidos++;
        if (!ehNumerico(v)) c.naoNumericos++;
      }
    });

    const stream = fs.createReadStream(caminho, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => parser.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      parser.end();
      resolve({
        colunas: cabecalho || [],
        registros,
        amostradas: Math.min(registros, linhasAmostra),
        datas,
        ids,
      });
    });
  });
}

// ── Markdown ──────────────────────────────────────────────────────

function celula(texto) {
  return String(texto ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function blocoArquivo(info) {
  const l = [];
  l.push(`## ${info.arquivo}`, '');
  l.push(`- **Tamanho:** ${info.mb} MB`);
  l.push(`- **Registros (sem cabeçalho):** ${info.registros.toLocaleString('pt-BR')}`);
  l.push(`- **Tabela MySQL:** \`${info.tabela}\` — ${info.tipo}`);
  l.push(`- **Origem:** ${info.origem}`);
  l.push(`- **Colunas (${info.colunas.length}):**`, '');
  info.colunas.forEach((c, i) => l.push(`  ${i + 1}. \`${c}\``));
  l.push('');

  if (info.datas.length) {
    l.push(`**Colunas de data/hora** (amostra: ${info.amostradas.toLocaleString('pt-BR')} primeiras linhas)`, '');
    l.push('| Coluna | Exemplo | Formato do exemplo | Formatos na amostra | Vazios |');
    l.push('|---|---|---|---|---|');
    for (const d of info.datas) {
      const exemplo = !d.exemplo ? '—' : d.exemplo.formato === 'outro' ? `máscara: \`${mascarar(d.exemplo.valor)}\`` : `\`${d.exemplo.valor}\``;
      const formatos = Object.entries(d.formatos).map(([f, n]) => `${f}: ${n}`).join(', ') || 'sem valores';
      l.push(`| ${celula(d.nome)} | ${celula(exemplo)} | ${d.exemplo ? d.exemplo.formato : '—'} | ${celula(formatos)} | ${d.vazios} |`);
    }
    l.push('');
  }

  if (info.ids.length) {
    l.push(`**Colunas de ID** (amostra: ${info.amostradas.toLocaleString('pt-BR')} primeiras linhas)`, '');
    l.push('| Coluna | Todos numéricos? | Preenchidos na amostra |');
    l.push('|---|---|---|');
    for (const c of info.ids) {
      const status = c.preenchidos === 0 ? '— (sem valores)' : c.naoNumericos === 0 ? '✅ sim' : `❌ não (${c.naoNumericos} não numéricos)`;
      l.push(`| ${celula(c.nome)} | ${status} | ${c.preenchidos} |`);
    }
    l.push('');
  }
  return l.join('\n');
}

function gerarMarkdown(infos, quando = new Date()) {
  const l = [];
  l.push('# Inventário dos CSVs', '');
  l.push(`Gerado em ${quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — ${infos.length} arquivo(s) em \`csvs/\` (sem \`_anterior/\` e \`zips/\`).`, '');
  l.push('> Privacidade: só colunas de data/hora mostram um exemplo de valor. Nenhum outro dado do CSV aparece aqui.', '');
  l.push('| Arquivo | MB | Registros | Tabela | Schema | Origem |');
  l.push('|---|---|---|---|---|---|');
  for (const i of infos) {
    const schema = i.erro ? `❌ ${celula(i.erro)}` : i.schemaFixo ? '📋 fixo' : '🔍 TEXT';
    l.push(`| ${celula(i.arquivo)} | ${i.mb} | ${i.erro ? '—' : i.registros.toLocaleString('pt-BR')} | \`${i.tabela}\` | ${schema} | ${celula(i.origem)} |`);
  }
  l.push('');
  for (const i of infos) {
    if (i.erro) continue;
    l.push(blocoArquivo(i), '');
  }
  return l.join('\n');
}

// ── Execução ──────────────────────────────────────────────────────

async function gerarInventario({ csvsDir = CSVS_DIR, exportsDir = EXPORTS_DIR } = {}) {
  const schemas = lerJSON('config/schemas.json', {});
  const contexto = {
    schemas,
    adsConfig: lerJSON('config/ads-filters.json', {}),
    bdsSelecao: lerJSON('config/bds-selecao.json', {}),
  };

  const arquivos = listarCsvs(csvsDir);
  console.log(`\n📒 Inventário — analisando ${arquivos.length} CSV(s)...`);

  const infos = [];
  for (const caminho of arquivos) {
    const arquivo = path.basename(caminho);
    const mb = (fs.statSync(caminho).size / 1024 / 1024).toFixed(1);
    const { tabela, tipo, schemaFixo } = destinoTabela(caminho, schemas);
    const origem = identificarOrigem(caminho, contexto);
    try {
      const analise = await analisarCSV(caminho);
      infos.push({ arquivo, mb, tabela, tipo, schemaFixo, origem, ...analise });
      console.log(`  ✅ ${arquivo.padEnd(40)} ${analise.registros.toLocaleString('pt-BR')} registros, ${analise.colunas.length} colunas`);
    } catch (e) {
      infos.push({ arquivo, mb, tabela, tipo, schemaFixo, origem, erro: e.message, registros: 0, colunas: [], datas: [], ids: [] });
      console.log(`  ❌ ${arquivo}: ${e.message}`);
    }
  }

  fs.mkdirSync(exportsDir, { recursive: true });
  const saida = path.join(exportsDir, ARQUIVO_SAIDA);
  fs.writeFileSync(saida, gerarMarkdown(infos), 'utf8');
  console.log(`📒 Inventário gravado em ${saida}`);
  return { arquivo: saida, total: infos.length, erros: infos.filter((i) => i.erro).length };
}

if (require.main === module) {
  gerarInventario().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = {
  gerarInventario,
  analisarCSV,
  gerarMarkdown,
  identificarOrigem,
  destinoTabela,
  detectarFormatoData,
  ehColunaData,
  ehColunaId,
  mascarar,
  ARQUIVO_SAIDA,
};
