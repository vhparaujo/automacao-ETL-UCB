'use strict';

// BDS diferencial — funções puras usadas pelo extrator (bds.js) e pelo loader.
//
// Como o Brightspace gera os BDS (conferido na API da UCB em 12/11/2026):
//   • Completo (Full): 1x por semana, segunda ~08:20 (Brasília). A API só mantém o último.
//   • Diferencial: todo dia ~05:21 (Brasília), com as linhas ALTERADAS desde o diferencial anterior.
//     Mesmo nome de CSV e mesmas colunas do completo (ex.: Users.csv). A API mantém ~14 dias.
//
// Por isso o diferencial não pode ser carregado como o completo (DROP/TRUNCATE + LOAD): a tabela
// ficaria só com as linhas do dia. Ele é aplicado como upsert pela chave do dataset
// (config/bds-diferencial.json): apaga da tabela as linhas com as mesmas chaves e insere as novas.
//
// Layout em csvs/:
//   csvs/*.csv                                  → completos (e ADS), carregados como sempre
//   csvs/_bds_extracts.json                     → de qual extract completo veio cada CSV
//   csvs/diferencial/*.csv                      → diferencial do dia (mesmo nome do completo; sobrescrito)
//   csvs/diferencial/_bds_extracts.json         → { "Users.csv": { dataset, tipo, criado, base, anterior } }

const fs = require('node:fs');
const path = require('node:path');
const { normalizarNome } = require('./nomes');

const PASTA_DIFERENCIAL = 'diferencial';
const ARQUIVO_MANIFESTO = '_bds_extracts.json';
const TABELA_ESTADO = '_etl_bds_estado';
const FUSO_PADRAO = 'America/Sao_Paulo';

function ms(data) {
  const v = Date.parse(data || '');
  return isNaN(v) ? null : v;
}

// Data de um extract: CreatedDate (fallback QueuedForProcessingDate)
function dataExtract(extract) {
  return extract?.CreatedDate || extract?.QueuedForProcessingDate || null;
}

// Dia (AAAA-MM-DD) de um instante no fuso informado
function diaLocal(t, fuso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(t));
}

// Diferencial do dia: só o extract Differential mais recente, e só se foi gerado HOJE (no fuso) e
// depois do completo mais recente (senão já está nele). Os de dias anteriores não são baixados.
// Retorna { extract, criado, anterior } — anterior = data do diferencial imediatamente antes na API
// (o loader usa para avisar se ele não foi aplicado) — ou { motivo } quando não há o que baixar.
// Extracts sem data ou sem DownloadLink são descartados.
function selecionarDiferencialDoDia(extracts, dataCompleto, agora = new Date(), fuso = FUSO_PADRAO) {
  const validos = (Array.isArray(extracts) ? extracts : [])
    .map((e) => ({ extract: e, criado: dataExtract(e), t: ms(dataExtract(e)) }))
    .filter((x) => x.t !== null && x.extract.DownloadLink)
    .sort((a, b) => b.t - a.t);
  if (validos.length === 0) return { motivo: 'nenhum diferencial na API' };

  const [ultimo, penultimo] = validos;
  if (diaLocal(ultimo.t, fuso) !== diaLocal(agora, fuso)) {
    return { motivo: `o diferencial de hoje ainda não foi gerado (último: ${ultimo.criado})` };
  }
  const base = ms(dataCompleto);
  if (base !== null && ultimo.t <= base) {
    return { motivo: `o diferencial de hoje (${ultimo.criado}) já está no completo de ${dataCompleto}` };
  }
  return { extract: ultimo.extract, criado: ultimo.criado, anterior: penultimo?.criado || null };
}

// Diferenciais em csvs/diferencial/*.csv (direto na pasta; o do dia sobrescreve o anterior),
// com os dados de cada um em csvs/diferencial/_bds_extracts.json
// { "Users.csv": { dataset, tipo: "Differential", criado, base, anterior } }.
// Retorna [{ csv, meta }] em ordem cronológica (criado; empate → nome). CSV sem registro → meta = null.
function listarDiferenciais(csvsDir) {
  const pasta = pastaDiferencial(csvsDir);
  if (!fs.existsSync(pasta)) return [];
  const manifesto = lerManifesto(pasta);
  return fs
    .readdirSync(pasta, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.csv'))
    .map((e) => ({ csv: path.join(pasta, e.name), nome: e.name, meta: manifesto[e.name] || null }))
    .sort((x, y) => (ms(x.meta?.criado) ?? 0) - (ms(y.meta?.criado) ?? 0) || x.nome.localeCompare(y.nome))
    .map(({ csv, meta }) => ({ csv, meta }));
}

function pastaDiferencial(csvsDir) {
  return path.join(csvsDir, PASTA_DIFERENCIAL);
}

// Manifesto (_bds_extracts.json) de uma pasta: csvs/ (completos) ou csvs/diferencial/ (diferenciais)
// { "Users.csv": { dataset, tipo, criado, ... } }
function lerManifesto(csvsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(csvsDir, ARQUIVO_MANIFESTO), 'utf8'));
  } catch {
    return {};
  }
}

