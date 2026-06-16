'use strict';

require('dotenv').config();
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const { exec } = require('node:child_process');
const selfsigned = require('selfsigned');

const { obterVersaoLP } = require('../utils/versao-api');

const TOKENS_FILE = '.tokens.json';
const AUTH_URL = 'https://auth.brightspace.com/oauth2/auth';
const TOKEN_URL = 'https://auth.brightspace.com/core/connect/token';
const SCOPES = 'datahub:dataExports:download datahub:dataExports:read datasets:bds:read core:*:*';
const CALLBACK_PORT = 9876;

function lerTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function salvarTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function trocarCodePorTokens(code) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.BRIGHTSPACE_REDIRECT_URI || `https://localhost:${CALLBACK_PORT}/callback`,
      client_id: process.env.BRIGHTSPACE_CLIENT_ID,
      client_secret: process.env.BRIGHTSPACE_CLIENT_SECRET,
    });

    const body = params.toString();
    const url = new URL(TOKEN_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`Erro de token: ${json.error} — ${json.error_description}`));
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function renovarToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BRIGHTSPACE_CLIENT_ID,
      client_secret: process.env.BRIGHTSPACE_CLIENT_SECRET,
    });

    const body = params.toString();
    const url = new URL(TOKEN_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`Erro ao renovar token: ${json.error} — ${json.error_description}`));
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const tokens = lerTokens();
  if (!tokens) {
    throw new Error('Tokens não encontrados. Execute: npm run setup');
  }

  const agora = Math.floor(Date.now() / 1000);
  const expiresAt = tokens.obtained_at + tokens.expires_in - 60;

  if (agora < expiresAt) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Refresh token não disponível. Execute: npm run setup');
  }

  console.log('📡 Token expirado, renovando via refresh_token...');
  const novos = await renovarToken(tokens.refresh_token);
  const atualizados = {
    ...novos,
    refresh_token: novos.refresh_token || tokens.refresh_token,
    obtained_at: Math.floor(Date.now() / 1000),
  };
  salvarTokens(atualizados);
  return atualizados.access_token;
}

function abrirNavegador(url) {
  const plataforma = process.platform;
  if (plataforma === 'darwin') exec(`open "${url}"`);
  else if (plataforma === 'win32') exec(`start "" "${url}"`);
  else exec(`xdg-open "${url}"`);
}

async function setup() {
  console.log('\n🔐 Configurando autenticação OAuth 2.0 — Brightspace UCB');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!process.env.BRIGHTSPACE_CLIENT_ID || !process.env.BRIGHTSPACE_CLIENT_SECRET) {
    console.error('❌ BRIGHTSPACE_CLIENT_ID e BRIGHTSPACE_CLIENT_SECRET não encontrados no .env');
    process.exit(1);
  }

  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1 });

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.BRIGHTSPACE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', process.env.BRIGHTSPACE_REDIRECT_URI || `https://localhost:${CALLBACK_PORT}/callback`);
  authUrl.searchParams.set('scope', SCOPES);

  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: pems.private, cert: pems.cert },
      (req, res) => {
        const url = new URL(req.url, `https://localhost:${CALLBACK_PORT}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>❌ Erro de autorização: ${error}</h1><p>Feche esta aba e tente novamente.</p>`);
          server.close();
          return reject(new Error(`Autorização negada: ${error}`));
        }

        if (!code) {
          res.writeHead(400);
          res.end('Código não encontrado');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:50px">
            <h1>✅ Autorização concluída!</h1>
            <p>Você pode fechar esta aba e voltar ao terminal.</p>
          </body></html>
        `);

        server.close();

        trocarCodePorTokens(code)
          .then((tokens) => {
            const completo = { ...tokens, obtained_at: Math.floor(Date.now() / 1000) };
            salvarTokens(completo);
            console.log('\n✅ Tokens salvos em .tokens.json (permissão 600)');
            console.log(`   Access Token expira em: ${tokens.expires_in}s`);
            console.log(`   Refresh Token: ${tokens.refresh_token ? '✅ presente' : '❌ ausente'}`);
            resolve();
          })
          .catch(reject);
      }
    );

    server.listen(CALLBACK_PORT, () => {
      console.log(`\n📡 Servidor de callback HTTPS iniciado na porta ${CALLBACK_PORT}`);
      console.log('\n⚠️  ATENÇÃO: O navegador vai exibir um aviso de certificado autoassinado.');
      console.log('   Clique em "Avançar" ou "Proceed anyway" para continuar.\n');
      console.log('🌐 Abrindo navegador para autorização...');
      console.log(`   URL: ${authUrl.toString()}\n`);
      abrirNavegador(authUrl.toString());
      console.log('⏳ Aguardando callback do Brightspace...');
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Porta ${CALLBACK_PORT} já em uso. Encerre o processo que a ocupa e tente novamente.`));
      } else {
        reject(err);
      }
    });
  });
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
