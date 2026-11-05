'use strict';

// Extração de ZIP em streaming (só módulos nativos: fs + zlib).
//
// Por que não adm-zip: ele descompacta cada arquivo inteiro em memória (Buffer) antes de
// gravar. Alguns BDS passam do limite — o "Log de acesso ao sistema" vem num ZIP de 1,2 GB
// com um CSV de 7,4 GB → "Cannot create a Buffer larger than … bytes".
// Aqui lemos o diretório central do ZIP (com suporte a ZIP64, necessário acima de 4 GB) e
// descompactamos cada entrada direto para o disco, com uso de memória constante.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

async function lerTrecho(fh, posicao, tamanho) {
  const buf = Buffer.alloc(tamanho);
  const { bytesRead } = await fh.read(buf, 0, tamanho, posicao);
  return buf.subarray(0, bytesRead);
}

function u64(buf, pos) {
  const v = buf.readBigUInt64LE(pos);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP: valor de 64 bits grande demais');
  return Number(v);
}

// Localiza o "End of Central Directory" (e o registro ZIP64, se houver)
async function lerFimDoDiretorio(fh, tamanhoArquivo) {
  const janela = Math.min(tamanhoArquivo, 22 + 65535);
  const inicioJanela = tamanhoArquivo - janela;
  const buf = await lerTrecho(fh, inicioJanela, janela);

  let pos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { pos = i; break; }
  }
  if (pos < 0) throw new Error('ZIP inválido: fim do diretório central não encontrado (download incompleto?)');

  let total = buf.readUInt16LE(pos + 10);
  let tamanhoDir = buf.readUInt32LE(pos + 12);
  let inicioDir = buf.readUInt32LE(pos + 16);

  if (total === MAX_U16 || tamanhoDir === MAX_U32 || inicioDir === MAX_U32) {
    const posLocator = inicioJanela + pos - 20;
    const loc = await lerTrecho(fh, posLocator, 20);
    if (loc.length < 20 || loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) {
      throw new Error('ZIP64 inválido: localizador não encontrado');
    }
    const z = await lerTrecho(fh, u64(loc, 8), 56);
    if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('ZIP64 inválido: registro final não encontrado');
    total = u64(z, 32);
    tamanhoDir = u64(z, 40);
    inicioDir = u64(z, 48);
  }
  return { total, tamanhoDir, inicioDir };
}

// Lê o diretório central → [{ nome, metodo, criptografado, tamanhoCompactado, tamanho, offsetLocal }]
async function listarEntradas(zipPath) {
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const { total, tamanhoDir, inicioDir } = await lerFimDoDiretorio(fh, size);
    const dir = await lerTrecho(fh, inicioDir, tamanhoDir);

    const entradas = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error('ZIP inválido: diretório central corrompido');
      }
      const flags = dir.readUInt16LE(p + 8);
      const metodo = dir.readUInt16LE(p + 10);
      let tamanhoCompactado = dir.readUInt32LE(p + 20);
      let tamanho = dir.readUInt32LE(p + 24);
      const lenNome = dir.readUInt16LE(p + 28);
      const lenExtra = dir.readUInt16LE(p + 30);
      const lenComentario = dir.readUInt16LE(p + 32);
      let offsetLocal = dir.readUInt32LE(p + 42);

      const bytesNome = dir.subarray(p + 46, p + 46 + lenNome);
      const nome = bytesNome.toString(flags & 0x800 ? 'utf8' : 'latin1');

      // Campo extra ZIP64 (id 0x0001): traz, nesta ordem, só os valores que estouraram 32 bits
      let e = p + 46 + lenNome;
      const fimExtra = e + lenExtra;
      while (e + 4 <= fimExtra) {
        const id = dir.readUInt16LE(e);
        const len = dir.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (tamanho === MAX_U32) { tamanho = u64(dir, q); q += 8; }
          if (tamanhoCompactado === MAX_U32) { tamanhoCompactado = u64(dir, q); q += 8; }
          if (offsetLocal === MAX_U32) { offsetLocal = u64(dir, q); q += 8; }
        }
        e += 4 + len;
      }

      entradas.push({
        nome,
        diretorio: nome.endsWith('/'),
        metodo,
        criptografado: (flags & 0x1) === 1,
        tamanhoCompactado,
        tamanho,
        offsetLocal,
      });
      p = fimExtra + lenComentario;
    }
    return entradas;
  } finally {
    await fh.close();
  }
}

// Descompacta uma entrada direto para destino (streaming)
async function extrairEntrada(zipPath, entrada, destino) {
  if (entrada.criptografado) throw new Error(`ZIP: ${entrada.nome} está criptografado`);
  if (entrada.metodo !== 0 && entrada.metodo !== 8) {
    throw new Error(`ZIP: método de compressão ${entrada.metodo} não suportado (${entrada.nome})`);
  }

  const fh = await fs.promises.open(zipPath, 'r');
  let inicioDados;
  try {
    const local = await lerTrecho(fh, entrada.offsetLocal, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`ZIP inválido: cabeçalho local de ${entrada.nome} não encontrado`);
    }
    inicioDados = entrada.offsetLocal + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }

  let gravados = 0;
  const contador = new Transform({
    transform(chunk, _enc, cb) { gravados += chunk.length; cb(null, chunk); },
  });

  const etapas = [];
  if (entrada.tamanhoCompactado > 0) {
    etapas.push(fs.createReadStream(zipPath, {
      start: inicioDados,
      end: inicioDados + entrada.tamanhoCompactado - 1,
      highWaterMark: 1024 * 1024,
    }));
    if (entrada.metodo === 8) etapas.push(zlib.createInflateRaw());
  } else {
    etapas.push(Readable.from([]));
  }
  etapas.push(contador, fs.createWriteStream(destino));

  try {
    await pipeline(...etapas);
  } catch (e) {
    fs.rmSync(destino, { force: true });
    throw e;
  }
  if (gravados !== entrada.tamanho) {
    fs.rmSync(destino, { force: true });
    throw new Error(`ZIP: ${entrada.nome} extraído com ${gravados} bytes, esperado ${entrada.tamanho}`);
  }
  return gravados;
}

// Extrai os .csv do ZIP para destDir (sem subpastas). renomear(nomeOriginal) → nome do arquivo final.
// Retorna os caminhos gravados.
async function extrairCsvs(zipPath, destDir, renomear = (n) => n) {
  const gravados = [];
  for (const entrada of await listarEntradas(zipPath)) {
    if (entrada.diretorio || !entrada.nome.toLowerCase().endsWith('.csv')) continue;
    const nomeFinal = path.basename(renomear(path.basename(entrada.nome)));
    const destino = path.join(destDir, nomeFinal);
    await extrairEntrada(zipPath, entrada, destino);
    gravados.push(destino);
  }
  return gravados;
}

module.exports = { listarEntradas, extrairEntrada, extrairCsvs };
