'use strict';

require('dotenv').config();
const https = require('node:https');
const { getAccessToken } = require('../auth/oauth');

const HOST = process.env.BRIGHTSPACE_HOST || 'https://ava.catolica.edu.br';
const VERSOES = ['1.50', '1.48', '1.47', '1.46', '1.45'];

function requisicao(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Resposta inválida`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const token = await getAccessToken();

  for (const versao of VERSOES) {
    try {
      const roles = await requisicao(`${HOST}/d2l/api/lp/${versao}/roles/`, token);
      const lista = Array.isArray(roles) ? roles : roles.Items || roles.Objects || [];

      console.log(`\n✅ Roles disponíveis (API LP ${versao}):\n`);
      console.log('  ID'.padEnd(8) + 'Nome');
      console.log('  ' + '─'.repeat(50));
      lista.forEach((r) => {
        const id = String(r.Identifier || r.RoleId || r.Id || '?').padEnd(8);
        const nome = r.DisplayName || r.Name || '?';
        console.log(`  ${id}${nome}`);
      });
      console.log('');
      return;
    } catch (e) {
      if (!e.message.includes('HTTP 404')) {
        console.log(`  LP ${versao}: ${e.message.substring(0, 80)}`);
      }
    }
  }

  console.log('❌ Não foi possível listar roles. Verifique o token e os scopes.');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