function registrarNoManifesto(csvsDir, arquivosCsv, info) {
  const manifesto = lerManifesto(csvsDir);
  for (const arquivo of arquivosCsv) manifesto[path.basename(arquivo)] = info;
  fs.writeFileSync(path.join(csvsDir, ARQUIVO_MANIFESTO), JSON.stringify(manifesto, null, 2));
}

// Chave de um CSV em config/bds-diferencial.json → "chaves": { "Users": ["UserId"], ... }.
// Casamento como no schemas.json: exato, depois normalizado (sem acento/caixa/espaço/_/-).
function encontrarChave(nomeCsvBase, chaves) {
  const entradas = Object.entries(chaves || {}).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v));
  const exata = entradas.find(([k]) => k === nomeCsvBase);
  if (exata) return exata[1];
  const alvo = normalizarNome(nomeCsvBase);
  const norm = entradas.find(([k]) => normalizarNome(k) === alvo);
  return norm ? norm[1] : null;
}

// Decide se um diferencial deve ser aplicado, dado o estado da tabela em _etl_bds_estado
// ({ completo_criado, diferencial_criado } ou null) e o registro do CSV no manifesto ({ criado, base, anterior }).
// Retorna { aplicar, motivo, aviso }:
//   aplicar=false → já aplicado, ou anterior ao completo carregado (já está nele)
//   aviso         → a base completa da tabela não é a esperada, ou o diferencial anterior
//                   (meta.anterior) não foi aplicado — pode haver lacuna
function decidirAplicacao(estado, meta) {
  const criado = ms(meta?.criado);
  if (criado === null) return { aplicar: false, motivo: 'diferencial sem data (sem registro em diferencial/_bds_extracts.json)' };

  const ultimoDif = ms(estado?.diferencial_criado);
  if (ultimoDif !== null && criado <= ultimoDif) {
    return { aplicar: false, motivo: `já aplicado (último diferencial carregado: ${estado.diferencial_criado})` };
  }
  const completo = ms(estado?.completo_criado);
  if (completo !== null && criado <= completo) {
    return { aplicar: false, motivo: `anterior ao completo carregado (${estado.completo_criado})` };
  }

  let aviso = null;
  const base = ms(meta?.base);
  if (completo === null) {
    aviso = 'sem registro do completo carregado nesta tabela — a base pode estar defasada; rode o BDS completo para garantir';
  } else if (base !== null && completo < base) {
    aviso = `o completo de ${meta.base} não foi carregado (a tabela está com o de ${estado.completo_criado}) — `
      + 'podem faltar alterações entre os dois; rode o BDS completo';
  } else {
    // Só o diferencial do dia é baixado: se o anterior não foi aplicado, as alterações dele faltam
    const anterior = ms(meta?.anterior);
    if (anterior !== null && anterior > completo && (ultimoDif === null || ultimoDif < anterior)) {
      aviso = `o diferencial anterior (${meta.anterior}) não foi aplicado nesta tabela — `
        + 'as alterações dele faltam até o próximo completo (ou rode o BDS completo)';
    }
  }
  return { aplicar: true, motivo: null, aviso };
}

const q = (nome) => `\`${String(nome).replace(/`/g, '``')}\``;

// SQL do upsert de staging → tabela. colunas = colunas carregadas; chave = colunas da chave.
// <=> (igualdade que trata NULL = NULL) para chaves com colunas anuláveis (ex.: logs).
function montarSqlMerge(tabela, staging, colunas, chave) {
  if (!chave?.length) throw new Error('chave vazia');
  const on = chave.map((c) => `t.${q(c)} <=> s.${q(c)}`).join(' AND ');
  const lista = colunas.map(q).join(', ');
  return {
    apagar: `DELETE t FROM ${q(tabela)} t JOIN ${q(staging)} s ON ${on}`,
    inserir: `INSERT INTO ${q(tabela)} (${lista}) SELECT ${lista} FROM ${q(staging)}`,
  };
}

function nomeStaging(tabela) {
  return `_dif_${tabela}`.slice(0, 64);
}

module.exports = {
  PASTA_DIFERENCIAL,
  ARQUIVO_MANIFESTO,
  TABELA_ESTADO,
  dataExtract,
  selecionarDiferencialDoDia,
  pastaDiferencial,
  listarDiferenciais,
  lerManifesto,
  registrarNoManifesto,
  encontrarChave,
  decidirAplicacao,
  montarSqlMerge,
  nomeStaging,
};
