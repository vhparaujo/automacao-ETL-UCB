'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarParserCSV, parseLinhaCSV } = require('../src/utils/csv');
const {
  detectarFormatoData, ehColunaData, ehColunaId, mascarar,
  analisarCSV, gerarMarkdown, identificarOrigem,
} = require('../src/utils/inventario');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inventario-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function parsear(texto, tamanhoChunk = Infinity) {
  const out = [];
  const p = criarParserCSV((r) => out.push(r));
  if (tamanhoChunk === Infinity) p.push(texto);
  else for (let i = 0; i < texto.length; i += tamanhoChunk) p.push(texto.slice(i, i + tamanhoChunk));
  p.end();
  return out;
}

// ── Formato de data ────────────────────────────────────────────────
test('detectarFormatoData reconhece os formatos pedidos', () => {
  assert.equal(detectarFormatoData('2021-03-08T21:18:31.003Z'), 'ISO com Z');
  assert.equal(detectarFormatoData('2021-03-08T21:18Z'), 'ISO com Z');
  assert.equal(detectarFormatoData('2021-03-08T21:18:31-03:00'), 'ISO com offset');
  assert.equal(detectarFormatoData('2021-03-08T21:18:31'), 'ISO sem fuso');
  assert.equal(detectarFormatoData('2021-03-08 21:18:31.5'), 'ISO sem fuso');
  assert.equal(detectarFormatoData('2021-03-08'), 'ISO sem fuso');
  assert.equal(detectarFormatoData('08/03/2021'), 'dd/mm/aaaa');
  assert.equal(detectarFormatoData('8/3/2021'), 'dd/mm/aaaa');
  assert.equal(detectarFormatoData('08/03/2021 21:18'), 'dd/mm/aaaa hh:mm');
  assert.equal(detectarFormatoData('08/03/2021 21:18:31'), 'dd/mm/aaaa hh:mm');
  assert.equal(detectarFormatoData('março de 2021'), 'outro');
  assert.equal(detectarFormatoData('1615238311'), 'outro');
  assert.equal(detectarFormatoData(''), null);
});

test('ehColunaData e ehColunaId pelos nomes', () => {
  for (const n of ['CreationDate', 'DateDeleted', 'Data de Liberação da Nota', 'Última Modificação', 'Ultimo Logon', 'Timestamp', 'TimeSpent', 'Data da Última Visita', 'LastAccessed', 'DayAccessed', 'Hora de acesso']) {
    assert.ok(ehColunaData(n), n);
  }
  assert.ok(!ehColunaData('FirstName'));
  for (const n of ['UserId', 'OrgDefinedId', 'ID Definido da Organização', 'Id da Função', 'id', 'Identifier']) assert.ok(ehColunaId(n), n);
  for (const n of ['IsHidden', 'Width', 'Nome', 'Ativo', 'Valid']) assert.ok(!ehColunaId(n), n);
});

test('mascarar não expõe o conteúdo', () => {
  assert.equal(mascarar('3 de março, 21h18'), '9 xx xxxxx, 99x99');
});

// ── Parser de cabeçalho / registros ────────────────────────────────
test('cabeçalho com aspas, vírgulas, "" e BOM (parseLinhaCSV e parser em stream)', () => {
  const linha = '﻿"ID Definido da Organização","Nota, ajustada","Nome ""curto""",Data\r';
  const esperado = ['ID Definido da Organização', 'Nota, ajustada', 'Nome "curto"', 'Data'];
  assert.deepEqual(parseLinhaCSV(linha), esperado);
  assert.deepEqual(parsear(linha + '\n')[0], esperado);
});

test('parser em stream: \\r\\n, campos multilinha, linhas vazias e qualquer tamanho de chunk', () => {
  const texto = '﻿a,b,c\r\n1,"linha\r\nquebrada",3\r\n\r\n4,,""\n5,"x ""y""",7';
  const esperado = [['a', 'b', 'c'], ['1', 'linha\r\nquebrada', '3'], ['4', '', ''], ['5', 'x "y"', '7']];
  for (const chunk of [Infinity, 1, 2, 3, 7]) assert.deepEqual(parsear(texto, chunk), esperado, `chunk ${chunk}`);
});

