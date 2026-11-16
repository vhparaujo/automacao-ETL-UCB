'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizarNome, mesmoNome, encontrarSchema } = require('../src/utils/nomes');

test('normalizarNome remove acentos, caixa, espaços, _ e -', () => {
  assert.equal(normalizarNome('Usuários'), 'usuarios');
  assert.equal(normalizarNome('Unidades_organizacionais'), 'unidadesorganizacionais');
  assert.equal(normalizarNome('Unidades organizacionais'), 'unidadesorganizacionais');
  assert.equal(normalizarNome('Posts-de-Discussão'), 'postsdediscussao');
  assert.equal(normalizarNome('  ÇÃO  '), 'cao');
  assert.equal(normalizarNome(undefined), '');
});

test('mesmoNome trata grafias equivalentes como o mesmo dataset', () => {
  assert.ok(mesmoNome('Usuarios', 'Usuários'));
  assert.ok(mesmoNome('Unidades_organizacionais', 'Unidades organizacionais'));
  assert.ok(!mesmoNome('Usuários', 'Unidades organizacionais'));
});

const schemas = {
  _instrucoes: 'texto',
  Users: { tabela: 'users', aliases: ['Usuários'], colunas: { UserId: 'INT' } },
  OrganizationalUnits: { tabela: 'organizationalunits', colunas: { OrgUnitId: 'INT' } },
  notas_finais: { tabela: 'notas_finais', colunas: { x: 'INT' } },
};

test('casa por chave exata (comportamento antigo, sem aliases)', () => {
  assert.equal(encontrarSchema('OrganizationalUnits', schemas).chave, 'OrganizationalUnits');
  assert.equal(encontrarSchema('notas_finais', schemas).chave, 'notas_finais');
});

test('casa por chave normalizada', () => {
  assert.equal(encontrarSchema('organizational_units', schemas).chave, 'OrganizationalUnits');
  assert.equal(encontrarSchema('users', schemas).chave, 'Users');
});

test('casa por alias, com e sem acento', () => {
  assert.equal(encontrarSchema('Usuários', schemas).chave, 'Users');
  assert.equal(encontrarSchema('Usuarios', schemas).chave, 'Users');
  assert.equal(encontrarSchema('USUARIOS', schemas).schema.tabela, 'users');
});

test('retorna null quando não há schema e ignora chaves com "_"', () => {
  assert.equal(encontrarSchema('Desconhecido', schemas), null);
  assert.equal(encontrarSchema('_instrucoes', schemas), null);
  assert.equal(encontrarSchema('qualquer', {}), null);
});

test('config/schemas.json real casa os BDS que têm schema fixo (pelos aliases em português)', () => {
  const raiz = path.join(__dirname, '..');
  const reais = JSON.parse(fs.readFileSync(path.join(raiz, 'config/schemas.json'), 'utf8'));
  const selecao = JSON.parse(fs.readFileSync(path.join(raiz, 'config/bds-selecao.json'), 'utf8'));
  // Os demais datasets da seleção não têm schema de propósito (carregados como TEXT)
  for (const nome of ['Usuários', 'Unidades organizacionais', 'Objetos de nota', 'Posts de discussão']) {
    assert.ok(selecao.automaticos.includes(nome), `"${nome}" deveria estar em bds-selecao.json`);
    assert.ok(encontrarSchema(nome, reais), `sem schema para "${nome}"`);
  }
});

// ── Tarefa: sugestões de nomes BDS ─────────────────────────────────
const { distanciaEdicao, sugerirNomes, nomesNaoEncontrados } = require('../src/utils/nomes');

test('normalização colapsa espaços, _ e - repetidos', () => {
  assert.equal(normalizarNome('Log  de__acesso -- ao curso'), normalizarNome('Log de acesso ao curso'));
  assert.ok(mesmoNome('LOG DE ACESSO AO SISTEMA', 'Log de acesso ao sistema'));
  assert.ok(mesmoNome('Inscricoes de usuario', 'Inscrições de usuário'));
});

test('distanciaEdicao', () => {
  assert.equal(distanciaEdicao('', 'abc'), 3);
  assert.equal(distanciaEdicao('abc', 'abc'), 0);
  assert.equal(distanciaEdicao('kitten', 'sitting'), 3);
});

const NOMES_API = [
  'Biblioteca de Perguntas do Questionário',
  'Objetos de Pesquisa',
  'Resultados de nota',
  'Premiações Emitidas',
  'Usuários',
  'Unidades Organizacionais',
];

test('sugerirNomes prioriza nomes que contêm o termo', () => {
  assert.deepEqual(sugerirNomes('Biblioteca de perguntas', NOMES_API), ['Biblioteca de Perguntas do Questionário']);
});

test('sugerirNomes usa distância de edição para grafias próximas', () => {
  assert.deepEqual(sugerirNomes('Resultados das notas', NOMES_API), ['Resultados de nota']);
  assert.deepEqual(sugerirNomes('Objeto de pesquisas', NOMES_API), ['Objetos de Pesquisa']);
});

test('sugerirNomes retorna no máximo 3 e lista vazia quando nada é parecido', () => {
  const muitos = ['Log A', 'Log B', 'Log C', 'Log D'];
  assert.equal(sugerirNomes('Log', muitos).length, 3);
  assert.deepEqual(sugerirNomes('Xyzzy completamente diferente', NOMES_API), []);
  assert.deepEqual(sugerirNomes('', NOMES_API), []);
});

test('nomesNaoEncontrados lista só os ausentes, com sugestões, sem interromper os demais', () => {
  const r = nomesNaoEncontrados(['Usuarios', 'Biblioteca de perguntas', 'premiacoes emitidas'], NOMES_API);
  assert.deepEqual(r, [{ nome: 'Biblioteca de perguntas', sugestoes: ['Biblioteca de Perguntas do Questionário'] }]);
});
