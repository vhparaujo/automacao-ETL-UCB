'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const queriesExecutadas = [];
const exportacoes = [];

// Mocks: substitui mysql2/promise e o csv-exporter antes de carregar o engine
function mockarModulo(caminho, exportsFalsos) {
  const resolvido = require.resolve(caminho, { paths: [RAIZ] });
  require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: exportsFalsos };
}

mockarModulo('mysql2/promise', {
  createConnection: async () => ({
    query: async (sql) => { queriesExecutadas.push(sql.trim()); return [[]]; },
    end: async () => {},
  }),
});
mockarModulo(path.join(RAIZ, 'src/exporter/csv-exporter.js'), {
  exportarQuery: async (_c, _sql, saida) => { exportacoes.push(saida); return 3; },
});

const { run } = require('../src/transforms/engine');

let dirOriginal, dirTmp;

before(() => {
  dirOriginal = process.cwd();
  dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
  fs.mkdirSync(path.join(dirTmp, 'config'));
  fs.mkdirSync(path.join(dirTmp, 'q'));
  fs.writeFileSync(path.join(dirTmp, 'q/view.sql'), 'SELECT 1 -- view');
  fs.writeFileSync(path.join(dirTmp, 'q/tabela.sql'), 'SELECT 2 -- table');
  fs.writeFileSync(path.join(dirTmp, 'q/export.sql'), 'SELECT 3 -- export');
  fs.writeFileSync(path.join(dirTmp, 'config/transforms.json'), JSON.stringify({
    transformacoes: [
      { nome: 'view_a', arquivo: 'q/view.sql', tipo: 'view' },
      { nome: 'tabela_b', arquivo: 'q/tabela.sql', tipo: 'table' },
      { nome: 'export_c', arquivo: 'q/export.sql', tipo: 'exportar_csv', arquivo_saida: 'exports/c.csv' },
      { nome: 'view_quebrada', arquivo: 'q/nao-existe.sql', tipo: 'view' },
    ],
  }));
  process.chdir(dirTmp);
});

after(() => {
  process.chdir(dirOriginal);
  fs.rmSync(dirTmp, { recursive: true, force: true });
});

test('exportarCsvs = false pula exportar_csv e mantém view/table', async () => {
  queriesExecutadas.length = 0; exportacoes.length = 0;
  const r = await run({ exportarCsvs: false });
  assert.equal(r.puladas, 1);
  assert.equal(r.executadas, 2);
  assert.equal(r.erros, 1);
  assert.deepEqual(r.views, ['view_a']);
  assert.deepEqual(exportacoes, []);
  assert.equal(queriesExecutadas.length, 2);
});

test('exportarCsvs = true executa as exportações', async () => {
  queriesExecutadas.length = 0; exportacoes.length = 0;
  const r = await run({ exportarCsvs: true });
  assert.equal(r.puladas, 0);
  assert.equal(r.executadas, 3);
  assert.deepEqual(exportacoes, ['exports/c.csv']);
  assert.deepEqual(r.views, ['view_a'], 'view com erro não entra na lista');
});

test('sem opção explícita, lê pipeline.exportar_csvs de config/schedule.json', async () => {
  fs.writeFileSync('config/schedule.json', JSON.stringify({ pipeline: { exportar_csvs: false } }));
  exportacoes.length = 0;
  const r = await run();
  assert.equal(r.puladas, 1);
  assert.deepEqual(exportacoes, []);
  fs.unlinkSync('config/schedule.json');
});

// ── --so: rodar só as transformações pedidas ───────────────────────
const { lerArgsSomente, selecionarTransformacoes } = require('../src/transforms/engine');

test('lerArgsSomente aceita --so x, --so=x, vírgulas e repetição', () => {
  assert.equal(lerArgsSomente(['--apenas-transform']), null);
  assert.deepEqual(lerArgsSomente(['--apenas-transform', '--so', 'vw_a']), ['vw_a']);
  assert.deepEqual(lerArgsSomente(['--so=vw_a,vw_b']), ['vw_a', 'vw_b']);
  assert.deepEqual(lerArgsSomente(['--so', 'vw_a', '--so', 'vw_b']), ['vw_a', 'vw_b']);
  assert.throws(() => lerArgsSomente(['--so']), /precisa do nome/);
  assert.throws(() => lerArgsSomente(['--so', '--apenas-transform']), /precisa do nome/);
});

test('selecionarTransformacoes: inclui inativa pedida, mantém ordem do config e sugere nomes', () => {
  const lista = [
    { nome: 'vw_a', ativo: true },
    { nome: 'vw_b', ativo: false },
    { nome: 'export_c' },
  ];
  assert.deepEqual(selecionarTransformacoes(lista, null).selecionadas.map((t) => t.nome), ['vw_a', 'export_c']);

  const r = selecionarTransformacoes(lista, ['export_c', 'vw_b']);
  assert.deepEqual(r.selecionadas.map((t) => t.nome), ['vw_b', 'export_c']);
  assert.deepEqual(r.inativas, ['vw_b']);

  assert.throws(() => selecionarTransformacoes(lista, ['vw_x']), /não encontrada.*"vw_x" \(parecidos: vw_a, vw_b/);
});

test('run({ somente }) executa só a pedida e ignora exportar_csvs = false do schedule', async () => {
  fs.writeFileSync('config/schedule.json', JSON.stringify({ pipeline: { exportar_csvs: false } }));
  queriesExecutadas.length = 0; exportacoes.length = 0;
  const r = await run({ somente: ['export_c'] });
  assert.equal(r.executadas, 1);
  assert.equal(r.puladas, 0);
  assert.deepEqual(exportacoes, ['exports/c.csv']);
  assert.equal(queriesExecutadas.length, 0);
  fs.unlinkSync('config/schedule.json');
});

test('run({ somente }) com nome inexistente lança erro antes de conectar', async () => {
  await assert.rejects(run({ somente: ['nao_existe'] }), /não encontrada/);
});
