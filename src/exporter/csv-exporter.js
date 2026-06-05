'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { stringify } = require('csv-stringify/sync');
const mysql = require('mysql2/promise');

const EXPORTS_DIR = process.env.EXPORTS_DIR || './exports';

function criarConexao() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'dataUCB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'data_ucb',
  });
}

async function exportarQuery(connOuNull, sql, arquivoSaida) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const conn = connOuNull || (await criarConexao());
  const fecharAoFim = !connOuNull;

  try {
    const [rows, fields] = await conn.query(sql);

    if (!rows || rows.length === 0) {
      fs.writeFileSync(arquivoSaida, '');
      return 0;
    }

    const cabecalho = fields.map((f) => f.name);
    const conteudo = stringify(rows, {
      header: true,
      columns: cabecalho,
      cast: {
        date: (v) => (v && !isNaN(v.getTime()) ? v.toISOString() : null),
      },
    });

    fs.writeFileSync(arquivoSaida, conteudo, 'utf8');
    return rows.length;
  } finally {
    if (fecharAoFim) await conn.end();
  }
}

async function exportarTodos() {
  const config = JSON.parse(fs.readFileSync('config/transforms.json', 'utf8'));
  const exportacoes = (config.transformacoes || []).filter(
    (t) => t.ativo !== false && t.tipo === 'exportar_csv'
  );

  if (exportacoes.length === 0) {
    console.log('ℹ️  Nenhuma exportação CSV configurada em transforms.json');
    return { exportados: 0, erros: 0 };
  }

  const conn = await criarConexao();
  let exportados = 0, erros = 0;

  try {
    for (const t of exportacoes) {
      try {
        const sql = fs.readFileSync(t.arquivo, 'utf8');
        const saida = t.arquivo_saida || path.join(EXPORTS_DIR, `${t.nome}.csv`);
        const linhas = await exportarQuery(conn, sql, saida);
        console.log(`  ✅ ${saida} — ${linhas.toLocaleString('pt-BR')} linhas`);
        exportados++;
      } catch (e) {
        console.log(`  ❌ ${t.nome}: ${e.message.substring(0, 80)}`);
        erros++;
      }
    }
  } finally {
    await conn.end();
  }

  return { exportados, erros };
}

if (require.main === module) {
  exportarTodos().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { exportarQuery, exportarTodos };
