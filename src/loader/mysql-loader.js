'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mysql = require('mysql2/promise');
const { parseLinhaCSV, nomesColunasUnicos, detectarTerminadorArquivo } = require('../utils/csv');
const { encontrarSchema, mesmoNome, normalizarNome } = require('../utils/nomes');
const { listarCsvs } = require('../utils/pasta-csvs');

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
      // parseLinhaCSV remove BOM e \r final e respeita campos entre aspas (RFC 4180)
      resolve(parseLinhaCSV(linha));
    });
    rl.on('error', reject);
  });
}

function nomeCsvBase(csvPath) {
  return path.basename(csvPath, '.csv');
}

// Nome da tabela: o definido no schema fixo, ou derivado do nome do arquivo
function nomeTabela(csvPath, schemaEntry) {
  if (schemaEntry?.tabela) return schemaEntry.tabela;
  return nomeCsvBase(csvPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// Inferência de tipo pelo nome da coluna. ATENÇÃO: é heurística e pode truncar dados sem erro
// (ex.: "ID definido da organização" vira INT). Só é usada com INFERIR_TIPOS=true no .env.
function tipoColuna(nome) {
  const n = nome.toLowerCase();
  if (n.includes('date') || n.includes('time') || n.includes('acesso') || n.includes('modificaç')) return 'DATETIME';
  if ((n.includes('id') || n.includes('version')) && !n.includes('text')) return 'INT';
  if (n.startsWith('is') || n.includes('ativo') || n.includes('isactive') || n.includes('isdeleted')) return 'TINYINT(1)';
  if (n.includes('número') || n.includes('numero') || n.includes('count') || n.includes('qty')) return 'INT';
  return 'TEXT';
}

function inferirTiposAtivo() {
  return String(process.env.INFERIR_TIPOS || '').trim().toLowerCase() === 'true';
}

// Colunas de uma tabela sem schema fixo: todas TEXT (padrão) ou inferidas pelo nome (INFERIR_TIPOS=true)
function definirColunasSemSchema(nomes, inferir = false) {
  return nomes.map((nome) => ({ nome, tipo: inferir ? tipoColuna(nome) : 'TEXT' }));
}

// Compara a estrutura existente (information_schema: COLUMN_NAME, COLUMN_TYPE) com a esperada.
// Nomes sem diferenciar maiúsculas (como o MySQL); tipos comparados em minúsculas.
function mesmaEstrutura(atual, esperada) {
  if (!Array.isArray(atual) || atual.length !== esperada.length) return false;
  return esperada.every((col, i) =>
    String(atual[i].COLUMN_NAME).toLowerCase() === col.nome.toLowerCase() &&
    String(atual[i].COLUMN_TYPE).toLowerCase() === col.tipo.toLowerCase()
  );
}

async function estruturaAtual(conn, tabela) {
  const [linhas] = await conn.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [tabela]
  );
  return linhas;
}

// Colunas booleanas: os CSVs do Brightspace trazem TRUE/FALSE (BDS) ou True/False (ADS).
// Com sql_mode = '' o MySQL convertia esse texto para 0 em silêncio (IsActive/IsDeleted sempre 0).
function ehBooleano(tipo) {
  return /^\s*(tinyint\s*\(\s*1\s*\)|bool|boolean)\s*$/i.test(String(tipo));
}

// Expressão do SET do LOAD DATA para a variável posicional (@col_N) conforme o tipo da coluna.
// Vazio → NULL; booleano TRUE/FALSE → 1/0 (0/1 numéricos passam direto).
function expressaoValor(variavel, tipo) {
  if (ehBooleano(tipo)) {
    return `CASE UPPER(TRIM(${variavel})) WHEN '' THEN NULL WHEN 'TRUE' THEN 1 WHEN 'FALSE' THEN 0 ELSE ${variavel} END`;
  }
  return `NULLIF(${variavel}, '')`;
}

// Valor de cada coluna em schemas.json: "TIPO" ou { "tipo": "TIPO", "coluna": "nome na tabela" }.
// "coluna" serve para nomes de CSV longos demais (> 64 caracteres, limite do MySQL) ou ruins de usar.
function lerColunaSchema(chave, valor) {
  if (typeof valor === 'string') return { chave, nome: chave, tipo: valor };
  if (valor && typeof valor === 'object' && typeof valor.tipo === 'string') {
    return { chave, nome: valor.coluna || chave, tipo: valor.tipo };
  }
  throw new Error(`schemas.json: coluna "${chave}" inválida — use "TIPO" ou { "tipo": "TIPO", "coluna": "nome" }`);
}

// Casa o cabeçalho real do CSV com as colunas do schema (nome exato; senão, nome normalizado —
// sem acento/caixa/espaço/_/-). A tabela segue a ordem do schema.
// Retorna { definicoes, mapeamento, ausentes, ignoradas }:
//   definicoes — [{ nome, tipo }] para o CREATE TABLE (nomes ≤ 64 chars)
//   mapeamento — [{ indice, nome, tipo }] coluna do CSV (posição) → coluna da tabela
//   ausentes   — colunas do schema que o CSV não tem (ficariam sempre NULL)
//   ignoradas  — colunas do CSV que não estão no schema (não são carregadas)
function planejarColunasSchema(cabecalho, colunasSchema) {
  const defs = Object.entries(colunasSchema || {}).map(([k, v]) => lerColunaSchema(k, v));
  const { nomes } = nomesColunasUnicos(defs.map((d) => d.nome));
  defs.forEach((d, i) => { d.nome = nomes[i]; });

  const usadas = new Set();
  const mapeamento = [];
  const ignoradas = [];
  cabecalho.forEach((h, indice) => {
    const d = defs.find((x) => !usadas.has(x.chave) && x.chave === h)
      || defs.find((x) => !usadas.has(x.chave) && mesmoNome(x.chave, h));
    if (!d) { ignoradas.push(h); return; }
    usadas.add(d.chave);
    mapeamento.push({ indice, nome: d.nome, tipo: d.tipo });
  });

  return {
    definicoes: defs.map(({ chave, nome, tipo }) => ({ chave, nome, tipo })),
    mapeamento,
    ausentes: defs.filter((d) => !usadas.has(d.chave)).map((d) => d.chave),
    ignoradas,
  };
}

// Índices declarados em schemas.json → "indices": [["UserId"], ["OrgUnitId", "UserId"]].
// Cada item = colunas de um índice (nome no CSV ou nome na tabela, sem diferenciar caixa/acento).
// Criados DEPOIS do LOAD DATA (mais rápido que carregar com índice). Não são UNIQUE: uma linha
// duplicada no CSV nunca é descartada. Colunas TEXT entram com prefixo de 191 caracteres.
// Retorna { sql, nomes, ignorados } — sql = null quando não há índice válido.
function montarSqlIndices(tabela, indices, definicoes) {
  const ignorados = [];
  const partes = [];
  const nomes = [];
  for (const indice of Array.isArray(indices) ? indices : []) {
    const cols = Array.isArray(indice) ? indice : [indice];
    const resolvidas = cols.map((c) => definicoes.find((d) => mesmoNome(d.nome, c) || mesmoNome(d.chave ?? d.nome, c)));
    if (cols.length === 0 || resolvidas.some((d) => !d)) {
      ignorados.push(cols.join(', ') || '(vazio)');
      continue;
    }
    const nome = ('idx_' + resolvidas.map((d) => normalizarNome(d.nome).replace(/[^a-z0-9]/g, '')).join('_')).slice(0, 64);
    if (nomes.includes(nome)) continue;
    nomes.push(nome);
    const colunasSql = resolvidas
      .map((d) => (/^\s*(tiny|medium|long)?text\s*$/i.test(d.tipo) ? `\`${d.nome}\`(191)` : `\`${d.nome}\``))
      .join(', ');
    partes.push(`ADD INDEX \`${nome}\` (${colunasSql})`);
  }
  return { sql: partes.length ? `ALTER TABLE \`${tabela}\` ${partes.join(', ')}` : null, nomes, ignorados };
}

// Retorna true quando a tabela sem schema precisou ser (re)criada
// definicoesSchema: [{ nome, tipo }] de planejarColunasSchema() — tabela com schema fixo (sempre recriada)
async function criarOuRecriarTabela(conn, tabela, colunas, definicoesSchema) {
  if (definicoesSchema) {
    // Usa exatamente as colunas do schema (colunas extras do CSV são ignoradas e avisadas)
    await conn.execute(`DROP TABLE IF EXISTS \`${tabela}\``);
    const definicoes = definicoesSchema
      .map((c) => `\`${c.nome}\` ${c.tipo}`)
      .join(',\n  ');
    await conn.execute(
      `CREATE TABLE \`${tabela}\` (\n  ${definicoes}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
    );
    return true;
  }

  // Sem schema: nomes já chegam truncados (64 chars) e sem duplicatas — ver nomesColunasUnicos().
  // Se a tabela já existe com a mesma estrutura, só TRUNCATE (preserva índices criados à mão);
  // se não existe ou mudou (colunas novas, tipos antigos inferidos…), recria.
  const esperada = definirColunasSemSchema(colunas, inferirTiposAtivo());
  const atual = await estruturaAtual(conn, tabela);
  if (mesmaEstrutura(atual, esperada)) {
    await conn.execute(`TRUNCATE TABLE \`${tabela}\``);
    return false;
  }
  const definicoes = esperada.map((c) => `\`${c.nome}\` ${c.tipo}`).join(',\n  ');
  await conn.execute(`DROP TABLE IF EXISTS \`${tabela}\``);
  await conn.execute(
    `CREATE TABLE \`${tabela}\` (\n  ${definicoes}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
  );
  return atual.length > 0; // true = existia com outra estrutura
}

async function carregarCSV(conn, csvPath, schemas) {
  const base = nomeCsvBase(csvPath);
  // Casamento normalizado (sem acento/case, ignora espaço, _ e -) + "aliases" do schemas.json
  const schemaEntry = encontrarSchema(base, schemas)?.schema;
  const tabela = nomeTabela(csvPath, schemaEntry);
  const colunas = await lerCabecalhoCSV(csvPath);
  const absPath = path.resolve(csvPath).replace(/\\/g, '/');
  const avisos = [];

  if (!schemaEntry) {
    avisos.push(
      inferirTiposAtivo()
        ? `🔍 Sem schema fixo para "${path.basename(csvPath)}" → tabela "${tabela}" com tipos inferidos pelo nome (INFERIR_TIPOS=true)`
        : `🔍 Sem schema fixo para "${path.basename(csvPath)}" → tabela "${tabela}" carregada com todas as colunas TEXT`
    );
  }

  // Sem schema fixo: trunca para 64 chars (limite do MySQL) e desambigua colisões
  const { nomes: nomesInferidos, colisoes } = nomesColunasUnicos(colunas);
  if (!schemaEntry?.colunas) {
    for (const { original, final } of colisoes) {
      avisos.push(`⚠️  Coluna duplicada após truncamento: "${original}" → "${final}"`);
    }
  }

  // Com schema: casa o cabeçalho real com as colunas declaradas e avisa divergências
  const plano = schemaEntry?.colunas ? planejarColunasSchema(colunas, schemaEntry.colunas) : null;
  if (plano) {
    if (plano.mapeamento.length === 0) {
      throw new Error(`nenhuma coluna de "${path.basename(csvPath)}" existe no schema — confira config/schemas.json`);
    }
    if (plano.ausentes.length > 0) {
      avisos.push(`⚠️  ${plano.ausentes.length} coluna(s) do schema não existem no CSV (ficarão NULL): ${plano.ausentes.join(', ')}`);
    }
    if (plano.ignoradas.length > 0) {
      avisos.push(`ℹ️  ${plano.ignoradas.length} coluna(s) do CSV fora do schema (não carregadas): ${plano.ignoradas.join(', ')}`);
    }
  }

  const colunasSemSchema = plano ? null : definirColunasSemSchema(nomesInferidos, inferirTiposAtivo());
  const recriada = await criarOuRecriarTabela(conn, tabela, nomesInferidos, plano?.definicoes);
  if (!schemaEntry?.colunas && recriada) {
    avisos.push(`♻️  Estrutura de "${tabela}" mudou (colunas ou tipos) — tabela recriada`);
  }

  // Variáveis posicionais evitam o limite de 64 chars do MySQL em nomes de identificadores
  const vars = colunas.map((_, i) => `@col_${i}`).join(', ');

  const sets = plano
    ? plano.mapeamento
        .map((m) => `\`${m.nome}\` = ${expressaoValor(`@col_${m.indice}`, m.tipo)}`)
        .join(',\n  ')
    : colunasSemSchema
        .map((c, i) => `\`${c.nome}\` = ${expressaoValor(`@col_${i}`, c.tipo)}`)
        .join(',\n  ');

  // Os CSVs do Brightspace usam \r\n. Com LINES TERMINATED BY '\n' o \r ficava grudado na
  // última coluna (e vazio virava "\r" em vez de NULL). Detecta o terminador real do arquivo.
  const terminador = detectarTerminadorArquivo(csvPath);
  const terminadorSQL = { '\r\n': '\\r\\n', '\n': '\\n', '\r': '\\r' }[terminador];

  const sql = `
    LOAD DATA LOCAL INFILE '${absPath}'
    INTO TABLE \`${tabela}\`
    CHARACTER SET utf8mb4
    FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"'
    LINES TERMINATED BY '${terminadorSQL}'
    IGNORE 1 ROWS
    (${vars})
    SET ${sets};
  `;

  const inicio = Date.now();
  const [result] = await conn.query(sql);

  // Índices do schema (a tabela com schema é sempre recriada, então eles também)
  if (plano && schemaEntry.indices) {
    const indices = montarSqlIndices(tabela, schemaEntry.indices, plano.definicoes);
    if (indices.ignorados.length > 0) {
      avisos.push(`⚠️  Índice(s) ignorado(s) — coluna inexistente na tabela: ${indices.ignorados.map((i) => `(${i})`).join(', ')}`);
    }
    if (indices.sql) {
      const inicioIdx = Date.now();
      await conn.query(indices.sql);
      avisos.push(`🗂️  ${indices.nomes.length} índice(s) criado(s) em ${((Date.now() - inicioIdx) / 1000).toFixed(1)}s`);
    }
  }

  // Estatísticas atualizadas: sem isso o otimizador estima errado o tamanho das tabelas
  // recém-carregadas e pode escolher planos que não terminam (join sem condição).
  await conn.query(`ANALYZE TABLE \`${tabela}\``);

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);

  return { tabela, linhas: result.affectedRows || 0, duracao, schemaFixo: !!schemaEntry, avisos };
}

