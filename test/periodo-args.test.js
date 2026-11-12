'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolverData, lerArgsPeriodo } = require('../src/utils/datas');

const REF = new Date('2026-11-04T06:00:00.000Z');

test('data simples YYYY-MM-DD vira início ou fim do dia (UTC)', () => {
  assert.equal(resolverData('2026-08-01', 'inicio', REF), '2026-08-01T00:00:00.000Z');
  assert.equal(resolverData('2026-09-30', 'fim', REF), '2026-09-30T23:59:59.999Z');
  assert.throws(() => resolverData('2026-02-30', 'inicio', REF), /Data inválida/);
});

test('lerArgsPeriodo: sem flags retorna null', () => {
  assert.equal(lerArgsPeriodo(['--apenas-ads'], REF), null);
});

test('lerArgsPeriodo: aceita "--flag valor" e "--flag=valor", inclusive -Nd', () => {
  assert.deepEqual(lerArgsPeriodo(['--apenas-ads', '--inicio', '2026-08-01'], REF), { startDate: '2026-08-01' });
  assert.deepEqual(lerArgsPeriodo(['--inicio', '-30d', '--fim=hoje'], REF), { startDate: '-30d', endDate: 'hoje' });
  assert.deepEqual(lerArgsPeriodo(['--fim', 'agora'], REF), { endDate: 'agora' });
});

test('lerArgsPeriodo: valor ausente, inválido ou período invertido → erro', () => {
  assert.throws(() => lerArgsPeriodo(['--inicio'], REF), /precisa de uma data/);
  assert.throws(() => lerArgsPeriodo(['--inicio', '--apenas-ads'], REF), /precisa de uma data/);
  assert.throws(() => lerArgsPeriodo(['--inicio', 'ontem'], REF), /Expressão de data inválida/);
  assert.throws(() => lerArgsPeriodo(['--inicio', '2026-10-01', '--fim', '2026-09-01'], REF), /Período inválido/);
});
