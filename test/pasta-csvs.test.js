'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pasta-csvs-test-'));
const CSVS = path.join(TMP, 'csvs');
process.env.CSVS_DIR = CSVS; // antes de carregar o pipeline
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.EXPORTS_DIR = path.join(TMP, 'exports'); // o inventário do pipeline completo não pode tocar exports/ real

const { listarCsvs, arquivarCsvsAnteriores } = require('../src/utils/pasta-csvs');

// ── Mocks do pipeline ──────────────────────────────────────────────
const chamadas = [];
function mockarModulo(relativo, exportsFalsos) {
  const resolvido = require.resolve(path.join(RAIZ, relativo));
  require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: exportsFalsos };
}
mockarModulo('src/auth/oauth.js', { getAccessToken: async () => 'token' });
mockarModulo('src/extractors/bds.js', {
  download: async () => { chamadas.push('bds'); fs.writeFileSync(path.join(CSVS, 'Users.csv'), 'a\n'); return { baixados: 1, erros: 0 }; },
});
mockarModulo('src/extractors/ads.js', { download: async () => ({ processados: 0, erros: 0 }) });
const { executarPipeline } = require('../src/pipeline');

function prepararPasta() {
  fs.rmSync(CSVS, { recursive: true, force: true });
  fs.mkdirSync(path.join(CSVS, 'zips'), { recursive: true });
  fs.mkdirSync(path.join(CSVS, '_anterior'), { recursive: true });
  fs.writeFileSync(path.join(CSVS, '_anterior', 'muito_antigo.csv'), 'x\n');
  fs.writeFileSync(path.join(CSVS, 'zips', 'parcial.zip'), 'z');
  fs.writeFileSync(path.join(CSVS, 'antigo_sob_demanda.csv'), 'x\n');
  fs.writeFileSync(path.join(CSVS, 'GradeObjects.csv'), 'x\n');
  fs.writeFileSync(path.join(CSVS, 'notas.txt'), 'x');
}

async function silencioso(fn) {
  const orig = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
}

beforeEach(() => { chamadas.length = 0; prepararPasta(); });
after(async () => {
  await new Promise((r) => setTimeout(r, 200)); // WriteStream do log
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('listarCsvs ignora _anterior/, zips/ e arquivos que não são .csv', () => {
  assert.deepEqual(listarCsvs(CSVS).map((f) => path.basename(f)), ['GradeObjects.csv', 'antigo_sob_demanda.csv']);
  assert.deepEqual(listarCsvs(path.join(TMP, 'nao-existe')), []);
});

test('arquivarCsvsAnteriores move tudo para _anterior/, substitui o antigo e mantém zips/', () => {
  const movidos = arquivarCsvsAnteriores(CSVS);
  assert.deepEqual(movidos.sort(), ['GradeObjects.csv', 'antigo_sob_demanda.csv', 'notas.txt']);
  assert.deepEqual(listarCsvs(CSVS), []);
  assert.deepEqual(fs.readdirSync(path.join(CSVS, '_anterior')).sort(), ['GradeObjects.csv', 'antigo_sob_demanda.csv', 'notas.txt']);
  assert.ok(fs.existsSync(path.join(CSVS, 'zips', 'parcial.zip')));
});

test('pipeline completo arquiva csvs/ antes dos downloads', async () => {
  await silencioso(() => executarPipeline({ bds: true, ads: true, completo: true }));
  assert.deepEqual(listarCsvs(CSVS).map((f) => path.basename(f)), ['Users.csv']); // só o baixado agora
  assert.ok(fs.existsSync(path.join(CSVS, '_anterior', 'antigo_sob_demanda.csv')));
  assert.ok(!fs.existsSync(path.join(CSVS, '_anterior', 'muito_antigo.csv')), '_anterior antigo deve ser substituído');
});

test('execução parcial (--apenas-*) não mexe na pasta csvs/', async () => {
  await silencioso(() => executarPipeline({ bds: true, ads: false }));
  assert.ok(fs.existsSync(path.join(CSVS, 'antigo_sob_demanda.csv')));
  assert.ok(fs.existsSync(path.join(CSVS, '_anterior', 'muito_antigo.csv')));
});
