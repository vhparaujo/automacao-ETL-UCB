'use strict';

// BDS diferencial — funções puras usadas pelo extrator (bds.js).
//
// Como o Brightspace gera os BDS (conferido na API da UCB em 12/11/2026):
//   • Completo (Full): 1x por semana, segunda ~08:20 (Brasília). A API só mantém o último.
//   • Diferencial: todo dia ~05:21 (Brasília), com as linhas ALTERADAS desde o diferencial anterior.
//     Mesmo nome de CSV e mesmas colunas do completo (ex.: Users.csv). A API mantém ~14 dias.
//
// O diferencial é baixado para csvs/diferencial/ (separado dos completos), porque tem o mesmo nome de
// arquivo e só as linhas alteradas — quem consome os CSVs decide como aplicá-lo sobre o completo.
//
// Layout em csvs/:
//   csvs/*.csv                                  → completos (e ADS)
//   csvs/_bds_extracts.json                     → de qual extract completo veio cada CSV
//   csvs/diferencial/*.csv                      → diferencial do dia (mesmo nome do completo; sobrescrito)
//   csvs/diferencial/_bds_extracts.json         → { "Users.csv": { dataset, tipo, criado, base, anterior } }

const fs = require('node:fs');
const path = require('node:path');

const PASTA_DIFERENCIAL = 'diferencial';
const ARQUIVO_MANIFESTO = '_bds_extracts.json';
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
// (fica no manifesto: se ele não foi baixado, há lacuna até o próximo completo) — ou { motivo }.
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

module.exports = {
  PASTA_DIFERENCIAL,
  ARQUIVO_MANIFESTO,
  dataExtract,
  selecionarDiferencialDoDia,
  pastaDiferencial,
  lerManifesto,
  registrarNoManifesto,
};
