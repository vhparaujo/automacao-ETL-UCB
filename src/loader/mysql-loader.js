'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mysql = require('mysql2/promise');

const CSVS_DIR = process.env.CSVS_DIR || './csvs';

// Schemas fixos para tabelas conhecidas (config/schemas.json)
function carregarSchemas() {
  try {
    return JSON.parse(fs.readFileSync('config/schemas.json', 'utf8'));
  } catch {
    return {};
  }
}

function criarConexao() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'dataUCB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'data_ucb',
    infileStreamFactory: (filePath) => fs.createReadStream(filePath),
    multipleStatements: false,
  });
}

async function lerCabecalhoCSV(csvPath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
    rl.once('line', (linha) => {
      rl.close();
      // Remove BOM se presente
      const limpada = linha.replace(/^﻿/, '');
      const colunas = limpada.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      resolve(colunas);
    });
    rl.on('error', reject);
  });
}

function nomeCsvBase(csvPath) {
  return path.basename(csvPath, '.csv');
}

function nomeTabela(csvPath, schemas) {
  const base = nomeCsvBase(csvPath);
  const schema = schemas[base];
  if (schema?.tabela) return schema.tabela;
  return base.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function tipoColuna(nome) {
  const n = nome.toLowerCase();
  if (n.includes('date') || n.includes('time') || n.includes('acesso') || n.includes('modificaç')) return 'DATETIME';
  if ((n.includes('id') || n.includes('version')) && !n.includes('text')) return 'INT';
  if (n.startsWith('is') || n.includes('ativo') || n.includes('isactive') || n.includes('isdeleted')) return 'TINYINT(1)';
  if (n.includes('número') || n.includes('numero') || n.includes('count') || n.includes('qty')) return 'INT';
  return 'TEXT';
}

async function criarOuRecriarTabela(conn, tabela, colunas, schemaFixo) {
  // Se tem schema fixo, DROP + CREATE com tipos corretos
  // Se não, CREATE IF NOT EXISTS com tipos inferidos
  if (schemaFixo) {
    await conn.execute(`DROP TABLE IF EXISTS \`${tabela}\``);
    const definicoes = colunas
      .map((c) => {
        const tipo = schemaFixo[c] || 'TEXT';
        return `\`${c}\` ${tipo}`;
      })
      .join(',\n  ');
    await conn.execute(
      `CREATE TABLE \`${tabela}\` (\n  ${definicoes}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
    );
  } else {
    const definicoes = colunas.map((c) => `\`${c}\` ${tipoColuna(c)}`).join(',\n  ');
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS \`${tabela}\` (\n  ${definicoes}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
    );
    await conn.execute(`TRUNCATE TABLE \`${tabela}\``);
  }
}

async function carregarCSV(conn, csvPath, schemas) {
  const base = nomeCsvBase(csvPath);
  const schemaEntry = schemas[base];
  const tabela = nomeTabela(csvPath, schemas);
  const colunas = await lerCabecalhoCSV(csvPath);
  const absPath = path.resolve(csvPath).replace(/\\/g, '/');

  await criarOuRecriarTabela(conn, tabela, colunas, schemaEntry?.colunas);

  const vars = colunas.map((c) => `@${c.replace(/[^a-zA-Z0-9]/g, '_')}`).join(', ');
  const sets = colunas
    .map((c) => {
      const v = c.replace(/[^a-zA-Z0-9]/g, '_');
      return `\`${c}\` = NULLIF(@${v}, '')`;
    })
    .join(',\n  ');

  const sql = `
    LOAD DATA LOCAL INFILE '${absPath}'
    INTO TABLE \`${tabela}\`
    CHARACTER SET utf8mb4
    FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"'
    LINES TERMINATED BY '\\n'
    IGNORE 1 ROWS
    (${vars})
    SET ${sets};
  `;

  const inicio = Date.now();
  const [result] = await conn.query(sql);
  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);

  return { tabela, linhas: result.affectedRows || 0, duracao, schemaFixo: !!schemaEntry };
}

async function load(csvGlob) {
  const conn = await criarConexao();
  const schemas = carregarSchemas();

  try {
    await conn.execute('SET SESSION sql_mode = ""');

    const arquivos = csvGlob
      ? (Array.isArray(csvGlob) ? csvGlob : [csvGlob])
      : fs.readdirSync(CSVS_DIR)
          .filter((f) => f.endsWith('.csv'))
          .map((f) => path.join(CSVS_DIR, f));

    if (arquivos.length === 0) {
      console.log('ℹ️  Nenhum CSV encontrado para carregar.');
      return { carregados: 0, erros: 0, totalLinhas: 0 };
    }

    console.log(`\n🗄️  MySQL — Carregando ${arquivos.length} CSV(s)...`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let carregados = 0, erros = 0, totalLinhas = 0;

    for (const csvPath of arquivos) {
      const nome = path.basename(csvPath);
      process.stdout.write(`  ⏳ ${nome.padEnd(45)}`);

      try {
        const { tabela, linhas, duracao, schemaFixo } = await carregarCSV(conn, csvPath, schemas);
        const tag = schemaFixo ? '📋' : '🔍';
        console.log(`✅ ${tag} ${linhas.toLocaleString('pt-BR')} linhas → ${tabela} (${duracao}s)`);
        carregados++;
        totalLinhas += linhas;
      } catch (e) {
        console.log(`❌ ${e.message.substring(0, 80)}`);
        erros++;
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  📋 = schema fixo (config/schemas.json)  🔍 = schema inferido`);
    console.log(`✅ Carga: ${carregados} tabelas, ${totalLinhas.toLocaleString('pt-BR')} linhas, ${erros} erros`);

    return { carregados, erros, totalLinhas };
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  load().catch((e) => {
    if (e.code === 'ER_OPTION_PREVENTS_STATEMENT') {
      console.error('❌ MySQL não permite LOAD DATA LOCAL INFILE.');
      console.error('   Execute no MySQL: SET GLOBAL local_infile = 1;');
    } else {
      console.error('❌', e.message);
    }
    process.exit(1);
  });
}

module.exports = { load };
