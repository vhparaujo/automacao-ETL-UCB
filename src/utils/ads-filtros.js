'use strict';

// Inspeciona os filtros que cada relatório ADS declara na API e compara com config/ads-filters.json.
//
//   npm run ads:filtros            → relatórios configurados em config/ads-filters.json
//   npm run ads:filtros -- --todos → todos os ADS disponíveis na API
//
// Fonte: GET /d2l/api/lp/(versao)/dataExport/list → array de DataExport.DataSetData:
//   { DataSetId, Name, Description, Category, Filters: [ { Name, Type, Description, DefaultValue } ] }
// Type (EXPORTFILTERTYPE_T): 1 DateTime, 2 OrgUnit, 3 Role, 4 User, 5 Boolean.
// Se a resposta real não trouxer "Filters" nesse formato, o JSON bruto do primeiro item é impresso.

require('dotenv').config();
const fs = require('node:fs');
const { listarBruto } = require('../extractors/ads');
const { mesmoNome, sugerirNomes } = require('./nomes');
const { compararFiltros } = require('./ads-config');

const LINHA = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function imprimirDeclarados(declarados) {
  if (declarados.length === 0) {
    console.log('     (a API não declara nenhum filtro para este relatório)');
    return;
  }
  for (const f of declarados) {
    const padrao = f.DefaultValue !== '' ? ` — padrão: "${f.DefaultValue}"` : '';
    const desc = f.Description ? ` — ${f.Description}` : '';
    console.log(`     • ${f.Name} [${f.tipoNome}]${desc}${padrao}`);
  }
}

function imprimirRelatorio(item, config) {
  console.log(`\n📊 ${item.Name}${item.Category ? `  (${item.Category})` : ''}`);
  console.log(`   DataSetId: ${item.DataSetId}`);

  if (!Array.isArray(item.Filters)) {
    console.log('   ⚠️  Item sem "Filters" (array) — formato diferente do documentado.');
    return;
  }

  const { declarados, desconhecidos, naoConfigurados, casoDiferente } = compararFiltros(config || {}, item.Filters);
  console.log('   Filtros declarados pela API:');
  imprimirDeclarados(declarados);

  if (config) {
    for (const chave of desconhecidos) {
      const dica = casoDiferente.find((x) => x.chave === chave);
      const sugestao = dica ? ` (a API declara "${dica.declarado}")` : '';
      console.log(`   ⚠️  filtro desconhecido: "${chave}"${sugestao} — a API não declara este filtro`);
    }
    for (const nome of naoConfigurados) {
      console.log(`   ℹ️  não configurado — "${nome}" não será enviado (se a API exigir, o job falha com 400)`);
    }
    if (desconhecidos.length === 0 && naoConfigurados.length === 0) {
      console.log('   ✅ config confere com os filtros declarados');
    }
  }
}

async function main() {
  const todos = process.argv.includes('--todos');
  const config = JSON.parse(fs.readFileSync('config/ads-filters.json', 'utf8'));
  const configurados = Object.entries(config).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object');

  console.log('\n🔎 ADS — filtros declarados pela API');
  console.log(LINHA);

  const { versao, resposta, lista } = await listarBruto();
  console.log(`   API LP ${versao} — ${lista.length} relatório(s) ADS disponível(is)`);

  if (lista.length === 0) {
    console.log('\n⚠️  Lista vazia ou em formato inesperado. Resposta bruta:');
    console.log(JSON.stringify(resposta, null, 2).substring(0, 4000));
    return;
  }

  // Formato diferente do documentado: mostra o primeiro item para inspeção
  if (!lista.some((r) => Array.isArray(r?.Filters))) {
    console.log('\n⚠️  Nenhum item tem "Filters" como na documentação (DataSetData.Filters).');
    console.log('   JSON bruto do primeiro item:');
    console.log(JSON.stringify(lista[0], null, 2));
    return;
  }

  if (todos) {
    for (const item of lista) {
      const entrada = configurados.find(([nome]) => mesmoNome(nome, item.Name || ''));
      imprimirRelatorio(item, entrada ? entrada[1] : null);
    }
  } else {
    if (configurados.length === 0) console.log('\nℹ️  Nenhum relatório configurado em config/ads-filters.json.');
    const nomesAPI = lista.map((r) => r.Name).filter(Boolean);
    for (const [nome, cfg] of configurados) {
      const item = lista.find((r) => mesmoNome(r.Name || '', nome));
      if (!item) {
        const sugestoes = sugerirNomes(nome, nomesAPI);
        const dica = sugestoes.length ? ` Parecidos: ${sugestoes.map((x) => `"${x}"`).join(', ')}` : '';
        console.log(`\n⚠️  ADS "${nome}" (config) não encontrado na API.${dica}`);
        continue;
      }
      if (item.Name !== nome) console.log(`\nℹ️  "${nome}" (config) casou com "${item.Name}" (API)`);
      imprimirRelatorio(item, cfg);
    }
  }

  console.log(`\n${LINHA}`);
  console.log('ℹ️  Ajuste config/ads-filters.json conforme acima. Roles = IDs numéricos (npm run roles).');
  console.log('   Datas: ISO UTC com Z ou expressões relativas ("hoje", "-180d", "inicio_semestre"…).');
  if (!todos) console.log('   Para ver todos os ADS disponíveis: npm run ads:filtros -- --todos');
}

if (require.main === module) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { main };
