'use strict';

// Lê os agendamentos de config/schedule.json.
//
// Formato atual — vários agendamentos, cada um com o que baixar:
//   "fuso_horario": "America/Sao_Paulo",
//   "agendamentos": [
//     { "nome": "...", "ativo": true, "cron": "0 6 * * *", "bds": "diferencial", "ads": true },
//     { "nome": "...", "ativo": true, "cron": "0 9 * * 1", "bds": "completo", "ads": false }
//   ]
//   bds: "completo" | "diferencial" | false     ads: true | false
//
// Formato antigo (ainda aceito) — um único "agendamento" que baixa o BDS completo e os ADS.

const TIPOS_BDS = ['completo', 'diferencial'];
const FUSO_PADRAO = 'America/Sao_Paulo';

// Padrão da UCB: diferencial gerado todo dia ~05:21 e completo segunda ~08:20 (Brasília)
const AGENDAMENTOS_PADRAO = [
  {
    nome: 'BDS diferencial + ADS',
    descricao: 'Todo dia às 6h — BDS diferencial do dia (gerado às ~5h20) e ADS',
    ativo: true,
    cron: '0 6 * * *',
    bds: 'diferencial',
    ads: true,
  },
  {
    nome: 'BDS completo',
    descricao: 'Segunda às 9h — BDS completo (o Brightspace gera às ~8h20)',
    ativo: true,
    cron: '0 9 * * 1',
    bds: 'completo',
    ads: false,
  },
];

// Retorna { fuso, agendamentos: [{ nome, descricao, ativo, cron, bds, ads }] }.
// Lança erro com mensagem clara se algum agendamento estiver mal configurado.
function lerAgendamentos(config) {
  const fuso = config?.fuso_horario || config?.agendamento?.fuso_horario || FUSO_PADRAO;

  let lista;
  if (Array.isArray(config?.agendamentos)) {
    lista = config.agendamentos;
  } else if (config?.agendamento) {
    const ag = config.agendamento;
    lista = [{ nome: 'Pipeline completo', descricao: ag.descricao, ativo: ag.ativo, cron: ag.cron, bds: 'completo', ads: true }];
  } else {
    lista = [];
  }

  const agendamentos = lista.map((ag, i) => {
    const nome = ag?.nome || `Agendamento ${i + 1}`;
    if (!ag?.cron || typeof ag.cron !== 'string') throw new Error(`Agendamento "${nome}": "cron" ausente`);
    const bds = ag.bds === undefined || ag.bds === null ? false : ag.bds;
    if (bds !== false && !TIPOS_BDS.includes(bds)) {
      throw new Error(`Agendamento "${nome}": "bds" deve ser "completo", "diferencial" ou false (veio ${JSON.stringify(ag.bds)})`);
    }
    return {
      nome,
      descricao: ag.descricao || '',
      ativo: ag.ativo !== false,
      cron: ag.cron.trim(),
      bds,
      ads: ag.ads === true,
    };
  });

  return { fuso, agendamentos };
}

// Texto curto do que o agendamento faz: "BDS diferencial + ADS", "só ADS"…
function descreverEtapas(ag) {
  const partes = [];
  if (ag.bds) partes.push(`BDS ${ag.bds}`);
  if (ag.ads) partes.push('ADS');
  return partes.length ? partes.join(' + ') : 'sem download (só carga/transformações)';
}

module.exports = { lerAgendamentos, descreverEtapas, AGENDAMENTOS_PADRAO, TIPOS_BDS, FUSO_PADRAO };
