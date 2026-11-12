'use strict';

// Resolução de datas dos filtros ADS (config/ads-filters.json).
//
// Aceita datas ISO absolutas (comportamento original) ou expressões relativas,
// resolvidas em relação a uma data de referência (normalmente "agora"):
//
//   "agora"            → instante exato da execução (ex.: 2026-11-11T14:32:07.512Z)
//   "hoje"             → hoje 00:00:00.000Z (startDate) ou 23:59:59.999Z (endDate)
//   "-Nd"              → N dias atrás, início ou fim do dia conforme o campo (ex.: "-180d")
//   "inicio_ano"       → 01/01 do ano corrente, 00:00:00.000Z
//   "fim_ano"          → 31/12 do ano corrente, 23:59:59.999Z
//   "inicio_semestre"  → 01/01 ou 01/07 (semestre 1 = jan–jun, 2 = jul–dez), 00:00:00.000Z
//   "fim_semestre"     → 30/06 ou 31/12, 23:59:59.999Z
//   "YYYY-MM-DD"       → aquele dia, 00:00:00.000Z (startDate) ou 23:59:59.999Z (endDate)
//
// O "dia" é calculado em UTC, pois a API exige datas UTC com sufixo Z.
// Sempre retorna string ISO UTC com "Z" (a API Brightspace rejeita offsets como -03:00).

const ISO_ABSOLUTA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIAS_ATRAS = /^-(\d+)d$/;

const EXPRESSOES_VALIDAS = 'agora, hoje, -Nd (ex.: -180d), inicio_ano, fim_ano, inicio_semestre, fim_semestre, data (2026-08-01) ou data ISO (2026-01-01T00:00:00.000Z)';

function inicioDoDia(ano, mes, dia) {
  return new Date(Date.UTC(ano, mes, dia, 0, 0, 0, 0)).toISOString();
}

function fimDoDia(ano, mes, dia) {
  return new Date(Date.UTC(ano, mes, dia, 23, 59, 59, 999)).toISOString();
}

// valor: string da config; campo: 'inicio' | 'fim'; referencia: Date
function resolverData(valor, campo, referencia = new Date()) {
  if (campo !== 'inicio' && campo !== 'fim') {
    throw new Error(`Campo de data inválido: "${campo}" (use "inicio" ou "fim")`);
  }
  if (!(referencia instanceof Date) || isNaN(referencia.getTime())) {
    throw new Error('Data de referência inválida');
  }

  const texto = String(valor ?? '').trim();
  const expr = texto.toLowerCase();
  const ano = referencia.getUTCFullYear();
  const mes = referencia.getUTCMonth();
  const dia = referencia.getUTCDate();
  const borda = campo === 'inicio' ? inicioDoDia : fimDoDia;

  if (ISO_ABSOLUTA.test(texto)) {
    // Já em UTC com Z: mantém exatamente como está (comportamento original)
    if (texto.endsWith('Z')) return texto;
    const d = new Date(texto);
    if (isNaN(d.getTime())) throw new Error(`Data inválida: "${texto}"`);
    return d.toISOString(); // converte offset (-03:00) para UTC com Z
  }

  const so = texto.match(SO_DATA);
  if (so) {
    const [a, m, d] = [Number(so[1]), Number(so[2]) - 1, Number(so[3])];
    const data = new Date(Date.UTC(a, m, d));
    if (data.getUTCFullYear() !== a || data.getUTCMonth() !== m || data.getUTCDate() !== d) {
      throw new Error(`Data inválida: "${texto}"`); // ex.: 2026-02-30
    }
    return borda(a, m, d);
  }

  if (expr === 'agora') return referencia.toISOString();
  if (expr === 'hoje') return borda(ano, mes, dia);

  const m = expr.match(DIAS_ATRAS);
  if (m) return borda(ano, mes, dia - parseInt(m[1], 10)); // Date.UTC trata virada de mês/ano

  const semestre2 = mes >= 6;
  switch (expr) {
    case 'inicio_ano': return inicioDoDia(ano, 0, 1);
    case 'fim_ano': return fimDoDia(ano, 11, 31);
    case 'inicio_semestre': return semestre2 ? inicioDoDia(ano, 6, 1) : inicioDoDia(ano, 0, 1);
    case 'fim_semestre': return semestre2 ? fimDoDia(ano, 11, 31) : fimDoDia(ano, 5, 30);
    default:
      throw new Error(`Expressão de data inválida: "${texto}". Use: ${EXPRESSOES_VALIDAS}`);
  }
}

// Resolve startDate/endDate de uma configuração ADS. Campos ausentes ficam ausentes.
// Lança erro se o período resultante for invertido.
function resolverPeriodo(config, referencia = new Date()) {
  const periodo = {};
  if (config.startDate !== undefined) {
    periodo.startDate = resolverData(config.startDate, 'inicio', referencia);
  }
  if (config.endDate !== undefined) {
    periodo.endDate = resolverData(config.endDate, 'fim', referencia);
  }
  if (periodo.startDate && periodo.endDate && new Date(periodo.startDate) > new Date(periodo.endDate)) {
    throw new Error(`Período inválido: startDate (${periodo.startDate}) é posterior a endDate (${periodo.endDate})`);
  }
  return periodo;
}

// Lê --inicio / --fim da linha de comando (sobrescrevem startDate/endDate de TODOS os ADS
// só nesta execução — config/ads-filters.json não é alterado):
//   --inicio 2026-08-01   --inicio=-30d   --fim hoje   --fim=2026-09-30
// Retorna { startDate?, endDate? } com os valores como digitados (resolvidos depois, por relatório),
// ou null quando nenhuma das duas flags foi usada. Valida já aqui para falhar antes de autenticar.
function lerArgsPeriodo(args, referencia = new Date()) {
  const flags = { '--inicio': 'startDate', '--fim': 'endDate' };
  const periodo = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, ...resto] = args[i].split('=');
    const chave = flags[flag];
    if (!chave) continue;
    let valor = resto.length ? resto.join('=') : args[i + 1];
    if (!resto.length) i++;
    // "-30d" começa com "-" mas é valor; só "--algo" indica flag sem valor
    if (!valor || valor.startsWith('--')) {
      throw new Error(`${flag} precisa de uma data (ex.: ${flag} 2026-08-01). Aceita: ${EXPRESSOES_VALIDAS}`);
    }
    periodo[chave] = valor.trim();
  }
  if (Object.keys(periodo).length === 0) return null;
  resolverPeriodo(periodo, referencia); // lança erro se inválido ou invertido
  return periodo;
}

module.exports = { resolverData, resolverPeriodo, lerArgsPeriodo, EXPRESSOES_VALIDAS };
