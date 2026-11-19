'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mysql = require('mysql2/promise');
const { parseLinhaCSV, nomesColunasUnicos, detectarTerminadorArquivo, detectarFormatoArquivo } = require('../utils/csv');
const { encontrarSchema, mesmoNome, normalizarNome } = require('../utils/nomes');
const { listarCsvs, listarCsvsManuais } = require('../utils/pasta-csvs');
const {
  TABELA_ESTADO, listarDiferenciais, lerManifesto, encontrarChave, decidirAplicacao, montarSqlMerge, nomeStaging,
} = require('../utils/bds-diferencial');

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
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'dataUCB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'data_ucb',
    infileStreamFactory: (filePath) => fs.createReadStream(filePath),
    multipleStatements: false,
  });
}

async function lerCabecalhoCSV(csvPath, formato = { separador: ',', codificacao: 'utf8' }) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(csvPath, { encoding: formato.codificacao });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.once('line', (linha) => {
      rl.close();
      // parseLinhaCSV remove BOM e \r final e respeita campos entre aspas (RFC 4180)
      resolve(parseLinhaCSV(linha, formato.separador));
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
// formatoBR (schema com "formato": "br" — CSVs do sistema acadêmico):
//   DECIMAL/FLOAT/DOUBLE  "1234,5678"            → 1234.5678 (sem separador de milhar)
//   DATETIME/TIMESTAMP    "dd/mm/aaaa hh:mm:ss"  (também aceita só "dd/mm/aaaa" → 00:00:00)
//   DATE                  "dd/mm/aaaa"
function expressaoValor(variavel, tipo, { formatoBR = false } = {}) {
  if (ehBooleano(tipo)) {
    return `CASE UPPER(TRIM(${variavel})) WHEN '' THEN NULL WHEN 'TRUE' THEN 1 WHEN 'FALSE' THEN 0 ELSE ${variavel} END`;
  }
  if (formatoBR) {
    const t = String(tipo).trim().toUpperCase();
    if (/^(DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)\b/.test(t)) return `REPLACE(NULLIF(TRIM(${variavel}), ''), ',', '.')`;
    if (/^(DATETIME|TIMESTAMP)\b/.test(t)) return `STR_TO_DATE(NULLIF(TRIM(${variavel}), ''), '%d/%m/%Y %H:%i:%s')`;
    if (/^DATE\b/.test(t)) return `STR_TO_DATE(NULLIF(TRIM(${variavel}), ''), '%d/%m/%Y')`;
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

// Lê o cabeçalho e planeja a carga de um CSV: tabela, colunas e expressões do LOAD DATA.
// Usado pela carga completa (carregarCSV) e pelo diferencial (aplicarDiferencialCSV).
async function planejarCarga(csvPath, schemas) {
  const base = nomeCsvBase(csvPath);
  // Casamento normalizado (sem acento/case, ignora espaço, _ e -) + "aliases" do schemas.json
  const schemaEntry = encontrarSchema(base, schemas)?.schema;
  const tabela = nomeTabela(csvPath, schemaEntry);
  // Separador (',' ou ';') e codificação (utf8 ou latin1) detectados pelo início do arquivo
  const formato = detectarFormatoArquivo(csvPath);
  const colunas = await lerCabecalhoCSV(csvPath, formato);
  const avisos = [];
  if (formato.separador !== ',' || formato.codificacao !== 'utf8') {
    avisos.push(`ℹ️  Formato detectado: separador "${formato.separador}", codificação ${formato.codificacao}`);
  }

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

  // Colunas efetivamente preenchidas pelo LOAD DATA: [{ indice (posição no CSV), nome, tipo }]
  const preenchidas = plano
    ? plano.mapeamento
    : colunasSemSchema.map((c, i) => ({ indice: i, nome: c.nome, tipo: c.tipo }));

  return {
    base, schemaEntry, tabela, formato, formatoBR: schemaEntry?.formato === 'br', colunas, nomesInferidos, plano, colunasSemSchema, preenchidas, avisos,
    // Estrutura esperada da tabela (CREATE TABLE): schema na ordem do schema; sem schema = cabeçalho
    definicoes: plano ? plano.definicoes : colunasSemSchema,
  };
}

// LOAD DATA LOCAL INFILE do CSV para a tabela indicada (a tabela já existe)
async function executarLoadData(conn, csvPath, tabela, planejamento) {
  const absPath = path.resolve(csvPath).replace(/\\/g, '/');
  // Variáveis posicionais evitam o limite de 64 chars do MySQL em nomes de identificadores
  const vars = planejamento.colunas.map((_, i) => `@col_${i}`).join(', ');
  const sets = planejamento.preenchidas
    .map((m) => `\`${m.nome}\` = ${expressaoValor(`@col_${m.indice}`, m.tipo, { formatoBR: planejamento.formatoBR })}`)
    .join(',\n  ');

  // Os CSVs do Brightspace usam \r\n. Com LINES TERMINATED BY '\n' o \r ficava grudado na
  // última coluna (e vazio virava "\r" em vez de NULL). Detecta o terminador real do arquivo.
  const terminador = detectarTerminadorArquivo(csvPath);
  const terminadorSQL = { '\r\n': '\\r\\n', '\n': '\\n', '\r': '\\r' }[terminador];
  // latin1 do MySQL = Windows-1252 (superconjunto do ISO-8859-1 usado nos exports do sistema acadêmico)
  const { separador = ',', codificacao = 'utf8' } = planejamento.formato || {};
  const charsetMySQL = codificacao === 'latin1' ? 'latin1' : 'utf8mb4';

  const sql = `
    LOAD DATA LOCAL INFILE '${absPath}'
    INTO TABLE \`${tabela}\`
    CHARACTER SET ${charsetMySQL}
    FIELDS TERMINATED BY '${separador}' OPTIONALLY ENCLOSED BY '"'
    LINES TERMINATED BY '${terminadorSQL}'
    IGNORE 1 ROWS
    (${vars})
    SET ${sets};
  `;
  const [result] = await conn.query(sql);
  return result.affectedRows || 0;
}

async function carregarCSV(conn, csvPath, schemas) {
  const plan = await planejarCarga(csvPath, schemas);
  const { schemaEntry, tabela, plano, avisos } = plan;

  const recriada = await criarOuRecriarTabela(conn, tabela, plan.nomesInferidos, plano?.definicoes);
  if (!schemaEntry?.colunas && recriada) {
    avisos.push(`♻️  Estrutura de "${tabela}" mudou (colunas ou tipos) — tabela recriada`);
  }

  const inicio = Date.now();
  const linhas = await executarLoadData(conn, csvPath, tabela, plan);

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

  return { tabela, linhas, duracao, schemaFixo: !!schemaEntry, avisos };
}

// ── BDS diferencial ────────────────────────────────────────────────

function carregarChavesDiferencial() {
  try {
    return JSON.parse(fs.readFileSync('config/bds-diferencial.json', 'utf8')).chaves || {};
  } catch {
    return {};
  }
}

async function garantirTabelaEstado(conn) {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS \`${TABELA_ESTADO}\` (
      tabela VARCHAR(64) NOT NULL PRIMARY KEY,
      dataset VARCHAR(255),
      completo_criado VARCHAR(40),
      diferencial_criado VARCHAR(40),
      atualizado_em DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function lerEstado(conn, tabela) {
  const [linhas] = await conn.execute(`SELECT * FROM \`${TABELA_ESTADO}\` WHERE tabela = ?`, [tabela]);
  return linhas[0] || null;
}

// Completo carregado: nova base da tabela, zera o último diferencial aplicado
async function registrarCompleto(conn, tabela, info) {
  await conn.execute(
    `REPLACE INTO \`${TABELA_ESTADO}\` (tabela, dataset, completo_criado, diferencial_criado, atualizado_em)
     VALUES (?, ?, ?, NULL, NOW())`,
    [tabela, info.dataset || null, info.criado || null]
  );
}

async function registrarDiferencial(conn, tabela, meta) {
  await conn.execute(
    `INSERT INTO \`${TABELA_ESTADO}\` (tabela, dataset, diferencial_criado, atualizado_em) VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE diferencial_criado = VALUES(diferencial_criado), atualizado_em = NOW()`,
    [tabela, meta.dataset || null, meta.criado]
  );
}

// Aplica um CSV diferencial à tabela já carregada pelo completo (upsert pela chave):
//   1. carrega o CSV em uma tabela de staging com a mesma estrutura (CREATE TABLE … LIKE)
//   2. numa transação: DELETE das linhas da tabela com as mesmas chaves + INSERT do staging
// Retorna { tabela, linhas, novas, atualizadas, duracao, pulado?, avisos }.
async function aplicarDiferencialCSV(conn, csvPath, schemas, chaves, meta) {
  const plan = await planejarCarga(csvPath, schemas);
  const { tabela, definicoes, preenchidas } = plan;
  const avisos = plan.avisos.filter((a) => !a.startsWith('🔍')); // "sem schema" já aparece no completo

  const atual = await estruturaAtual(conn, tabela);
  if (atual.length === 0) {
    throw new Error(`tabela "${tabela}" não existe — carregue o BDS completo antes do diferencial`);
  }
  const nomesAtuais = atual.map((c) => String(c.COLUMN_NAME).toLowerCase());
  const nomesEsperados = definicoes.map((d) => d.nome.toLowerCase());
  if (nomesAtuais.join('|') !== nomesEsperados.join('|')) {
    throw new Error(`estrutura de "${tabela}" difere do CSV/schema atual — rode o BDS completo para recriar a tabela`);
  }

  const chaveCsv = encontrarChave(plan.base, chaves);
  if (!chaveCsv) {
    throw new Error(`"${plan.base}" sem chave em config/bds-diferencial.json — diferencial não aplicado`);
  }
  // Colunas da chave → nomes na tabela (aceita o nome do CSV ou o da tabela)
  const chave = chaveCsv.map((c) => {
    const d = definicoes.find((x) => mesmoNome(x.nome, c) || mesmoNome(x.chave ?? x.nome, c));
    if (!d || !preenchidas.some((p) => p.nome === d.nome)) {
      throw new Error(`coluna de chave "${c}" não existe no CSV de "${tabela}" — confira config/bds-diferencial.json`);
    }
    return d.nome;
  });

  const decisao = decidirAplicacao(await lerEstado(conn, tabela), meta);
  if (!decisao.aplicar) return { tabela, pulado: decisao.motivo, avisos: [] };
  if (decisao.aviso) avisos.push(`⚠️  ${decisao.aviso}`);

  const inicio = Date.now();

  // Índices do schema que faltam na tabela (carregada antes de o schema ganhar o índice):
  // sem eles o DELETE … JOIN do merge pode levar dezenas de minutos nas tabelas grandes de log.
  // Custo único — o próximo completo recria a tabela já com todos.
  if (plan.plano && plan.schemaEntry.indices) {
    const [existentes] = await conn.query(`SHOW INDEX FROM \`${tabela}\``);
    const nomesExistentes = new Set(existentes.map((i) => String(i.Key_name).toLowerCase()));
    const faltando = plan.schemaEntry.indices.filter((indice) => {
      const { nomes } = montarSqlIndices(tabela, [indice], definicoes);
      return nomes.length > 0 && !nomesExistentes.has(nomes[0].toLowerCase());
    });
    if (faltando.length > 0) {
      const idx = montarSqlIndices(tabela, faltando, definicoes);
      const inicioIdx = Date.now();
      await conn.query(idx.sql);
      avisos.push(`🗂️  índice(s) do schema criado(s) na tabela existente: ${idx.nomes.join(', ')} (${((Date.now() - inicioIdx) / 1000).toFixed(1)}s)`);
    }
  }

  const staging = nomeStaging(tabela);
  await conn.query(`DROP TABLE IF EXISTS \`${staging}\``);
  await conn.query(`CREATE TABLE \`${staging}\` LIKE \`${tabela}\``);
  try {
    const linhas = await executarLoadData(conn, csvPath, staging, plan);
    // Índice da chave no staging: o DELETE … JOIN não depende de a tabela grande ter índice nela
    const idx = montarSqlIndices(staging, [chave], definicoes);
    if (idx.sql) {
      try { await conn.query(idx.sql); } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e; // a tabela já tinha esse índice (copiado pelo LIKE)
      }
    }

    const sql = montarSqlMerge(tabela, staging, preenchidas.map((p) => p.nome), chave);
    await conn.beginTransaction();
    let removidas;
    try {
      [{ affectedRows: removidas }] = await conn.query(sql.apagar);
      await conn.query(sql.inserir);
      await registrarDiferencial(conn, tabela, meta);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    await conn.query(`ANALYZE TABLE \`${tabela}\``);

    return {
      tabela,
      linhas,
      atualizadas: Math.min(removidas, linhas),
      novas: Math.max(linhas - removidas, 0),
      duracao: ((Date.now() - inicio) / 1000).toFixed(1),
      avisos,
    };
  } finally {
    await conn.query(`DROP TABLE IF EXISTS \`${staging}\``);
  }
}

// Aplica, em ordem cronológica, os diferenciais baixados em csvs/diferencial/
async function aplicarDiferenciais(conn, schemas) {
  const diferenciais = listarDiferenciais(CSVS_DIR);
  const r = { aplicados: 0, pulados: 0, erros: 0, totalLinhas: 0, tabelas: [] };
  if (diferenciais.length === 0) return r;

  const chaves = carregarChavesDiferencial();
  console.log(`\n🔁 BDS diferencial — aplicando ${diferenciais.length} CSV(s) de csvs/diferencial/...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const avisosEmitidos = new Set();
  for (const { csv: csvPath, meta } of diferenciais) {
    const rotulo = `${path.basename(csvPath)} (${(meta?.criado || 'sem data').slice(0, 16).replace('T', ' ')})`;
    process.stdout.write(`  ⏳ ${rotulo.padEnd(45)}`);
    try {
      const res = await aplicarDiferencialCSV(conn, csvPath, schemas, chaves, meta || {});
      if (res.pulado) {
        console.log(`⏭️  ${res.pulado}`);
        r.pulados++;
        // Já aplicado = tabela em dia; não deve aparecer como "não atualizada"
        if (!r.tabelas.includes(res.tabela)) r.tabelas.push(res.tabela);
        continue;
      }
      console.log(
        `✅ ${res.linhas.toLocaleString('pt-BR')} linhas → ${res.tabela} ` +
        `(${res.novas.toLocaleString('pt-BR')} novas, ${res.atualizadas.toLocaleString('pt-BR')} substituídas) (${res.duracao}s)`
      );
      for (const aviso of res.avisos) {
        const chave = `${res.tabela}|${aviso}`;
        if (avisosEmitidos.has(chave)) continue; // mesmo aviso só uma vez por tabela
        avisosEmitidos.add(chave);
        console.log(`     ${aviso}`);
      }
      r.aplicados++;
      r.totalLinhas += res.linhas;
      if (!r.tabelas.includes(res.tabela)) r.tabelas.push(res.tabela);
    } catch (e) {
      console.log(`❌ ${e.message.substring(0, 120)}`);
      r.erros++;
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Diferencial: ${r.aplicados} aplicado(s), ${r.pulados} já aplicado(s)/pulado(s), ${r.erros} erro(s)`);
  return r;
}

async function load(csvGlob) {
  const conn = await criarConexao();
  const schemas = carregarSchemas();

  try {
    await conn.execute('SET SESSION sql_mode = ""');
    await garantirTabelaEstado(conn);

    // Só os .csv do nível de cima de csvs/ — _anterior/, zips/ e diferencial/ são ignorados —
    // mais os colocados à mão em csvs/manuais/ (recarregados sempre)
    let arquivos;
    if (csvGlob) {
      arquivos = Array.isArray(csvGlob) ? csvGlob : [csvGlob];
    } else {
      const manuais = listarCsvsManuais(CSVS_DIR);
      for (const f of manuais.ignorados) {
        console.log(`⚠️  csvs/manuais/${path.basename(f)} ignorado: já existe um CSV baixado com esse nome (mesma tabela) — renomeie o arquivo manual`);
      }
      arquivos = [...listarCsvs(CSVS_DIR), ...manuais.arquivos];
    }
    const manifesto = lerManifesto(CSVS_DIR);

    let carregados = 0, erros = 0, totalLinhas = 0;
    const tabelas = [];

    if (arquivos.length === 0) {
      console.log('ℹ️  Nenhum CSV completo/ADS para carregar em csvs/.');
    } else {
      console.log(`\n🗄️  MySQL — Carregando ${arquivos.length} CSV(s)...`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      for (const csvPath of arquivos) {
        const nome = path.basename(csvPath);
        process.stdout.write(`  ⏳ ${nome.padEnd(45)}`);

        try {
          const { tabela, linhas, duracao, schemaFixo, avisos } = await carregarCSV(conn, csvPath, schemas);
          const tag = schemaFixo ? '📋' : '🔍';
          console.log(`✅ ${tag} ${linhas.toLocaleString('pt-BR')} linhas → ${tabela} (${duracao}s)`);
          for (const aviso of avisos) console.log(`     ${aviso}`);
          // BDS completo (veio do manifesto): vira a base dos próximos diferenciais desta tabela
          if (manifesto[nome]?.tipo === 'Full') await registrarCompleto(conn, tabela, manifesto[nome]);
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
    }

    // Diferenciais (csvs/diferencial/) — só quando não foi pedida uma lista explícita de CSVs
    const dif = csvGlob ? null : await aplicarDiferenciais(conn, schemas);
    if (dif) {
      erros += dif.erros;
      totalLinhas += dif.totalLinhas;
      for (const t of dif.tabelas) if (!tabelas.includes(t)) tabelas.push(t);
    }

    return { carregados, erros, totalLinhas, tabelas, diferencial: dif };
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
