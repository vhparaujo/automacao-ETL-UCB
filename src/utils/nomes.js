'use strict';

// Normaliza um nome de dataset/arquivo para comparação tolerante:
// sem acentos, minúsculo e ignorando espaços, "_" e "-".
//   "Unidades_organizacionais" → "unidadesorganizacionais"
//   "Usuários"                  → "usuarios"
function normalizarNome(nome) {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function mesmoNome(a, b) {
  return normalizarNome(a) === normalizarNome(b);
}

// Procura em config/schemas.json a entrada que corresponde ao nome base do CSV.
// Ordem: 1) chave exata (comportamento antigo); 2) chave normalizada;
// 3) qualquer item de "aliases" normalizado.
// Retorna { chave, schema } ou null. Entradas iniciadas por "_" são ignoradas.
function encontrarSchema(nomeBase, schemas) {
  const entradas = Object.entries(schemas || {}).filter(
    ([k, v]) => !k.startsWith('_') && v && typeof v === 'object'
  );

  const exata = entradas.find(([k]) => k === nomeBase);
  if (exata) return { chave: exata[0], schema: exata[1] };

  const alvo = normalizarNome(nomeBase);
  for (const [chave, schema] of entradas) {
    const candidatos = [chave, ...(Array.isArray(schema.aliases) ? schema.aliases : [])];
    if (candidatos.some((c) => normalizarNome(c) === alvo)) return { chave, schema };
  }
  return null;
}

// Distância de edição (Levenshtein) entre duas strings — O(n·m), sem dependências
function distanciaEdicao(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(anterior[j] + 1, atual[j - 1] + 1, anterior[j - 1] + custo);
    }
    anterior = atual;
  }
  return anterior[b.length];
}

// Sugere até `max` nomes de `candidatos` parecidos com `nome` (comparação normalizada).
// Critérios, em ordem de prioridade:
//   1) um contém o outro (ex.: "Biblioteca de perguntas" ⊂ "Biblioteca de Perguntas do Questionário")
//      — ordenados pela diferença de tamanho;
//   2) distância de edição até 40% do tamanho do nome procurado (mínimo 3) — ordenados pela distância.
function sugerirNomes(nome, candidatos, max = 3) {
  const alvo = normalizarNome(nome);
  if (!alvo) return [];
  const limite = Math.max(3, Math.floor(alvo.length * 0.4));
  const vistos = new Set();
  const pontuados = [];

  for (const candidato of candidatos || []) {
    const norm = normalizarNome(candidato);
    if (!norm || vistos.has(candidato)) continue;
    vistos.add(candidato);
    if (norm === alvo) continue; // igual não é sugestão — já teria casado
    if (norm.includes(alvo) || alvo.includes(norm)) {
      pontuados.push({ candidato, grupo: 0, pontos: Math.abs(norm.length - alvo.length) });
      continue;
    }
    const d = distanciaEdicao(alvo, norm);
    if (d <= limite) pontuados.push({ candidato, grupo: 1, pontos: d });
  }

  return pontuados
    .sort((x, y) => x.grupo - y.grupo || x.pontos - y.pontos || x.candidato.localeCompare(y.candidato))
    .slice(0, max)
    .map((x) => x.candidato);
}

// Retorna os nomes de `configurados` que não casam (normalizado) com nenhum de `disponiveis`,
// cada um com até 3 sugestões: [{ nome, sugestoes }]
function nomesNaoEncontrados(configurados, disponiveis) {
  return (configurados || [])
    .filter((n) => !(disponiveis || []).some((d) => mesmoNome(d, n)))
    .map((n) => ({ nome: n, sugestoes: sugerirNomes(n, disponiveis) }));
}

module.exports = {
  normalizarNome,
  mesmoNome,
  encontrarSchema,
  distanciaEdicao,
  sugerirNomes,
  nomesNaoEncontrados,
};
