'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { atualizarPeriodos, lerArgsRelatorios } = require('../src/utils/ads-periodo');

const CONFIG = {
  _instrucoes: '...',
  'Uso do Aluno': { ativo: true, startDate: '2026-01-01T00:00:00.000Z', endDate: 'agora', roles: ['110'] },
  'Notas finais': { ativo: true, startDate: '2026-01-01T00:00:00.000Z', endDate: 'agora' },
  'Sem datas': { ativo: true, parentOrgUnitId: '6606' },
};

test('atualizarPeriodos: altera startDate de todos que têm a chave, sem mexer no resto', () => {
  const { config, alterados } = atualizarPeriodos(CONFIG, { startDate: '2026-08-01' });
  assert.equal(config['Uso do Aluno'].startDate, '2026-08-01');
  assert.equal(config['Notas finais'].startDate, '2026-08-01');
  assert.equal(config['Uso do Aluno'].endDate, 'agora');
  assert.deepEqual(config['Uso do Aluno'].roles, ['110']);
  assert.equal(config['Sem datas'].startDate, undefined);
  assert.equal(config._instrucoes, '...');
  assert.equal(alterados.length, 2);
  assert.equal(CONFIG['Uso do Aluno'].startDate, '2026-01-01T00:00:00.000Z'); // não muta a entrada
});

test('atualizarPeriodos: --so restringe aos relatórios (nome normalizado)', () => {
  const { config, alterados } = atualizarPeriodos(CONFIG, { startDate: '-30d', endDate: 'hoje' }, ['uso do aluno']);
  assert.equal(config['Uso do Aluno'].startDate, '-30d');
  assert.equal(config['Notas finais'].startDate, '2026-01-01T00:00:00.000Z');
  assert.equal(alterados.length, 2);
});

test('atualizarPeriodos: relatório inexistente ou período invertido → erro', () => {
  assert.throws(() => atualizarPeriodos(CONFIG, { startDate: 'hoje' }, ['Uso do Alno']), /não encontrado.*Uso do Aluno/);
  assert.throws(() => atualizarPeriodos({ X: { startDate: 'hoje', endDate: '2020-01-01' } }, { startDate: '2026-01-01' }), /nada foi gravado/);
});

test('lerArgsRelatorios: --so com vírgulas e --so=', () => {
  assert.equal(lerArgsRelatorios(['--inicio', 'hoje']), null);
  assert.deepEqual(lerArgsRelatorios(['--so', 'Uso do Aluno, Notas finais']), ['Uso do Aluno', 'Notas finais']);
  assert.deepEqual(lerArgsRelatorios(['--so=Notas finais']), ['Notas finais']);
  assert.throws(() => lerArgsRelatorios(['--so']), /precisa do nome/);
});
