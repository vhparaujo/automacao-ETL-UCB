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

test('config/schemas.json real casa os nomes de config/bds-selecao.json', () => {
  const raiz = path.join(__dirname, '..');
  const reais = JSON.parse(fs.readFileSync(path.join(raiz, 'config/schemas.json'), 'utf8'));
  const selecao = JSON.parse(fs.readFileSync(path.join(raiz, 'config/bds-selecao.json'), 'utf8'));
  for (const nome of selecao.automaticos) {
    assert.ok(encontrarSchema(nome, reais), `sem schema para "${nome}"`);
  }
});
