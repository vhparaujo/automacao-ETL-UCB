'use strict';

const https = require('node:https');

const HOST = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';

let _versaoCache = null;

function _buscarVersao() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${HOST}/d2l/api/versions/`);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            const lista = JSON.parse(data);
            const lp = lista.find((p) => p.ProductCode === 'lp');
            if (!lp?.LatestVersion) return reject(new Error('ProductCode "lp" não encontrado'));
            resolve(lp.LatestVersion);
          } catch {
            reject(new Error(`Resposta inválida: ${data.substring(0, 100)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Retorna a versão mais recente do LP suportada pela instância.
// Prioridade: LP_API_VERSION (env) > /d2l/api/versions/ (dinâmico, cacheado por processo).
async function obterVersaoLP() {
  if (process.env.LP_API_VERSION) return process.env.LP_API_VERSION;
  if (_versaoCache) return _versaoCache;

  try {
    _versaoCache = await _buscarVersao();
    return _versaoCache;
  } catch (e) {
    throw new Error(
      `Não foi possível descobrir a versão LP via ${HOST}/d2l/api/versions/: ${e.message}\n` +
      `→ Defina LP_API_VERSION=1.59 no .env para forçar uma versão específica.`
    );
  }
}

module.exports = { obterVersaoLP };
