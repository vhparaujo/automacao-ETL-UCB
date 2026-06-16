'use strict';

require('dotenv').config();
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { exportarQuery } = require('../exporter/csv-exporter');

function criarConexao() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'dataUCB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'data_ucb',
    multipleStatements: true,
  });
}

async function run() {
  const config = JSON.parse(fs.readFileSync('config/transforms.json', 'utf8'));
  const transformacoes = (config.transformacoes || []).filter((t) => t.ativo !== false);

  if (transformacoes.length === 0) {
    console.log('ℹ️  Nenhuma transformação ativa em config/transforms.json');
    return { executadas: 0, erros: 0 };
  }

  const conn = await criarConexao();

  console.log(`\n🔧 Transformações — ${transformacoes.length} ativa(s)...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let executadas = 0, erros = 0;

  try {
    for (const t of transformacoes) {
      process.stdout.write(`  ⏳ ${t.nome.padEnd(35)}`);

      try {
        if (!fs.existsSync(t.arquivo)) {
          console.log(`❌ arquivo não encontrado: ${t.arquivo}`);
          erros++;
          continue;
        }

        const sql = fs.readFileSync(t.arquivo, 'utf8');

        if (t.tipo === 'view') {
          await conn.query(sql);
          console.log(`✅ view atualizada`);
          executadas++;
        } else if (t.tipo === 'exportar_csv') {
          const saida = t.arquivo_saida || `exports/${t.nome}.csv`;
          const linhas = await exportarQuery(null, sql, saida);
          console.log(`✅ ${saida} (${linhas.toLocaleString('pt-BR')} linhas)`);
          executadas++;
        } else if (t.tipo === 'table') {
          await conn.query(sql);
          console.log(`✅ tabela criada/atualizada`);
          executadas++;
        } else {
          await conn.query(sql);
          console.log(`✅ executado`);
          executadas++;
        }
      } catch (e) {
        console.log(`❌ ${e.message.substring(0, 100)}`);
        erros++;
      }
    }
  } finally {
    await conn.end();
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Transformações: ${executadas} executadas, ${erros} erros`);

  return { executadas, erros };
}

if (require.main === module) {
  run().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { run };
