'use strict';

// Detecção e registro de falhas de autenticação que exigem "npm run setup".
//
// Erros lançados pelo pacote brightspace-auth (src/BrightspaceAuth.js), inspecionados sem modificá-lo:
//   - "Nenhum token encontrado. Execute o setup…"            → .tokens.json ausente
//   - "Refresh token não encontrado. Execute o setup…"       → token salvo sem refresh_token
//   - "Refresh token inválido ou expirado. Execute o setup…" → HTTP 400 na renovação (statusCode é perdido)
//   - "Erro do servidor de tokens (HTTP 401): invalid_client" → err.statusCode = 401
// Erros de rede (ECONNRESET, ENOTFOUND…) NÃO são tratados como falha de autenticação.

const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO_ALERTA = 'ULTIMA_FALHA_AUTH.txt';
const MENSAGEM_REAUTENTICAR = '🔐 Refresh token inválido ou expirado — rode "npm run setup" para reautenticar';

const PADROES = [
  /invalid_grant/i,
  /refresh token inv[aá]lido/i,
  /refresh token n[aã]o encontrado/i,
  /nenhum token encontrado/i,
  /servidor de tokens \(HTTP 40[01]\)/i,
];

function ehErroDeAutenticacao(erro) {
  if (!erro) return false;
  if (erro.statusCode === 400 || erro.statusCode === 401) return true;
  const msg = String(erro.message || erro);
  return PADROES.some((p) => p.test(msg));
}

function caminhoAlerta(logsDir) {
  return path.join(logsDir, ARQUIVO_ALERTA);
}

// Grava logs/ULTIMA_FALHA_AUTH.txt com data/hora e a mensagem
function registrarFalhaAuth(logsDir, erro, quando = new Date()) {
  fs.mkdirSync(logsDir, { recursive: true });
  const conteudo = [
    `Data/hora: ${quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (${quando.toISOString()})`,
    MENSAGEM_REAUTENTICAR,
    `Erro original: ${erro?.message || erro}`,
    '',
  ].join('\n');
  fs.writeFileSync(caminhoAlerta(logsDir), conteudo, 'utf8');
}

// Remove o alerta após uma autenticação bem-sucedida
function limparFalhaAuth(logsDir) {
  fs.rmSync(caminhoAlerta(logsDir), { force: true });
}

// Retorna o conteúdo do alerta, ou null se não houver falha registrada
function lerFalhaAuth(logsDir) {
  try {
    return fs.readFileSync(caminhoAlerta(logsDir), 'utf8');
  } catch {
    return null;
  }
}

module.exports = {
  ARQUIVO_ALERTA,
  MENSAGEM_REAUTENTICAR,
  ehErroDeAutenticacao,
  registrarFalhaAuth,
  limparFalhaAuth,
  lerFalhaAuth,
};
