'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { definirColunasSemSchema, mesmaEstrutura, tipoColuna } = require('../src/loader/mysql-loader');

const COLUNAS = ['UserId', 'ID definido da organização', 'Data de acesso', 'IsActive', 'Nome'];

test('sem schema: todas as colunas TEXT por padrão', () => {
  const cols = definirColunasSemSchema(COLUNAS);
  assert.deepEqual(cols.map((c) => c.tipo), ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT']);
  assert.deepEqual(cols.map((c) => c.nome), COLUNAS);
});

test('com INFERIR_TIPOS=true: usa tipoColuna() (comportamento antigo)', () => {
  const cols = definirColunasSemSchema(COLUNAS, true);
  assert.deepEqual(cols.map((c) => c.tipo), COLUNAS.map(tipoColuna));
  assert.equal(tipoColuna('ID definido da organização'), 'INT'); // o risco que motivou o TEXT padrão
});

test('mesmaEstrutura compara nomes (sem caixa) e tipos', () => {
  const esperada = definirColunasSemSchema(['A', 'B']);
  assert.ok(mesmaEstrutura([{ COLUMN_NAME: 'a', COLUMN_TYPE: 'text' }, { COLUMN_NAME: 'B', COLUMN_TYPE: 'TEXT' }], esperada));
  assert.ok(!mesmaEstrutura([{ COLUMN_NAME: 'A', COLUMN_TYPE: 'int' }, { COLUMN_NAME: 'B', COLUMN_TYPE: 'text' }], esperada));
  assert.ok(!mesmaEstrutura([{ COLUMN_NAME: 'A', COLUMN_TYPE: 'text' }], esperada));
  assert.ok(!mesmaEstrutura([], esperada));
});

// ── Booleanos TRUE/FALSE e casamento cabeçalho × schema ────────────
const fs = require('node:fs');
const path = require('node:path');
const { ehBooleano, expressaoValor, planejarColunasSchema } = require('../src/loader/mysql-loader');

test('ehBooleano reconhece TINYINT(1)/BOOL/BOOLEAN e não confunde TINYINT', () => {
  for (const t of ['TINYINT(1)', 'tinyint(1)', 'TINYINT( 1 )', 'BOOL', 'boolean']) assert.ok(ehBooleano(t), t);
  for (const t of ['TINYINT', 'TINYINT(4)', 'INT', 'TEXT', 'VARCHAR(1)']) assert.ok(!ehBooleano(t), t);
});

test('expressaoValor: booleano converte TRUE/FALSE (qualquer caixa); demais só NULLIF', () => {
  const b = expressaoValor('@col_3', 'TINYINT(1)');
  assert.match(b, /UPPER\(TRIM\(@col_3\)\)/);
  assert.match(b, /WHEN 'TRUE' THEN 1/);
  assert.match(b, /WHEN 'FALSE' THEN 0/);
  assert.match(b, /WHEN '' THEN NULL/);
  assert.match(b, /ELSE @col_3 END$/);
  assert.equal(expressaoValor('@col_0', 'INT'), "NULLIF(@col_0, '')");
  assert.equal(expressaoValor('@col_0', 'TEXT'), "NULLIF(@col_0, '')");
});

test('planejarColunasSchema: casa por nome (exato ou normalizado), segue a ordem do schema e aponta divergências', () => {
  const cabecalho = ['UserId', 'IsActive', 'CreationDate', 'Id do usuario', 'Extra'];
  const schema = { 'ID do Usuário': 'INT', UserId: 'INT', IsActive: 'TINYINT(1)', LastAccessed: 'DATETIME' };
  const p = planejarColunasSchema(cabecalho, schema);
  assert.deepEqual(p.definicoes.map((d) => d.nome), ['ID do Usuário', 'UserId', 'IsActive', 'LastAccessed']);
  assert.deepEqual(p.mapeamento, [
    { indice: 0, nome: 'UserId', tipo: 'INT' },
    { indice: 1, nome: 'IsActive', tipo: 'TINYINT(1)' },
    { indice: 3, nome: 'ID do Usuário', tipo: 'INT' },
  ]);
  assert.deepEqual(p.ausentes, ['LastAccessed']);
  assert.deepEqual(p.ignoradas, ['CreationDate', 'Extra']);
});

test('planejarColunasSchema: { tipo, coluna } renomeia; nome longo sem "coluna" é truncado em 64', () => {
  const longo = 'Data de conclusão do último Modelo de referência do objeto de courseware compartilhável';
  const outro = 'Data da última visita ao Modelo de referência do objeto de courseware compartilhável';
  const p = planejarColunasSchema([longo, outro], {
    [longo]: { tipo: 'DATETIME', coluna: 'Data de conclusão do último SCORM' },
    [outro]: 'DATETIME',
  });
  assert.equal(p.definicoes[0].nome, 'Data de conclusão do último SCORM');
  assert.equal(p.definicoes[1].nome, outro.slice(0, 64));
  assert.deepEqual(p.mapeamento.map((m) => m.indice), [0, 1]);
  assert.throws(() => planejarColunasSchema(['a'], { a: { coluna: 'x' } }), /coluna "a" inválida/);
});

test('config/schemas.json: tipos válidos e nomes de coluna da tabela ≤ 64 caracteres', () => {
  const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config/schemas.json'), 'utf8'));
  for (const [chave, entrada] of Object.entries(schemas)) {
    if (chave.startsWith('_')) continue;
    const p = planejarColunasSchema(Object.keys(entrada.colunas), entrada.colunas);
    assert.deepEqual(p.ausentes, [], chave);
    for (const d of p.definicoes) {
      assert.ok([...d.nome].length <= 64, `${chave}: "${d.nome}" > 64`);
      assert.match(d.tipo, /^(INT|BIGINT|TEXT|DATE|DATETIME|TINYINT\(1\)|VARCHAR\(\d+\)|DECIMAL\(\d+,\d+\))$/, `${chave}.${d.nome}`);
    }
    // Version do Brightspace passa de 2.147.483.647 (limite do INT)
    if (entrada.colunas.Version) assert.equal(entrada.colunas.Version, 'BIGINT', `${chave}.Version`);
  }
});

// ── Índices declarados em schemas.json ─────────────────────────────
const { montarSqlIndices } = require('../src/loader/mysql-loader');

test('montarSqlIndices: um ALTER com todos os índices, nomes legíveis, prefixo em TEXT', () => {
  const { definicoes } = planejarColunasSchema([], {
    UserId: 'INT', OrgUnitId: 'INT', 'ID do Usuário': 'INT', Comentario: 'TEXT',
    'Nome longo demais do CSV': { tipo: 'INT', coluna: 'curto' },
  });
  const r = montarSqlIndices('t', [['UserId'], ['orgunitid', 'UserId'], ['id do usuario'], ['Comentario'], ['Nome longo demais do CSV']], definicoes);
  assert.equal(r.sql,
    'ALTER TABLE `t` ADD INDEX `idx_userid` (`UserId`), ADD INDEX `idx_orgunitid_userid` (`OrgUnitId`, `UserId`), ' +
    'ADD INDEX `idx_iddousuario` (`ID do Usuário`), ADD INDEX `idx_comentario` (`Comentario`(191)), ADD INDEX `idx_curto` (`curto`)');
  assert.deepEqual(r.ignorados, []);
});

test('montarSqlIndices: coluna inexistente é ignorada (não derruba a carga); sem índices → sql null', () => {
  const { definicoes } = planejarColunasSchema([], { UserId: 'INT' });
  const r = montarSqlIndices('t', [['UserId'], ['NaoExiste'], ['UserId', 'X'], []], definicoes);
  assert.equal(r.sql, 'ALTER TABLE `t` ADD INDEX `idx_userid` (`UserId`)');
  assert.deepEqual(r.ignorados, ['NaoExiste', 'UserId, X', '(vazio)']);
  assert.equal(montarSqlIndices('t', undefined, definicoes).sql, null);
});

test('config/schemas.json: todo índice declarado aponta para coluna existente', () => {
  const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config/schemas.json'), 'utf8'));
  for (const [chave, entrada] of Object.entries(schemas)) {
    if (chave.startsWith('_') || !entrada.indices) continue;
    const { definicoes } = planejarColunasSchema([], entrada.colunas);
    const r = montarSqlIndices(entrada.tabela, entrada.indices, definicoes);
    assert.deepEqual(r.ignorados, [], chave);
    assert.equal(r.nomes.length, entrada.indices.length, chave);
  }
});
