'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { stringify } = require('csv-stringify');
const mysql = require('mysql2'); // raw (não-promise) para streaming linha a linha

const EXPORTS_DIR = process.env.EXPORTS_DIR || './exports';

function criarConexaoRaw() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'dataUCB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'data_ucb',
  });
}

// Executa query via streaming — nunca carrega todas as linhas na memória de uma vez.
// O parâmetro connOuNull é mantido por compatibilidade mas não é usado (streaming
// requer conexão raw mysql2, não a versão promise).
async function exportarQuery(_connOuNull, sql, arquivoSaida) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const conn = criarConexaoRaw();
  await new Promise((res, rej) => conn.connect((err) => (err ? rej(err) : res())));

  try {
    return await new Promise((resolve, reject) => {
      let rowCount = 0;
      let stringifier = null;
      const writeStream = fs.createWriteStream(arquivoSaida);

      writeStream.on('error', reject);

      const query = conn.query(sql);

      query.on('error', (err) => {
        writeStream.destroy();
        reject(err);
      });

      query.on('fields', (fields) => {
        const columns = fields.map((f) => f.name);
        stringifier = stringify({
          header: true,
          columns,
          cast: {
            date: (v) => (v && !isNaN(v.getTime()) ? v.toISOString() : null),
          },
        });
        stringifier.on('error', reject);
        stringifier.pipe(writeStream);
      });

      query.on('result', (row) => {
        rowCount++;
        // Backpressure: pausa o socket MySQL se o CSV ainda não foi gravado em disco
        if (!stringifier.write(row)) {
          conn.pause();
          stringifier.once('drain', () => conn.resume());
        }
      });

      query.on('end', () => {
        if (stringifier) {
          stringifier.end(() => resolve(rowCount));
        } else {
          writeStream.end();
          resolve(0);
        }
      });
    });
  } finally {
    conn.end();
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

  let exportados = 0,
    erros = 0;

  for (const t of exportacoes) {
    try {
      const sql = fs.readFileSync(t.arquivo, 'utf8');
      const saida = t.arquivo_saida || path.join(EXPORTS_DIR, `${t.nome}.csv`);
      const linhas = await exportarQuery(null, sql, saida);
      console.log(`  ✅ ${saida} — ${linhas.toLocaleString('pt-BR')} linhas`);
      exportados++;
    } catch (e) {
      console.log(`  ❌ ${t.nome}: ${e.message.substring(0, 80)}`);
      erros++;
    }
  }

  return { exportados, erros };
}

if (require.main === module) {
  exportarTodos().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

module.exports = { exportarQuery, exportarTodos };
