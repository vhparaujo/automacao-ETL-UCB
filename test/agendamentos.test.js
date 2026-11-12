'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { lerAgendamentos, descreverEtapas, AGENDAMENTOS_PADRAO } = require('../src/utils/agendamentos');

test('config/schedule.json real: agendamentos válidos e crons aceitos pelo node-cron', () => {
  const config = require('../config/schedule.json');
  const { fuso, agendamentos } = lerAgendamentos(config);
  assert.equal(fuso, 'America/Sao_Paulo');
  assert.ok(agendamentos.length > 0);
  for (const ag of agendamentos) assert.ok(cron.validate(ag.cron), `cron inválido: ${ag.cron}`);
});

test('padrão: todo dia 6h diferencial + ADS, seg 9h completo', () => {
  const { agendamentos } = lerAgendamentos({ agendamentos: AGENDAMENTOS_PADRAO });
  assert.deepEqual(
    agendamentos.map((a) => [a.cron, a.bds, a.ads]),
    [['0 6 * * *', 'diferencial', true], ['0 9 * * 1', 'completo', false]]
  );
  for (const ag of agendamentos) assert.ok(cron.validate(ag.cron));
});

test('formato antigo (um "agendamento") vira BDS completo + ADS', () => {
  const { fuso, agendamentos } = lerAgendamentos({
    agendamento: { ativo: true, cron: '0 3 * * *', descricao: 'x', fuso_horario: 'America/Manaus' },
  });
  assert.equal(fuso, 'America/Manaus');
  assert.deepEqual(agendamentos, [{ nome: 'Pipeline completo', descricao: 'x', ativo: true, cron: '0 3 * * *', bds: 'completo', ads: true }]);
});

test('valida bds e cron; padrões de ativo/ads', () => {
  assert.throws(() => lerAgendamentos({ agendamentos: [{ nome: 'a', cron: '0 6 * * *', bds: 'full' }] }), /"bds" deve ser/);
  assert.throws(() => lerAgendamentos({ agendamentos: [{ nome: 'a' }] }), /"cron" ausente/);
  const { agendamentos } = lerAgendamentos({ agendamentos: [{ cron: '0 6 * * *' }] });
  assert.deepEqual(agendamentos[0], { nome: 'Agendamento 1', descricao: '', ativo: true, cron: '0 6 * * *', bds: false, ads: false });
  assert.deepEqual(lerAgendamentos({}).agendamentos, []);
});

test('descreverEtapas', () => {
  assert.equal(descreverEtapas({ bds: 'diferencial', ads: true }), 'BDS diferencial + ADS');
  assert.equal(descreverEtapas({ bds: false, ads: true }), 'ADS');
  assert.equal(descreverEtapas({ bds: false, ads: false }), 'sem download (só carga/transformações)');
});