async function load(csvGlob) {
  const conn = await criarConexao();
  const schemas = carregarSchemas();

  try {
    await conn.execute('SET SESSION sql_mode = ""');

    // Só os .csv do nível de cima de csvs/ — _anterior/ e zips/ são ignorados
    const arquivos = csvGlob
      ? (Array.isArray(csvGlob) ? csvGlob : [csvGlob])
      : listarCsvs(CSVS_DIR);

    if (arquivos.length === 0) {
      console.log('ℹ️  Nenhum CSV encontrado para carregar.');
      return { carregados: 0, erros: 0, totalLinhas: 0, tabelas: [] };
    }

    console.log(`\n🗄️  MySQL — Carregando ${arquivos.length} CSV(s)...`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let carregados = 0, erros = 0, totalLinhas = 0;
    const tabelas = [];

    for (const csvPath of arquivos) {
      const nome = path.basename(csvPath);
      process.stdout.write(`  ⏳ ${nome.padEnd(45)}`);

      try {
        const { tabela, linhas, duracao, schemaFixo, avisos } = await carregarCSV(conn, csvPath, schemas);
        const tag = schemaFixo ? '📋' : '🔍';
        console.log(`✅ ${tag} ${linhas.toLocaleString('pt-BR')} linhas → ${tabela} (${duracao}s)`);
        for (const aviso of avisos) console.log(`     ${aviso}`);
        carregados++;
        totalLinhas += linhas;
        tabelas.push(tabela);
      } catch (e) {
        console.log(`❌ ${e.message.substring(0, 80)}`);
        erros++;
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const legenda = inferirTiposAtivo() ? 'tipos inferidos (INFERIR_TIPOS=true)' : 'todas as colunas TEXT';
    console.log(`  📋 = schema fixo (config/schemas.json)  🔍 = sem schema → ${legenda}`);
    console.log(`✅ Carga: ${carregados} tabelas, ${totalLinhas.toLocaleString('pt-BR')} linhas, ${erros} erros`);

    return { carregados, erros, totalLinhas, tabelas };
  } finally {
    await conn.end();
  }
}

// Tabelas físicas (BASE TABLE, sem views) existentes no banco
async function listarTabelas() {
  const conn = await criarConexao();
  try {
    const [linhas] = await conn.execute(
      `SELECT TABLE_NAME AS nome FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
    );
    return linhas.map((l) => l.nome);
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

module.exports = {
  load, listarTabelas, nomeTabela, carregarSchemas, definirColunasSemSchema, mesmaEstrutura, tipoColuna,
  ehBooleano, expressaoValor, planejarColunasSchema, montarSqlIndices,
};
