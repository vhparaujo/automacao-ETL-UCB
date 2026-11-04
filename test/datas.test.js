'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolverData, resolverPeriodo } = require('../src/utils/datas');

// Datas de referência fixas (06:00Z ≈ 03:00 em Brasília, horário do cron)
const REF_NOV = new Date('2026-11-04T06:00:00.000Z');
const REF_JAN = new Date('2026-01-01T06:00:00.000Z');
const REF_JUN = new Date('2026-06-30T23:30:00.000Z');
const REF_JUL = new Date('2026-07-01T00:30:00.000Z');
const REF_DEZ = new Date('2026-12-31T23:59:00.000Z');

test('datas ISO absolutas com Z são mantidas como estão', () => {
  assert.equal(resolverData('2025-01-01T00:00:00.000Z', 'inicio', REF_NOV), '2025-01-01T00:00:00.000Z');
  assert.equal(resolverData('2025-12-31T23:59:59.999Z', 'fim', REF_NOV), '2025-12-31T23:59:59.999Z');
});

test('datas ISO com offset são convertidas para UTC com Z', () => {
  assert.equal(resolverData('2026-01-01T00:00:00-03:00', 'inicio', REF_NOV), '2026-01-01T03:00:00.000Z');
});

test('"hoje" vira início ou fim do dia conforme o campo', () => {
  assert.equal(resolverData('hoje', 'inicio', REF_NOV), '2026-11-04T00:00:00.000Z');
  assert.equal(resolverData('hoje', 'fim', REF_NOV), '2026-11-04T23:59:59.999Z');
  assert.equal(resolverData(' HOJE ', 'fim', REF_NOV), '2026-11-04T23:59:59.999Z');
});

test('"-Nd" retorna N dias atrás', () => {
  assert.equal(resolverData('-180d', 'inicio', REF_NOV), '2026-05-08T00:00:00.000Z');
  assert.equal(resolverData('-1d', 'fim', REF_NOV), '2026-11-03T23:59:59.999Z');
  assert.equal(resolverData('-0d', 'inicio', REF_NOV), '2026-11-04T00:00:00.000Z');
});

test('"-Nd" atravessa a virada de ano', () => {
  assert.equal(resolverData('-1d', 'inicio', REF_JAN), '2025-12-31T00:00:00.000Z');
  assert.equal(resolverData('-365d', 'fim', REF_JAN), '2025-01-01T23:59:59.999Z');
});

test('inicio_ano / fim_ano do ano corrente', () => {
  assert.equal(resolverData('inicio_ano', 'inicio', REF_NOV), '2026-01-01T00:00:00.000Z');
  assert.equal(resolverData('fim_ano', 'fim', REF_NOV), '2026-12-31T23:59:59.999Z');
  assert.equal(resolverData('inicio_ano', 'inicio', REF_DEZ), '2026-01-01T00:00:00.000Z');
  assert.equal(resolverData('fim_ano', 'fim', REF_JAN), '2026-12-31T23:59:59.999Z');
});

test('semestre 1 (jan–jun), inclusive no último dia de junho', () => {
  for (const ref of [REF_JAN, REF_JUN]) {
    assert.equal(resolverData('inicio_semestre', 'inicio', ref), '2026-01-01T00:00:00.000Z');
    assert.equal(resolverData('fim_semestre', 'fim', ref), '2026-06-30T23:59:59.999Z');
  }
});

test('semestre 2 (jul–dez), da virada de semestre ao fim do ano', () => {
  for (const ref of [REF_JUL, REF_NOV, REF_DEZ]) {
    assert.equal(resolverData('inicio_semestre', 'inicio', ref), '2026-07-01T00:00:00.000Z');
    assert.equal(resolverData('fim_semestre', 'fim', ref), '2026-12-31T23:59:59.999Z');
  }
});

test('expressão inválida gera erro claro', () => {
  assert.throws(() => resolverData('ontem', 'inicio', REF_NOV), /Expressão de data inválida: "ontem"/);
  assert.throws(() => resolverData('-10x', 'inicio', REF_NOV), /Expressão de data inválida/);
  assert.throws(() => resolverData('', 'fim', REF_NOV), /Expressão de data inválida/);
  assert.throws(() => resolverData('hoje', 'meio', REF_NOV), /Campo de data inválido/);
});

test('resolverPeriodo resolve os dois campos e mantém os demais ausentes', () => {
  assert.deepEqual(resolverPeriodo({ startDate: 'inicio_semestre', endDate: 'hoje' }, REF_NOV), {
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-11-04T23:59:59.999Z',
  });
  assert.deepEqual(resolverPeriodo({}, REF_NOV), {});
});

test('resolverPeriodo rejeita período invertido', () => {
  assert.throws(() => resolverPeriodo({ startDate: 'hoje', endDate: '-30d' }, REF_NOV), /Período inválido/);
});
