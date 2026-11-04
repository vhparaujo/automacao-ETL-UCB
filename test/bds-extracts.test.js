'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selecionarExtractMaisRecente } = require('../src/utils/bds-extracts');

test('lista desordenada: escolhe o de CreatedDate mais recente', () => {
  const lista = [
    { DownloadLink: 'a', CreatedDate: '2026-11-02T04:00:00.000Z' },
    { DownloadLink: 'b', CreatedDate: '2026-11-04T04:00:00.000Z' },
    { DownloadLink: 'c', CreatedDate: '2026-11-03T04:00:00.000Z' },
  ];
  const r = selecionarExtractMaisRecente(lista);
  assert.equal(r.extract.DownloadLink, 'b');
  assert.equal(r.data, '2026-11-04T04:00:00.000Z');
  assert.equal(r.semDatas, false);
  assert.equal(lista[0].DownloadLink, 'a', 'não deve modificar a lista original');
});

test('usa QueuedForProcessingDate quando CreatedDate não existe', () => {
  const r = selecionarExtractMaisRecente([
    { DownloadLink: 'a', QueuedForProcessingDate: '2026-01-01T00:00:00Z' },
    { DownloadLink: 'b', QueuedForProcessingDate: '2026-02-01T00:00:00Z' },
  ]);
  assert.equal(r.extract.DownloadLink, 'b');
});

test('itens sem data ficam atrás dos que têm data', () => {
  const r = selecionarExtractMaisRecente([
    { DownloadLink: 'sem-data' },
    { DownloadLink: 'com-data', CreatedDate: '2020-01-01T00:00:00Z' },
  ]);
  assert.equal(r.extract.DownloadLink, 'com-data');
});

test('lista sem datas: mantém a ordem original e sinaliza semDatas', () => {
  const r = selecionarExtractMaisRecente([{ DownloadLink: 'primeiro' }, { DownloadLink: 'segundo', CreatedDate: 'lixo' }]);
  assert.equal(r.extract.DownloadLink, 'primeiro');
  assert.equal(r.data, null);
  assert.equal(r.semDatas, true);
});

test('lista vazia ou ausente retorna extract null', () => {
  for (const entrada of [[], undefined, null]) {
    const r = selecionarExtractMaisRecente(entrada);
    assert.equal(r.extract, null);
    assert.equal(r.semDatas, false);
  }
});
