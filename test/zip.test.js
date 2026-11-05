'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { listarEntradas, extrairCsvs } = require('../src/utils/zip');

function criarZip(dir, arquivos, opcoes = {}) {
  const zip = new AdmZip();
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    zip.addFile(nome, Buffer.from(conteudo, 'utf8'));
    if (opcoes.semCompressao) zip.getEntry(nome).header.method = 0;
  }
  const p = path.join(dir, 'teste.zip');
  zip.writeZip(p);
  return p;
}

test('extrairCsvs: extrai só os .csv, sem subpastas, com conteúdo idêntico (deflate)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const csv = 'UserId,Nome\n1,José\n2,"Ana, Maria"\n'.repeat(5000);
  const zipPath = criarZip(dir, { 'pasta/Users.csv': csv, 'leia.txt': 'x', 'Vazio.csv': '' });
  const destino = path.join(dir, 'out');
  fs.mkdirSync(destino);

  const gravados = await extrairCsvs(zipPath, destino);
  assert.deepStrictEqual(gravados.map((g) => path.basename(g)).sort(), ['Users.csv', 'Vazio.csv']);
  assert.strictEqual(fs.readFileSync(path.join(destino, 'Users.csv'), 'utf8'), csv);
  assert.strictEqual(fs.readFileSync(path.join(destino, 'Vazio.csv'), 'utf8'), '');
  assert.ok(!fs.existsSync(path.join(destino, 'leia.txt')));
});

test('extrairCsvs: entrada sem compressão (stored) e renomear (nome fixo do ADS)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const zipPath = criarZip(dir, { 'Relatorio 123.csv': 'a,b\n1,2\n' }, { semCompressao: true });
  const [g] = await extrairCsvs(zipPath, dir, () => 'notas_finais.csv');
  assert.strictEqual(path.basename(g), 'notas_finais.csv');
  assert.strictEqual(fs.readFileSync(g, 'utf8'), 'a,b\n1,2\n');
});

test('listarEntradas: tamanhos do diretório central', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const zipPath = criarZip(dir, { 'A.csv': 'abc' });
  const [e] = await listarEntradas(zipPath);
  assert.strictEqual(e.nome, 'A.csv');
  assert.strictEqual(e.tamanho, 3);
  assert.strictEqual(e.criptografado, false);
});

test('listarEntradas: arquivo que não é ZIP (download incompleto) → erro claro', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const p = path.join(dir, 'ruim.zip');
  fs.writeFileSync(p, 'isto não é um zip');
  await assert.rejects(listarEntradas(p), /fim do diretório central não encontrado/);
});
