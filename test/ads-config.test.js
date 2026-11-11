'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { slug, nomeArquivoADS, montarFiltros, chavesDeFiltro, compararFiltros } = require('../src/utils/ads-config');

// Nome gerado pelo código antigo (antes do slug) — os ADS existentes não podem mudar
const nomeAntigo = (nome) => nome.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

test('slug mantém exatamente os nomes dos três ADS existentes', () => {
  assert.equal(slug('Notas finais'), 'notas_finais');
  assert.equal(slug('Uso do Aluno'), 'uso_do_aluno');
  assert.equal(slug('Uso do instrutor'), 'uso_do_instrutor');
  for (const nome of ['Notas finais', 'Uso do Aluno', 'Uso do instrutor']) {
    assert.equal(slug(nome), nomeAntigo(nome));
  }
});

test('os ADS existentes do config continuam gerando os CSVs esperados por schemas.json', () => {
  const raiz = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(raiz, 'config/ads-filters.json'), 'utf8'));
  const schemas = JSON.parse(fs.readFileSync(path.join(raiz, 'config/schemas.json'), 'utf8'));
  for (const nome of ['Notas finais', 'Uso do Aluno', 'Uso do instrutor']) {
    const arquivo = nomeArquivoADS(nome, config[nome]);
    assert.ok(schemas[path.basename(arquivo, '.csv')], `schema "${arquivo}" não existe`);
  }
});

test('slug remove acentos e colapsa separadores', () => {
  assert.equal(slug('Premiações emitidas'), 'premiacoes_emitidas');
  assert.equal(nomeAntigo('Premiações emitidas'), 'premia__es_emitidas'); // o problema antigo
  assert.equal(slug('Resultados da pesquisa'), 'resultados_da_pesquisa');
  assert.equal(slug('  Uso -- do / Aluno (beta) '), 'uso_do_aluno_beta');
  assert.equal(slug('Ação'), 'acao');
});

test('nomeArquivoADS usa arquivo_csv quando informado', () => {
  assert.equal(nomeArquivoADS('Premiações emitidas', { arquivo_csv: 'ads_premiacoes_emitidas' }), 'ads_premiacoes_emitidas.csv');
  assert.equal(nomeArquivoADS('X', { arquivo_csv: 'todas_as_notas.csv' }), 'todas_as_notas.csv');
  assert.equal(nomeArquivoADS('Premiações emitidas', {}), 'premiacoes_emitidas.csv');
  assert.equal(nomeArquivoADS('Notas finais'), 'notas_finais.csv');
});

test('nomeArquivoADS rejeita arquivo_csv com caminho ou caracteres inválidos', () => {
  assert.throws(() => nomeArquivoADS('X', { arquivo_csv: '../fora' }), /arquivo_csv" inválido/);
  assert.throws(() => nomeArquivoADS('X', { arquivo_csv: 'com espaço' }), /arquivo_csv" inválido/);
});

test('montarFiltros nunca envia ativo, automatico, arquivo_csv nem chaves "_*"', () => {
  const config = {
    _revisar: 'confirmar filtros',
    _comentario: 'qualquer coisa',
    ativo: true,
    automatico: false,
    arquivo_csv: 'todas_as_notas',
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-12-31T23:59:59.999Z',
    roles: ['109', '110'],
    parentOrgUnitId: '6606',
  };
  assert.deepEqual(montarFiltros(config), [
    { Name: 'startDate', Value: '2026-07-01T00:00:00.000Z' },
    { Name: 'endDate', Value: '2026-12-31T23:59:59.999Z' },
    { Name: 'roles', Value: '109,110' },
    { Name: 'parentOrgUnitId', Value: '6606' },
  ]);
  assert.deepEqual(chavesDeFiltro(config), ['startDate', 'endDate', 'roles', 'parentOrgUnitId']);
});

// Filtros declarados pela API real (saída de "npm run ads:filtros", API LP 1.64, 04/11/2026)
const FILTROS_API = {
  'Uso do instrutor': ['parentOrgUnitId', 'startDate', 'endDate', 'roles'],
  'Uso do Aluno': ['parentOrgUnitId', 'startDate', 'endDate', 'roles'],
  'Notas finais': ['startDate', 'endDate'],
  'Todas as Notas': ['parentOrgUnitId', 'startDate', 'endDate'],
  'Premiações emitidas': ['parentOrgUnitId', 'startDate', 'endDate'],
  'Resultados da pesquisa': ['parentOrgUnitId', 'startDate', 'endDate', 'roles'],
};

test('config/ads-filters.json só envia filtros que a API declara (sem ⚠️ filtro desconhecido)', () => {
  const raiz = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(raiz, 'config/ads-filters.json'), 'utf8'));
  // Relatórios podem ser removidos do config (ex.: "Premiações emitidas" → usa-se o BDS AwardsIssued);
  // os que estão lá precisam ter o nome exato da API e só filtros declarados por ela.
  const relatorios = Object.keys(config).filter((k) => !k.startsWith('_'));
  assert.ok(relatorios.length > 0, 'config sem relatórios');
  for (const nome of relatorios) {
    assert.ok(FILTROS_API[nome], `"${nome}" não é um ADS conhecido — confira o nome exato com npm run ads:filtros`);
    const { desconhecidos } = compararFiltros(config[nome], FILTROS_API[nome].map((Name) => ({ Name, Type: 1 })));
    assert.deepEqual(desconhecidos, [], nome);
  }
  // automatico/ativo são escolhas de quem opera o pipeline — o teste não fixa esses valores
  for (const nome of relatorios) {
    assert.equal(typeof config[nome].automatico, 'boolean', `${nome}: "automatico" deve ser true ou false`);
  }
});

test('compararFiltros aponta desconhecidos, não configurados e diferença de caixa', () => {
  const declarados = [
    { Name: 'startDate', Type: 1, Description: 'Início', DefaultValue: '' },
    { Name: 'endDate', Type: 1, Description: 'Fim', DefaultValue: '' },
    { Name: 'userId', Type: 4, Description: 'Usuário', DefaultValue: '0' },
  ];
  const r = compararFiltros(
    { ativo: true, _revisar: 'x', startDate: 'a', enddate: 'b', roles: ['1'] },
    declarados
  );
  assert.deepEqual(r.desconhecidos, ['enddate', 'roles']);
  assert.deepEqual(r.naoConfigurados, ['endDate', 'userId']);
  assert.deepEqual(r.casoDiferente, [{ chave: 'enddate', declarado: 'endDate' }]);
  assert.equal(r.declarados[0].tipoNome, 'DateTime');
  assert.equal(r.declarados[2].tipoNome, 'User');
});

test('compararFiltros tolera Filters ausente ou tipo desconhecido', () => {
  assert.deepEqual(compararFiltros({ startDate: 'x' }, undefined).desconhecidos, ['startDate']);
  assert.match(compararFiltros({}, [{ Name: 'a', Type: 99 }]).declarados[0].tipoNome, /desconhecido \(99\)/);
});

test('interpretarStatusJob: 0/1 aguarda, 2 pronto, 3/4/desconhecido falha', () => {
  const ads = require('../src/extractors/ads');
  for (const s of [0, 1]) assert.deepEqual([ads.interpretarStatusJob(s).pronto, ads.interpretarStatusJob(s).falhou], [false, false]);
  assert.equal(ads.interpretarStatusJob(2).pronto, true);
  for (const s of [3, 4, 9, undefined]) assert.equal(ads.interpretarStatusJob(s).falhou, true, String(s));
  assert.match(ads.interpretarStatusJob(3).descricao, /Status 3 = erro/);
});
