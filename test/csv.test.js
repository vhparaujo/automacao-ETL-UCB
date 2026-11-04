'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLinhaCSV, nomesColunasUnicos } = require('../src/utils/csv');

test('cabeçalho simples', () => {
  assert.deepEqual(parseLinhaCSV('UserId,UserName,IsActive'), ['UserId', 'UserName', 'IsActive']);
});

test('campos entre aspas simples (sem vírgula) têm as aspas removidas', () => {
  assert.deepEqual(parseLinhaCSV('"UserId","UserName"'), ['UserId', 'UserName']);
});

test('campo com vírgula entre aspas não desalinha as colunas', () => {
  assert.deepEqual(parseLinhaCSV('Id,"Nota, ajustada",Final'), ['Id', 'Nota, ajustada', 'Final']);
});

test('aspas escapadas ("") viram aspa literal', () => {
  assert.deepEqual(parseLinhaCSV('Id,"Nome ""apelido""",X'), ['Id', 'Nome "apelido"', 'X']);
  assert.deepEqual(parseLinhaCSV('"a ""b"", c"'), ['a "b", c']);
});

test('remove BOM do início', () => {
  assert.deepEqual(parseLinhaCSV('﻿UserId,UserName'), ['UserId', 'UserName']);
  assert.deepEqual(parseLinhaCSV('﻿"UserId",UserName'), ['UserId', 'UserName']);
});

test('remove \\r final (linhas \\r\\n)', () => {
  assert.deepEqual(parseLinhaCSV('A,B,C\r'), ['A', 'B', 'C']);
  assert.deepEqual(parseLinhaCSV('A,"B"\r'), ['A', 'B']);
});

test('campos vazios são preservados', () => {
  assert.deepEqual(parseLinhaCSV('A,,C,'), ['A', '', 'C', '']);
});

test('nomes sem colisão continuam iguais (apenas truncados)', () => {
  const longo = 'x'.repeat(70);
  const { nomes, colisoes } = nomesColunasUnicos(['A', 'B', longo]);
  assert.deepEqual(nomes, ['A', 'B', 'x'.repeat(64)]);
  assert.equal(colisoes.length, 0);
});

test('colisão após truncamento para 64 caracteres recebe sufixo _2, _3', () => {
  const prefixo = 'P'.repeat(64);
  const cols = [`${prefixo}_primeiro`, `${prefixo}_segundo`, `${prefixo}_terceiro`];
  const { nomes, colisoes } = nomesColunasUnicos(cols);

  assert.equal(nomes[0], prefixo);
  assert.equal(nomes[1], 'P'.repeat(62) + '_2');
  assert.equal(nomes[2], 'P'.repeat(62) + '_3');
  assert.ok(nomes.every((n) => n.length <= 64));
  assert.equal(new Set(nomes).size, 3);
  assert.equal(colisoes.length, 2);
  assert.equal(colisoes[0].original, cols[1]);
});

test('colisão é case-insensitive (como no MySQL) e sufixo não colide com coluna existente', () => {
  const { nomes } = nomesColunasUnicos(['Nome', 'NOME', 'Nome_2']);
  assert.deepEqual(nomes, ['Nome', 'NOME_2', 'Nome_2_2']);
});
