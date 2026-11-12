'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  selecionarDiferencialDoDia, pastaDiferencial, listarDiferenciais, registrarNoManifesto, lerManifesto,
  encontrarChave, decidirAplicacao, montarSqlMerge, nomeStaging,
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

test('listarDiferenciais: CSVs direto em diferencial/, ordem cronológica pelo manifesto', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dif-'));
  const pasta = pastaDiferencial(tmp);
  fs.mkdirSync(path.join(pasta, 'subpasta'), { recursive: true }); // subpastas são ignoradas
  for (const n of ['Users.csv', 'GradeObjects.csv', 'SemRegistro.csv', 'notas.txt']) fs.writeFileSync(path.join(pasta, n), 'x\n');
  registrarNoManifesto(pasta, [path.join(pasta, 'Users.csv')], { tipo: 'Differential', criado: '2026-11-12T08:21:08.000Z' });
  registrarNoManifesto(pasta, [path.join(pasta, 'GradeObjects.csv')], { tipo: 'Differential', criado: '2026-11-12T08:21:00.000Z' });

  const r = listarDiferenciais(tmp);
  assert.deepEqual(r.map((x) => path.basename(x.csv)), ['SemRegistro.csv', 'GradeObjects.csv', 'Users.csv']);
  assert.equal(r[0].meta, null);
  assert.equal(r[2].meta.criado, '2026-11-12T08:21:08.000Z');
  // download do dia seguinte sobrescreve o registro do mesmo CSV
  registrarNoManifesto(pasta, [path.join(pasta, 'Users.csv')], { tipo: 'Differential', criado: '2026-11-13T08:21:08.000Z' });
  assert.equal(listarDiferenciais(tmp).find((x) => x.csv.endsWith('Users.csv')).meta.criado, '2026-11-13T08:21:08.000Z');
  assert.deepEqual(listarDiferenciais(path.join(tmp, 'nao-existe')), []);
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

test('encontrarChave: exato, normalizado e ignora comentários', () => {
  const chaves = { _x: 'comentário', Users: ['UserId'], UserEnrollments: ['OrgUnitId', 'UserId'] };
  assert.deepEqual(encontrarChave('Users', chaves), ['UserId']);
  assert.deepEqual(encontrarChave('user_enrollments', chaves), ['OrgUnitId', 'UserId']);
  assert.equal(encontrarChave('_x', chaves), null);
  assert.equal(encontrarChave('Outro', chaves), null);
});

test('decidirAplicacao: pula já aplicados e anteriores ao completo', () => {
  const estado = { completo_criado: '2026-11-09T11:20:52.000Z', diferencial_criado: '2026-11-11T08:21:08.000Z' };
  assert.equal(decidirAplicacao(estado, { criado: '2026-11-11T08:21:08.000Z' }).aplicar, false);
  assert.equal(decidirAplicacao(estado, { criado: '2026-11-10T08:21:08.000Z' }).aplicar, false);
  const anteriorAoCompleto = decidirAplicacao({ completo_criado: '2026-11-09T11:20:52.000Z' }, { criado: '2026-11-09T08:21:00.000Z' });
  assert.equal(anteriorAoCompleto.aplicar, false);
  assert.match(anteriorAoCompleto.motivo, /anterior ao completo/);

  const ok = decidirAplicacao(estado, { criado: '2026-11-12T08:21:08.000Z', base: '2026-11-09T11:20:52.000Z' });
  assert.deepEqual(ok, { aplicar: true, motivo: null, aviso: null });
});

test('decidirAplicacao: avisa lacuna quando o completo esperado não foi carregado', () => {
  const r = decidirAplicacao(
    { completo_criado: '2026-11-02T11:20:00.000Z' },
    { criado: '2026-11-10T08:21:00.000Z', base: '2026-11-09T11:20:52.000Z' }
  );
  assert.equal(r.aplicar, true);
  assert.match(r.aviso, /não foi carregado/);

  const semEstado = decidirAplicacao(null, { criado: '2026-11-10T08:21:00.000Z' });
  assert.equal(semEstado.aplicar, true);
  assert.match(semEstado.aviso, /sem registro do completo/);

  assert.equal(decidirAplicacao(null, {}).aplicar, false);
});

test('decidirAplicacao: avisa quando o diferencial anterior não foi aplicado', () => {
  const meta = { criado: '2026-11-12T08:21:08.000Z', base: COMPLETO, anterior: '2026-11-11T08:21:08.000Z' };
  // pulou o de 11/11 (último aplicado foi o de 10/11)
  const lacuna = decidirAplicacao({ completo_criado: COMPLETO, diferencial_criado: '2026-11-10T08:21:03.000Z' }, meta);
  assert.equal(lacuna.aplicar, true);
  assert.match(lacuna.aviso, /diferencial anterior .* não foi aplicado/);
  // nenhum diferencial desde o completo, e o anterior é depois dele → lacuna
  assert.match(decidirAplicacao({ completo_criado: COMPLETO }, meta).aviso, /não foi aplicado/);
  // anterior aplicado → sem aviso
  assert.equal(decidirAplicacao({ completo_criado: COMPLETO, diferencial_criado: meta.anterior }, meta).aviso, null);
  // anterior já coberto pelo completo (terça: o anterior é o de segunda 5h21) → sem aviso
  const terca = { criado: '2026-11-10T08:21:03.000Z', base: COMPLETO, anterior: '2026-11-09T08:21:00.000Z' };
  assert.equal(decidirAplicacao({ completo_criado: COMPLETO }, terca).aviso, null);
});

test('montarSqlMerge: DELETE … JOIN com <=> na chave + INSERT … SELECT', () => {
  const sql = montarSqlMerge('userenrollments', '_dif_userenrollments', ['OrgUnitId', 'UserId', 'RoleId'], ['OrgUnitId', 'UserId']);
  assert.equal(
    sql.apagar,
    'DELETE t FROM `userenrollments` t JOIN `_dif_userenrollments` s ON t.`OrgUnitId` <=> s.`OrgUnitId` AND t.`UserId` <=> s.`UserId`'
  );
  assert.equal(
    sql.inserir,
    'INSERT INTO `userenrollments` (`OrgUnitId`, `UserId`, `RoleId`) SELECT `OrgUnitId`, `UserId`, `RoleId` FROM `_dif_userenrollments`'
  );
  assert.throws(() => montarSqlMerge('t', 's', ['a'], []), /chave vazia/);
});

test('nomeStaging: prefixo _dif_ e no máximo 64 caracteres', () => {
  assert.equal(nomeStaging('users'), '_dif_users');
  assert.equal(nomeStaging('x'.repeat(80)).length, 64);
});
