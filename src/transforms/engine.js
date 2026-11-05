'use strict';

require('dotenv').config();
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { exportarQuery } = require('../exporter/csv-exporter');
const { mesmoNome, sugerirNomes } = require('../utils/nomes');

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

// Lê pipeline.exportar_csvs de config/schedule.json (padrão: true)
function lerFlagExportarCsvs() {
  try {
    const config = JSON.parse(fs.readFileSync('config/schedule.json', 'utf8'));
    return config.pipeline?.exportar_csvs !== false;
  } catch {
    return true;
  }
}

// Lê os nomes passados em --so (repetível e/ou separado por vírgula):
//   --so vw_a   --so=vw_a   --so vw_a,vw_b   --so vw_a --so vw_b
// Retorna null quando --so não foi usado.
function lerArgsSomente(args) {
  const nomes = [];
  let usado = false;
  for (let i = 0; i < args.length; i++) {
    let valor;
    if (args[i] === '--so') { usado = true; valor = args[i + 1]; i++; }
    else if (args[i].startsWith('--so=')) { usado = true; valor = args[i].slice(5); }
    else continue;
    if (!valor || valor.startsWith('--')) throw new Error('--so precisa do nome da transformação (ex.: --so vw_minha_view)');
    nomes.push(...valor.split(',').map((n) => n.trim()).filter(Boolean));
  }
  return usado ? nomes : null;
}

// Escolhe as transformações a executar.
// Sem "somente": todas as ativas, na ordem do config.
// Com "somente": só as nomeadas (mesmo que ativo = false — para testar antes de ativar),
// na ordem do config; nome inexistente → erro com sugestões.
function selecionarTransformacoes(lista, somente) {
  if (!somente) return { selecionadas: lista.filter((t) => t.ativo !== false), inativas: [] };

  const nomesConfig = lista.map((t) => t.nome);
  const faltando = somente.filter((n) => !nomesConfig.some((c) => mesmoNome(c, n)));
  if (faltando.length > 0) {
    const detalhes = faltando.map((n) => {
      const sugestoes = sugerirNomes(n, nomesConfig);
      return sugestoes.length ? `"${n}" (parecidos: ${sugestoes.join(', ')})` : `"${n}"`;
    });
    throw new Error(`Transformação não encontrada em config/transforms.json: ${detalhes.join('; ')}`);
  }

  const selecionadas = lista.filter((t) => somente.some((n) => mesmoNome(t.nome, n)));
  return { selecionadas, inativas: selecionadas.filter((t) => t.ativo === false).map((t) => t.nome) };
}

// opcoes.exportarCsvs: quando false, pula as transformações do tipo "exportar_csv"
// (view e table continuam rodando). Se omitido, usa config/schedule.json — exceto com
// opcoes.somente, em que o analista pediu a transformação pelo nome e ela sempre roda.
// opcoes.somente: lista de nomes (npm run transform -- --so <nome>) — roda só essas.
// Retorna { executadas, erros, puladas, views } — views = nomes das views atualizadas com sucesso.
async function run(opcoes = {}) {
  const somente = opcoes.somente?.length ? opcoes.somente : null;
  const exportarCsvs = opcoes.exportarCsvs ?? (somente ? true : lerFlagExportarCsvs());
  const config = JSON.parse(fs.readFileSync('config/transforms.json', 'utf8'));
  const { selecionadas: transformacoes, inativas } = selecionarTransformacoes(config.transformacoes || [], somente);

  if (transformacoes.length === 0) {
    console.log('ℹ️  Nenhuma transformação ativa em config/transforms.json');
    return { executadas: 0, erros: 0, puladas: 0, views: [] };
  }
  if (inativas.length > 0) {
    console.log(`ℹ️  Executando mesmo com "ativo": false (pedido via --so): ${inativas.join(', ')}`);
  }

  const conn = await criarConexao();

  const titulo = somente ? `${transformacoes.length} selecionada(s) via --so` : `${transformacoes.length} ativa(s)`;
  console.log(`\n🔧 Transformações — ${titulo}...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let executadas = 0, erros = 0, puladas = 0;
  const views = [];

  try {
    for (const t of transformacoes) {
      process.stdout.write(`  ⏳ ${t.nome.padEnd(35)}`);

      if (t.tipo === 'exportar_csv' && !exportarCsvs) {
        console.log('⏭️  pulada (exportar_csvs = false)');
        puladas++;
        continue;
      }

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
          views.push(t.nome);
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
  const textoPuladas = puladas > 0 ? `, ${puladas} puladas` : '';
  console.log(`✅ Transformações: ${executadas} executadas${textoPuladas}, ${erros} erros`);

  return { executadas, erros, puladas, views };
}

if (require.main === module) {
  // node src/transforms/engine.js [--so nome[,nome]]  — não precisa de autenticação no Brightspace
  Promise.resolve()
    .then(() => run({ somente: lerArgsSomente(process.argv.slice(2)) }))
    .then((r) => { if (r.erros > 0) process.exitCode = 1; })
    .catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { run, lerArgsSomente, selecionarTransformacoes };
