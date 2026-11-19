'use strict';

// Organização da pasta csvs/:
//   csvs/*.csv        → CSVs da execução atual (os únicos carregados e inventariados)
//   csvs/_anterior/   → conteúdo da execução anterior (só a última; substituído a cada pipeline completo)
//   csvs/zips/        → temporário dos downloads
//   csvs/diferencial/ → BDS diferencial do dia + _bds_extracts.json (aplicados pelo loader como upsert; ver bds-diferencial.js)
//   csvs/manuais/     → CSVs colocados à mão (não vêm do AVA): NUNCA arquivados, recarregados em toda carga

const fs = require('node:fs');
const path = require('node:path');

const PASTA_ANTERIOR = '_anterior';
const PASTA_ZIPS = 'zips';
const PASTA_MANUAIS = 'manuais';
const IGNORADAS = [PASTA_ANTERIOR, PASTA_ZIPS, PASTA_MANUAIS];

// Lista os .csv do nível de cima de csvsDir (subpastas como _anterior/ e zips/ ficam de fora)
function listarCsvs(csvsDir) {
  if (!fs.existsSync(csvsDir)) return [];
  return fs
    .readdirSync(csvsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.csv'))
    .map((e) => path.join(csvsDir, e.name))
    .sort();
}

// CSVs colocados à mão em csvs/manuais/ (nível de cima). Um manual com o mesmo nome de um CSV de
// csvs/ (BDS/ADS) é ignorado — iria para a mesma tabela. Retorna { arquivos, ignorados }.
function listarCsvsManuais(csvsDir) {
  const baixados = new Set(listarCsvs(csvsDir).map((f) => path.basename(f).toLowerCase()));
  const arquivos = [], ignorados = [];
  for (const f of listarCsvs(path.join(csvsDir, PASTA_MANUAIS))) {
    (baixados.has(path.basename(f).toLowerCase()) ? ignorados : arquivos).push(f);
  }
  return { arquivos, ignorados };
}

// Move todo o conteúdo atual de csvsDir para csvsDir/_anterior/ (apagando o _anterior antigo).
// zips/ e manuais/ ficam onde estão (manuais/ é criada se não existir). Retorna a lista de nomes movidos.
function arquivarCsvsAnteriores(csvsDir) {
  fs.mkdirSync(path.join(csvsDir, PASTA_MANUAIS), { recursive: true });
  const destino = path.join(csvsDir, PASTA_ANTERIOR);
  const itens = fs.readdirSync(csvsDir).filter((nome) => !IGNORADAS.includes(nome));

  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  for (const nome of itens) {
    fs.renameSync(path.join(csvsDir, nome), path.join(destino, nome));
  }
  return itens;
}

// Tabelas existentes que não estão entre as carregadas (comparação sem diferenciar maiúsculas).
// Tabelas internas do ETL (_etl_bds_estado, staging _dif_*) ficam de fora.
function tabelasNaoAtualizadas(existentes, carregadas) {
  const atualizadas = new Set((carregadas || []).map((t) => String(t).toLowerCase()));
  return (existentes || [])
    .filter((t) => !String(t).startsWith('_') && !atualizadas.has(String(t).toLowerCase()))
    .sort();
}

module.exports = { PASTA_ANTERIOR, PASTA_MANUAIS, listarCsvs, listarCsvsManuais, arquivarCsvsAnteriores, tabelasNaoAtualizadas };
