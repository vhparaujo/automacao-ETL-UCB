'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizarNome, mesmoNome } = require('../src/utils/nomes');

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