// ── Análise e privacidade ──────────────────────────────────────────
test('analisarCSV conta registros, detecta datas/IDs e o markdown não expõe dados pessoais', async () => {
  const csv = path.join(TMP, 'Users.csv');
  fs.writeFileSync(csv, [
    '﻿UserId,OrgDefinedId,FirstName,ExternalEmail,CreationDate,"Data, de acesso"',
    '1,A123,Fulano Secreto,fulano@exemplo.com,2021-03-08T21:18:31.003Z,08/03/2021 10:00',
    '2,456,"Beltrano, Segredo",beltrano@exemplo.com,,03/2021',
    '3,789,"Ciclano\r\nQuebrado",c@exemplo.com,2021-03-09T00:00:00.000Z,',
  ].join('\r\n') + '\r\n');

  const a = await analisarCSV(csv);
  assert.equal(a.registros, 3);
  assert.deepEqual(a.colunas, ['UserId', 'OrgDefinedId', 'FirstName', 'ExternalEmail', 'CreationDate', 'Data, de acesso']);
  const [creation, acesso] = a.datas;
  assert.deepEqual(creation.formatos, { 'ISO com Z': 2 });
  assert.equal(creation.vazios, 1);
  assert.deepEqual(acesso.formatos, { 'dd/mm/aaaa hh:mm': 1, outro: 1 });
  const [userId, orgDefined] = a.ids;
  assert.equal(userId.naoNumericos, 0);
  assert.equal(orgDefined.naoNumericos, 1);

  const md = gerarMarkdown([{ arquivo: 'Users.csv', mb: '0.0', origem: 'BDS', ...a }]);
  for (const segredo of ['Fulano', 'Beltrano', 'Ciclano', 'exemplo.com', 'A123', '456', '789']) {
    assert.ok(!md.includes(segredo), `inventário expôs "${segredo}"`);
  }
  assert.ok(md.includes('2021-03-08T21:18:31.003Z'), 'deve mostrar exemplo da coluna de data');
});

test('analisarCSV respeita o limite de amostra mas conta todos os registros', async () => {
  const csv = path.join(TMP, 'grande.csv');
  const linhas = ['Id,DateX'];
  for (let i = 0; i < 1500; i++) linhas.push(i < 1000 ? `${i},2021-01-01` : `x${i},lixo`);
  fs.writeFileSync(csv, linhas.join('\n'));
  const a = await analisarCSV(csv);
  assert.equal(a.registros, 1500);
  assert.equal(a.amostradas, 1000);
  assert.equal(a.ids[0].naoNumericos, 0);
  assert.deepEqual(a.datas[0].formatos, { 'ISO sem fuso': 1000 });
});

test('identificarOrigem: ADS pelo nome gerado / arquivo_csv, BDS pelo manifesto ou pela seleção', () => {
  const ctx = {
    adsConfig: { _x: 'y', 'Notas finais': {}, 'Premiações emitidas': { arquivo_csv: 'ads_premiacoes_emitidas' } },
    bdsSelecao: { automaticos: ['Usuários', 'Premiações emitidas'] },
    manifesto: { 'Users.csv': { dataset: 'Usuários', tipo: 'Full' } },
  };
  assert.equal(identificarOrigem('csvs/notas_finais.csv', ctx), 'ADS — "Notas finais"');
  assert.equal(identificarOrigem('csvs/ads_premiacoes_emitidas.csv', ctx), 'ADS — "Premiações emitidas"');
  assert.equal(identificarOrigem('csvs/Users.csv', ctx), 'BDS — "Usuários"');
  assert.equal(identificarOrigem('csvs/Premiacoes_emitidas.csv', ctx), 'BDS — "Premiações emitidas"');
  assert.match(identificarOrigem('csvs/AwardsIssued.csv', ctx), /provavelmente BDS/);
});
