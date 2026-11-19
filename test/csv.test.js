'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLinhaCSV, nomesColunasUnicos, criarParserCSV, detectarFormatoCSV } = require('../src/utils/csv');

test('cabeçalho simples', () => {
  assert.deepEqual(parseLinhaCSV('UserId,UserName,IsActive'), ['UserId', 'UserName', 'IsActive']);
});

test('campos entre aspas simples (sem vírgula) têm as aspas removidas', () => {
  assert.deepEqual(parseLinhaCSV('"UserId","UserName"'), ['UserId', 'UserName']);
});

test('campo com vírgula entre aspas não desalinha as colunas', () => {
  assert.deepEqual(parseLinhaCSV('Id,"Nota, ajustada",Final'), ['Id', 'Nota, ajustada', 'Final']);
});

test('aspas escapadas ("") viram aspa literal', () => {
  assert.deepEqual(parseLinhaCSV('Id,"Nome ""apelido""",X'), ['Id', 'Nome "apelido"', 'X']);
  assert.deepEqual(parseLinhaCSV('"a ""b"", c"'), ['a "b", c']);
});

test('remove BOM do início', () => {
  assert.deepEqual(parseLinhaCSV('﻿UserId,UserName'), ['UserId', 'UserName']);
  assert.deepEqual(parseLinhaCSV('﻿"UserId",UserName'), ['UserId', 'UserName']);
});

test('remove \\r final (linhas \\r\\n)', () => {
  assert.deepEqual(parseLinhaCSV('A,B,C\r'), ['A', 'B', 'C']);
  assert.deepEqual(parseLinhaCSV('A,"B"\r'), ['A', 'B']);
});

test('campos vazios são preservados', () => {
  assert.deepEqual(parseLinhaCSV('A,,C,'), ['A', '', 'C', '']);
});

test('nomes sem colisão continuam iguais (apenas truncados)', () => {
  const longo = 'x'.repeat(70);
  const { nomes, colisoes } = nomesColunasUnicos(['A', 'B', longo]);
  assert.deepEqual(nomes, ['A', 'B', 'x'.repeat(64)]);
  assert.equal(colisoes.length, 0);
});

test('colisão após truncamento para 64 caracteres recebe sufixo _2, _3', () => {
  const prefixo = 'P'.repeat(64);
  const cols = [`${prefixo}_primeiro`, `${prefixo}_segundo`, `${prefixo}_terceiro`];
  const { nomes, colisoes } = nomesColunasUnicos(cols);

  assert.equal(nomes[0], prefixo);
  assert.equal(nomes[1], 'P'.repeat(62) + '_2');
  assert.equal(nomes[2], 'P'.repeat(62) + '_3');
  assert.ok(nomes.every((n) => n.length <= 64));
  assert.equal(new Set(nomes).size, 3);
  assert.equal(colisoes.length, 2);
  assert.equal(colisoes[0].original, cols[1]);
});

test('colisão é case-insensitive (como no MySQL) e sufixo não colide com coluna existente', () => {
  const { nomes } = nomesColunasUnicos(['Nome', 'NOME', 'Nome_2']);
  assert.deepEqual(nomes, ['Nome', 'NOME_2', 'Nome_2_2']);
});

// ── Terminador de linha (LOAD DATA) ────────────────────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectarTerminadorLinha, detectarTerminadorArquivo } = require('../src/utils/csv');

test('detectarTerminadorLinha: \\r\\n, \\n e \\r', () => {
  assert.equal(detectarTerminadorLinha('a,b\r\n1,2\r\n'), '\r\n');
  assert.equal(detectarTerminadorLinha('﻿a,b\n1,2\n'), '\n');
  assert.equal(detectarTerminadorLinha('a,b\r1,2\r'), '\r');
  assert.equal(detectarTerminadorLinha('a,b\r'), '\r\n'); // \r no fim do trecho lido
});

test('detectarTerminadorLinha ignora quebras dentro de aspas no cabeçalho', () => {
  assert.equal(detectarTerminadorLinha('"col\ncom quebra",b\r\n1,2'), '\r\n');
  assert.equal(detectarTerminadorLinha('"a ""x""\r\n",b\n1,2'), '\n');
});

test('detectarTerminadorLinha sem quebra usa \\n (padrão anterior)', () => {
  assert.equal(detectarTerminadorLinha('a,b,c'), '\n');
  assert.equal(detectarTerminadorLinha(''), '\n');
});

test('detectarTerminadorArquivo lê só o início do arquivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminador-'));
  try {
    fs.writeFileSync(path.join(dir, 'crlf.csv'), 'a,b\r\n' + '1,2\n'.repeat(10));
    fs.writeFileSync(path.join(dir, 'lf.csv'), 'a,b\n1,2\n');
    assert.equal(detectarTerminadorArquivo(path.join(dir, 'crlf.csv')), '\r\n');
    assert.equal(detectarTerminadorArquivo(path.join(dir, 'lf.csv')), '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── CSVs do sistema acadêmico (csvs/manuais/): ';' e latin1 ─────────

test('parseLinhaCSV e criarParserCSV aceitam outro separador (;)', () => {
  assert.deepEqual(parseLinhaCSV('RA;"RUA; 10";VALOR\r', ';'), ['RA', 'RUA; 10', 'VALOR']);
  const out = [];
  const p = criarParserCSV((r) => out.push(r), ';');
  p.push('A;B\r\n1,5;"x;y"\r\n'); p.end();
  assert.deepEqual(out, [['A', 'B'], ['1,5', 'x;y']]);
});

test('detectarFormatoCSV: separador pelo cabeçalho e codificação (UTF-8 válido ou latin1)', () => {
  assert.deepEqual(detectarFormatoCSV(Buffer.from('UserId,UserName\r\n1,ana\r\n')), { separador: ',', codificacao: 'utf8' });
  assert.deepEqual(detectarFormatoCSV(Buffer.from('\uFEFFNome,Descrição\n')), { separador: ',', codificacao: 'utf8' });
  assert.deepEqual(detectarFormatoCSV(Buffer.from('NÍVEL;CRÉD. ALUNO\r\n1;2,5\r\n', 'latin1')), { separador: ';', codificacao: 'latin1' });
  assert.deepEqual(detectarFormatoCSV(Buffer.from('NÍVEL;CRÉD. ALUNO\r\n', 'utf8')), { separador: ';', codificacao: 'utf8' });
  // cabeçalho com ',' dentro de nome entre aspas mas separado por ';'
  assert.equal(detectarFormatoCSV(Buffer.from('A;B;"C, D"\n')).separador, ';');
  // caractere UTF-8 partido no fim do trecho lido não vira latin1
  const parcial = Buffer.from('Nome,Descrição\nação', 'utf8');
  assert.equal(detectarFormatoCSV(parcial.subarray(0, parcial.length - 1)).codificacao, 'utf8');
  assert.deepEqual(detectarFormatoCSV(Buffer.alloc(0)), { separador: ',', codificacao: 'utf8' });
});

test('nomesColunasUnicos desambigua nomes que só diferem por acento', () => {
  assert.deepEqual(nomesColunasUnicos(['ÁREA', 'AREA', 'Area']).nomes, ['ÁREA', 'AREA_2', 'Area_3']);
});
