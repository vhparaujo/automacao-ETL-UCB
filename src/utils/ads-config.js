'use strict';

// Funções puras sobre as entradas de config/ads-filters.json.

const { normalizarNome } = require('./nomes');

// Chaves de controle do pipeline — nunca são enviadas como filtro para a API.
// Também são ignoradas todas as chaves iniciadas por "_" (comentários, ex.: "_revisar").
const CHAVES_RESERVADAS = ['ativo', 'automatico', 'arquivo_csv'];

// Tipos de filtro (EXPORTFILTERTYPE_T) segundo a documentação Valence — DataExport.DataSetFilter
const TIPOS_FILTRO = { 1: 'DateTime', 2: 'OrgUnit', 3: 'Role', 4: 'User', 5: 'Boolean' };

// Nome de arquivo seguro: remove acentos, minúsculas, qualquer coisa fora de [a-z0-9] vira "_"
// (repetições colapsadas; "_" nas pontas removido).
//   "Notas finais"        → "notas_finais"
//   "Premiações emitidas" → "premiacoes_emitidas"
function slug(nome) {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Nome do CSV gerado para um relatório ADS: "arquivo_csv" do config (se houver) ou slug(nome).
// Sempre termina em ".csv". "arquivo_csv" só aceita letras, números, "_" e "-".
function nomeArquivoADS(nome, config = {}) {
  if (config.arquivo_csv !== undefined && config.arquivo_csv !== null && config.arquivo_csv !== '') {
    const base = String(config.arquivo_csv).trim().replace(/\.csv$/i, '');
    if (!/^[A-Za-z0-9_-]+$/.test(base)) {
      throw new Error(`"arquivo_csv" inválido para "${nome}": "${config.arquivo_csv}" (use só letras, números, _ e -)`);
    }
    return `${base}.csv`;
  }
  const base = slug(nome);
  if (!base) throw new Error(`Não foi possível gerar nome de arquivo para o relatório "${nome}"`);
  return `${base}.csv`;
}

function ehChaveDeFiltro(chave) {
  return !chave.startsWith('_') && !CHAVES_RESERVADAS.includes(chave);
}

// Chaves do config que representam filtros da API
function chavesDeFiltro(config = {}) {
  return Object.keys(config).filter(ehChaveDeFiltro);
}

// Monta o array Filters do POST /dataExport/create. Arrays viram lista separada por vírgula.
function montarFiltros(config = {}) {
  return Object.entries(config)
    .filter(([k]) => ehChaveDeFiltro(k))
    .map(([k, v]) => ({ Name: k, Value: Array.isArray(v) ? v.join(',') : String(v) }));
}

// Compara as chaves de filtro do config com os filtros que a API declara (DataSetData.Filters).
// Retorna:
//   declarados      — [{ Name, Type, tipoNome, Description, DefaultValue }]
//   desconhecidos   — chaves do config que a API não declara
//   naoConfigurados — filtros declarados ausentes no config (a API usará o padrão)
//   casoDiferente   — [{ chave, declarado }] quando só muda maiúscula/minúscula/acento
function compararFiltros(config, filtrosDeclarados) {
  const declarados = (Array.isArray(filtrosDeclarados) ? filtrosDeclarados : []).map((f) => ({
    Name: f?.Name,
    Type: f?.Type,
    tipoNome: TIPOS_FILTRO[f?.Type] || `desconhecido (${f?.Type})`,
    Description: f?.Description ?? '',
    DefaultValue: f?.DefaultValue ?? '',
  }));
  const nomesDeclarados = declarados.map((f) => f.Name);
  const chaves = chavesDeFiltro(config);

  const desconhecidos = chaves.filter((c) => !nomesDeclarados.includes(c));
  const naoConfigurados = nomesDeclarados.filter((n) => !chaves.includes(n));
  const casoDiferente = desconhecidos
    .map((chave) => ({ chave, declarado: nomesDeclarados.find((n) => normalizarNome(n) === normalizarNome(chave)) }))
    .filter((x) => x.declarado);

  return { declarados, desconhecidos, naoConfigurados, casoDiferente };
}

module.exports = {
  CHAVES_RESERVADAS,
  TIPOS_FILTRO,
  slug,
  nomeArquivoADS,
  chavesDeFiltro,
  montarFiltros,
  compararFiltros,
};
