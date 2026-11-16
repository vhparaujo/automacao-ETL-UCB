'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLinhaCSV } = require('../src/utils/csv');

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
