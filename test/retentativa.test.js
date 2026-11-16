'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { comRetentativa, deveRepetir, erroDefinitivo } = require('../src/utils/retentativa');

const semEspera = { esperaMs: 0 };

test('sucesso na primeira tentativa não repete', async () => {
  let chamadas = 0;
  const r = await comRetentativa(async () => { chamadas++; return 'ok'; }, semEspera);
  assert.deepEqual(r, { valor: 'ok', tentativas: 1 });
  assert.equal(chamadas, 1);
});

test('falha na primeira e sucesso na segunda tentativa', async () => {
  const falhas = [];
  const r = await comRetentativa(
    async (t) => { if (t === 1) throw new Error('ECONNRESET'); return 'ok'; },
    { ...semEspera, aoFalhar: (f) => falhas.push(f) }
  );
  assert.deepEqual(r, { valor: 'ok', tentativas: 2 });
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0].vaiRepetir, true);
  assert.equal(falhas[0].tentativa, 1);
});

test('padrão: 2 tentativas no total — lança o último erro com .tentativas', async () => {
  let chamadas = 0;
  await assert.rejects(
    comRetentativa(async () => { chamadas++; throw new Error(`falha ${chamadas}`); }, semEspera),
    (e) => e.message === 'falha 2' && e.tentativas === 2
  );
  assert.equal(chamadas, 2);
});

test('espera entre as tentativas', async () => {
  const esperas = [];
  await assert.rejects(comRetentativa(
    async () => { throw new Error('x'); },
    { tentativas: 2, esperaMs: 1234, dormir: async (ms) => esperas.push(ms) }
  ));
  assert.deepEqual(esperas, [1234]);
});

test('erros definitivos não são repetidos', async () => {
  for (const erro of [
    erroDefinitivo('Relatório "X" não encontrado'),
    Object.assign(new Error('HTTP 400: filtro inválido'), { status: 400 }),
    Object.assign(new Error('HTTP 403'), { status: 403 }),
    new Error('Refresh token inválido ou expirado. Execute o setup'),
  ]) {
    let chamadas = 0;
    await assert.rejects(
      comRetentativa(async () => { chamadas++; throw erro; }, semEspera),
      (e) => e.tentativas === 1
    );
    assert.equal(chamadas, 1, erro.message);
  }
});

test('deveRepetir: rede, 5xx, 404 e timeout são repetidos', () => {
  assert.equal(deveRepetir(new Error('socket hang up')), true);
  assert.equal(deveRepetir(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(deveRepetir(Object.assign(new Error('HTTP 404 ao baixar'), { status: 404 })), true);
  assert.equal(deveRepetir(new Error('Timeout após 30 minutos.')), true);
});
