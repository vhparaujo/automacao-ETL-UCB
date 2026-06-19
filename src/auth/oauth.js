'use strict';

require('dotenv').config();
const https = require('node:https');
const { BrightspaceAuth } = require('brightspace-auth');

const { obterVersaoLP } = require('../utils/versao-api');

// Escopos padrão da UCB — usados se BRIGHTSPACE_SCOPES não estiver no .env
const SCOPES_PADRAO = 'datahub:dataExports:download datahub:dataExports:read datasets:bds:read core:*:*';

// Instância única do autenticador, reutilizada em todo o pipeline.
// O pacote brightspace-auth cuida de: setup OAuth, cache em .tokens.json e
// renovação automática via refresh_token.
let _auth = null;

function obterAuth() {
  if (_auth) return _auth;

  if (!process.env.BRIGHTSPACE_CLIENT_ID || !process.env.BRIGHTSPACE_CLIENT_SECRET) {
    throw new Error('BRIGHTSPACE_CLIENT_ID e BRIGHTSPACE_CLIENT_SECRET não encontrados no .env');
  }

  _auth = new BrightspaceAuth({
    clientId: process.env.BRIGHTSPACE_CLIENT_ID,
    clientSecret: process.env.BRIGHTSPACE_CLIENT_SECRET,
    redirectUri: process.env.BRIGHTSPACE_REDIRECT_URI || 'https://localhost:9876/callback',
    scopes: process.env.BRIGHTSPACE_SCOPES || SCOPES_PADRAO,
  });

  return _auth;
}

// Retorna um access_token válido (renova automaticamente se necessário).
async function getAccessToken() {
  return obterAuth().getAccessToken();
}

// Executa o fluxo interativo de autorização OAuth 2.0 (uma vez por projeto).
async function setup() {
  console.log('\n🔐 Configurando autenticação OAuth 2.0 — Brightspace UCB');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  ATENÇÃO: O navegador pode exibir um aviso de certificado autoassinado.');
  console.log('   Clique em "Avançar" ou "Proceed anyway" para continuar.\n');

  await obterAuth().setup();
  console.log('\n✅ Tokens salvos em .tokens.json — renovação automática habilitada.');
}

async function test() {
  console.log('\n🧪 Testando autenticação...');
  const token = await getAccessToken();
  const host = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';
  const versao = await obterVersaoLP();

  const url = new URL(`${host}/d2l/api/lp/${versao}/users/whoami`);
  const resultado = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end();
  });

  if (resultado.status === 200) {
    console.log(`✅ Autenticado com sucesso (API LP ${versao})`);
    console.log(`   Usuário: ${resultado.data.UniqueName || resultado.data.Identifier}`);
    console.log(`   ID: ${resultado.data.Identifier}`);
  } else {
    console.log(`❌ Erro ${resultado.status} (API LP ${versao}): ${JSON.stringify(resultado.data)}`);
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--setup') {
    setup().catch((e) => { console.error('❌', e.message); process.exit(1); });
  } else if (arg === '--test') {
    test().catch((e) => { console.error('❌', e.message); process.exit(1); });
  } else {
    console.log('Uso: node src/auth/oauth.js --setup | --test');
  }
}

module.exports = { getAccessToken };
