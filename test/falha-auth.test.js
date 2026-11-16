'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const LOGS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'falha-auth-test-'));
process.env.LOGS_DIR = LOGS_TMP; // antes de carregar o pipeline (dotenv não sobrescreve)

const {
  ehErroDeAutenticacao,
  lerFalhaAuth,
  MENSAGEM_REAUTENTICAR,
  ARQUIVO_ALERTA,
} = require('../src/utils/falha-auth');

// ── Mocks dos módulos usados pelo pipeline ─────────────────────────
let comportamentoToken = async () => 'token-falso';
const etapasChamadas = [];

function mockarModulo(relativo, exportsFalsos) {
  const resolvido = require.resolve(path.join(RAIZ, relativo));
  require.cache[resolvido] = { id: resolvido, filename: resolvido, loaded: true, exports: exportsFalsos };
}

mockarModulo('src/auth/oauth.js', { getAccessToken: () => comportamentoToken() });
mockarModulo('src/extractors/bds.js', { download: async () => { etapasChamadas.push('bds'); return { baixados: 0, erros: 0 }; } });
mockarModulo('src/extractors/ads.js', { download: async () => { etapasChamadas.push('ads'); return { processados: 0, erros: 0 }; } });

const { executarPipeline } = require('../src/pipeline');

const alerta = () => path.join(LOGS_TMP, ARQUIVO_ALERTA);
const TODAS = { bds: true, ads: true };

// Silencia o console durante a execução do pipeline, guardando a saída
async function capturar(fn) {
  const saida = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => saida.push(a.join(' '));
  console.error = (...a) => saida.push(a.join(' '));
  try { return { resultado: await fn(), saida: saida.join('\n') }; }
  finally { Object.assign(console, orig); }
}

beforeEach(() => {
  etapasChamadas.length = 0;
  fs.rmSync(alerta(), { force: true });
});

// O log do pipeline é um WriteStream assíncrono: espera ele abrir/fechar antes de apagar a pasta
after(async () => {
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(LOGS_TMP, { recursive: true, force: true });
});

test('ehErroDeAutenticacao reconhece os erros do brightspace-auth', () => {
  assert.ok(ehErroDeAutenticacao(new Error('[brightspace-auth] Refresh token inválido ou expirado. Execute o setup novamente com --setup.')));
  assert.ok(ehErroDeAutenticacao(new Error('[brightspace-auth] Refresh token não encontrado. Execute o setup novamente com --setup.')));
  assert.ok(ehErroDeAutenticacao(new Error('[brightspace-auth] Nenhum token encontrado. Execute o setup com --setup antes de usar getAccessToken().')));
  assert.ok(ehErroDeAutenticacao(new Error('{"error":"invalid_grant"}')));
  const e401 = new Error('[brightspace-auth] Erro do servidor de tokens (HTTP 401): invalid_client');
  e401.statusCode = 401;
  assert.ok(ehErroDeAutenticacao(e401));
});

test('ehErroDeAutenticacao ignora erros de rede e outros', () => {
  assert.ok(!ehErroDeAutenticacao(Object.assign(new Error('getaddrinfo ENOTFOUND auth.brightspace.com'), { code: 'ENOTFOUND' })));
  assert.ok(!ehErroDeAutenticacao(new Error('[brightspace-auth] Erro do servidor de tokens (HTTP 503): unavailable')));
  assert.ok(!ehErroDeAutenticacao(null));
});

test('refresh token expirado: mensagem destacada, alerta gravado e etapas seguintes não executadas', async () => {
  comportamentoToken = async () => {
    throw new Error('[brightspace-auth] Refresh token inválido ou expirado. Execute o setup novamente com --setup.');
  };
  const { resultado, saida } = await capturar(() => executarPipeline(TODAS));

  assert.equal(resultado.falhaAuth, true);
  assert.deepEqual(etapasChamadas, []);
  assert.ok(saida.includes(MENSAGEM_REAUTENTICAR));
  const conteudo = lerFalhaAuth(LOGS_TMP);
  assert.ok(conteudo, 'arquivo de alerta deve existir');
  assert.ok(conteudo.includes(MENSAGEM_REAUTENTICAR));
  assert.match(conteudo, /Data\/hora: .+\d{4}-\d{2}-\d{2}T/);
});

test('autenticação bem-sucedida remove o alerta e roda as etapas', async () => {
  fs.writeFileSync(alerta(), 'falha antiga');
  comportamentoToken = async () => 'token-ok';
  const { resultado } = await capturar(() => executarPipeline(TODAS));

  assert.equal(resultado.falhaAuth, false);
  assert.equal(fs.existsSync(alerta()), false);
  assert.deepEqual(etapasChamadas, ['bds', 'ads']);
});

test('erro que não é de autenticação continua como falha crítica genérica, sem alerta', async () => {
  comportamentoToken = async () => { throw new Error('socket hang up'); };
  const { resultado, saida } = await capturar(() => executarPipeline(TODAS));

  assert.equal(resultado.falhaAuth, false);
  assert.equal(fs.existsSync(alerta()), false);
  assert.ok(saida.includes('Falha crítica'));
  assert.deepEqual(etapasChamadas, []);
});
