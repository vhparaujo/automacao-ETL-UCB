'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  selecionarDiferencialDoDia, pastaDiferencial, registrarNoManifesto, lerManifesto,
} = require('../src/utils/bds-diferencial');

const ext = (criado, extra = {}) => ({ CreatedDate: criado, DownloadLink: `https://x/${criado}`, ...extra });

// 12/11/2026 06:00 em Brasília = 09:00Z
const AGORA = new Date('2026-11-12T09:00:00.000Z');
const COMPLETO = '2026-11-09T11:20:52.000Z';

test('selecionarDiferencialDoDia: só o mais recente, se for de hoje; informa o anterior', () => {
  const lista = [
    ext('2026-11-10T08:21:03.000Z'),
    ext('2026-11-12T08:21:08.000Z'),
    ext('2026-11-11T08:21:08.000Z'),
  ];
  const r = selecionarDiferencialDoDia(lista, COMPLETO, AGORA);
  assert.equal(r.criado, '2026-11-12T08:21:08.000Z');
  assert.equal(r.anterior, '2026-11-11T08:21:08.000Z');
  assert.equal(r.extract.DownloadLink, 'https://x/2026-11-12T08:21:08.000Z');
});

test('selecionarDiferencialDoDia: o de hoje ainda não saiu → não baixa os antigos', () => {
  const lista = [ext('2026-11-11T08:21:08.000Z'), ext('2026-11-10T08:21:03.000Z')];
  const r = selecionarDiferencialDoDia(lista, COMPLETO, AGORA);
  assert.equal(r.extract, undefined);
  assert.match(r.motivo, /ainda não foi gerado/);
});

test('selecionarDiferencialDoDia: "hoje" no fuso de Brasília (02:00Z ainda é o dia anterior)', () => {
  const lista = [ext('2026-11-12T02:00:00.000Z')]; // 11/11 23h em Brasília
  assert.match(selecionarDiferencialDoDia(lista, null, AGORA).motivo, /ainda não foi gerado/);
  const r = selecionarDiferencialDoDia(lista, null, new Date('2026-11-12T02:30:00.000Z'));
  assert.equal(r.criado, '2026-11-12T02:00:00.000Z');
  assert.equal(r.anterior, null);
});

test('selecionarDiferencialDoDia: segunda depois do completo → já está no completo', () => {
  const lista = [ext('2026-11-09T08:21:00.000Z')];
  const r = selecionarDiferencialDoDia(lista, COMPLETO, new Date('2026-11-09T13:00:00.000Z'));
  assert.match(r.motivo, /já está no completo/);
  // Segunda 6h: o completo mais recente ainda é o da semana anterior → baixa
  const cedo = selecionarDiferencialDoDia(lista, '2026-11-02T11:20:00.000Z', new Date('2026-11-09T09:00:00.000Z'));
  assert.equal(cedo.criado, '2026-11-09T08:21:00.000Z');
});

test('selecionarDiferencialDoDia: descarta sem data/sem link; aceita QueuedForProcessingDate; lista vazia', () => {
  const lista = [
    { DownloadLink: 'https://x/semdata' },
    { CreatedDate: '2026-11-12T08:30:00.000Z' }, // sem DownloadLink
    { QueuedForProcessingDate: '2026-11-12T08:00:00.000Z', DownloadLink: 'https://x/q' },
  ];
  assert.equal(selecionarDiferencialDoDia(lista, COMPLETO, AGORA).criado, '2026-11-12T08:00:00.000Z');
  assert.match(selecionarDiferencialDoDia(undefined, null, AGORA).motivo, /nenhum diferencial/);
});

test('manifesto do diferencial: fica em csvs/diferencial/ e o download do dia seguinte sobrescreve', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dif-'));
  const pasta = pastaDiferencial(tmp);
  fs.mkdirSync(pasta, { recursive: true });
  registrarNoManifesto(pasta, [path.join(pasta, 'Users.csv')], { tipo: 'Differential', criado: '2026-11-12T08:21:08.000Z' });
  registrarNoManifesto(pasta, [path.join(pasta, 'Users.csv')], { tipo: 'Differential', criado: '2026-11-13T08:21:08.000Z' });
  assert.equal(pasta, path.join(tmp, 'diferencial'));
  assert.equal(lerManifesto(pasta)['Users.csv'].criado, '2026-11-13T08:21:08.000Z');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('manifesto dos completos: grava por nome de arquivo e acumula', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'man-'));
  registrarNoManifesto(tmp, [path.join(tmp, 'Users.csv')], { dataset: 'Usuários', tipo: 'Full', criado: 'x' });
  registrarNoManifesto(tmp, [path.join(tmp, 'GradeObjects.csv')], { dataset: 'Objetos de nota', tipo: 'Full', criado: 'y' });
  const m = lerManifesto(tmp);
  assert.equal(m['Users.csv'].dataset, 'Usuários');
  assert.equal(m['GradeObjects.csv'].criado, 'y');
  assert.deepEqual(lerManifesto(path.join(tmp, 'nada')), {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
