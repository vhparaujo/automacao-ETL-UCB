'use strict';

// Seleção do extract BDS mais recente.
//
// Segundo a documentação Valence (BrightspaceDataSetExtractInfo, rota
// GET /d2l/api/lp/(version)/datasets/bds/(schemaId)/extracts), cada extract tem:
//   CreatedDate             — UTCDateTime de criação do arquivo  ← campo principal
//   QueuedForProcessingDate — UTCDateTime em que entrou na fila  ← fallback
// A API não garante a ordenação da lista, então ordenamos explicitamente.

const CAMPOS_DATA = ['CreatedDate', 'QueuedForProcessingDate'];

// Retorna o timestamp (ms) do extract, ou null se nenhum campo de data for válido
function dataDoExtract(extract) {
  for (const campo of CAMPOS_DATA) {
    const valor = extract?.[campo];
    if (!valor) continue;
    const ms = Date.parse(valor);
    if (!isNaN(ms)) return { ms, campo, valor };
  }
  return null;
}

// Recebe extracts.Objects e retorna { extract, data, semDatas }:
//   extract  — o mais recente (ou o primeiro da lista se nenhum tiver data); null se vazia
//   data     — string da data usada (ou null)
//   semDatas — true quando nenhum item tinha data e a ordem original foi mantida
// Itens sem data ficam atrás dos que têm data. Não modifica a lista recebida.
function selecionarExtractMaisRecente(objetos) {
  const lista = Array.isArray(objetos) ? objetos : [];
  if (lista.length === 0) return { extract: null, data: null, semDatas: false };

  const comDatas = lista.map((extract, indice) => ({ extract, indice, data: dataDoExtract(extract) }));
  if (comDatas.every((x) => x.data === null)) {
    return { extract: lista[0], data: null, semDatas: true };
  }

  comDatas.sort((a, b) => {
    if (a.data && b.data) return b.data.ms - a.data.ms || a.indice - b.indice;
    if (a.data) return -1;
    if (b.data) return 1;
    return a.indice - b.indice;
  });

  const escolhido = comDatas[0];
  return { extract: escolhido.extract, data: escolhido.data.valor, semDatas: false };
}

module.exports = { selecionarExtractMaisRecente, CAMPOS_DATA };
