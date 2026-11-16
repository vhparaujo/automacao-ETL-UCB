'use strict';

// Nova tentativa de download (BDS e ADS).
//
// Um download que falha é tentado mais uma vez (DOWNLOAD_TENTATIVAS = 2 no total) depois de uma
// espera (DOWNLOAD_ESPERA_SEGUNDOS, padrão 30 s). Erros que se repetiriam iguais não ganham nova
// tentativa: configuração inválida (erro.naoRepetir), HTTP 400/403 (requisição recusada pela API)
// e falha de autenticação (refresh token inválido — exige "npm run setup").

const { ehErroDeAutenticacao } = require('./falha-auth');

function inteiroPositivo(valor, padrao) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

const TENTATIVAS_PADRAO = Math.max(1, inteiroPositivo(process.env.DOWNLOAD_TENTATIVAS, 2));
const ESPERA_PADRAO_MS = inteiroPositivo(process.env.DOWNLOAD_ESPERA_SEGUNDOS, 30) * 1000;

// Marca um erro como definitivo (não adianta tentar de novo)
function erroDefinitivo(mensagem) {
  const e = new Error(mensagem);
  e.naoRepetir = true;
  return e;
}

function deveRepetir(erro) {
  if (!erro) return false;
  if (erro.naoRepetir) return false;
  if (erro.status === 400 || erro.status === 403) return false;
  if (ehErroDeAutenticacao(erro)) return false;
  return true;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Executa fn(tentativa) até dar certo ou acabarem as tentativas.
// aoFalhar({ tentativa, tentativas, erro, vaiRepetir, esperaMs }) é chamado a cada falha (para log).
// Sucesso → { valor, tentativas }. Falha final → lança o último erro com erro.tentativas preenchido.
async function comRetentativa(fn, opcoes = {}) {
  const tentativas = Math.max(1, opcoes.tentativas ?? TENTATIVAS_PADRAO);
  const esperaMs = opcoes.esperaMs ?? ESPERA_PADRAO_MS;
  const esperar = opcoes.dormir || dormir;

  for (let tentativa = 1; ; tentativa++) {
    try {
      const valor = await fn(tentativa);
      return { valor, tentativas: tentativa };
    } catch (erro) {
      const vaiRepetir = tentativa < tentativas && deveRepetir(erro);
      opcoes.aoFalhar?.({ tentativa, tentativas, erro, vaiRepetir, esperaMs });
      if (!vaiRepetir) {
        erro.tentativas = tentativa;
        throw erro;
      }
      if (esperaMs > 0) await esperar(esperaMs);
    }
  }
}

module.exports = { comRetentativa, deveRepetir, erroDefinitivo, TENTATIVAS_PADRAO, ESPERA_PADRAO_MS };
