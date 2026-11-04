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

module.exports = { normalizarNome, mesmoNome, encontrarSchema };
