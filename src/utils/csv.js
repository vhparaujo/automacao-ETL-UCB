'use strict';

// Utilitários puros para leitura de cabeçalhos CSV (sem dependências externas).

const LIMITE_IDENTIFICADOR_MYSQL = 64;

// Faz o parse de UMA linha CSV seguindo a RFC 4180:
//   - campos separados por vírgula (ou pelo separador informado — ';' nos CSVs do sistema acadêmico);
//   - campos entre aspas podem conter o separador;
//   - "" dentro de um campo entre aspas representa uma aspa literal.
// Remove o BOM (﻿) do início e o \r final, se houver.
// Espaços em volta de cada campo são removidos (comportamento herdado do loader).
function parseLinhaCSV(linha, separador = ',') {
  const texto = String(linha).replace(/^﻿/, '').replace(/\r$/, '');
  const campos = [];
  let atual = '';
  let entreAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];

    if (entreAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          atual += '"'; // aspa escapada ("")
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        atual += ch;
      }
    } else if (ch === '"') {
      entreAspas = true;
    } else if (ch === separador) {
      campos.push(atual.trim());
      atual = '';
    } else {
      atual += ch;
    }
  }

  campos.push(atual.trim());
  return campos;
}

// Trunca os nomes de coluna para o limite do MySQL (64 caracteres) e desambigua
// colisões com sufixo _2, _3… (mantendo o total dentro do limite).
// A comparação é case-insensitive, pois o MySQL trata nomes de coluna assim.
// Retorna { nomes, colisoes }, onde colisoes = [{ original, final }].
// O MySQL compara nomes de coluna sem diferenciar maiúsculas NEM acentos
// ("RESPONSÁVEL FINANCEIRO" = "RESPONSAVEL FINANCEIRO" → Duplicate column name)
const chaveColunaMySQL = (nome) => nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function nomesColunasUnicos(colunas, limite = LIMITE_IDENTIFICADOR_MYSQL) {
  const usados = new Set();
  const nomes = [];
  const colisoes = [];

  for (const original of colunas) {
    let nome = original.substring(0, limite);

    if (usados.has(chaveColunaMySQL(nome))) {
      let n = 2;
      let candidato;
      do {
        const sufixo = `_${n}`;
        candidato = original.substring(0, limite - sufixo.length) + sufixo;
        n++;
      } while (usados.has(chaveColunaMySQL(candidato)));
      colisoes.push({ original, final: candidato });
      nome = candidato;
    }

    usados.add(chaveColunaMySQL(nome));
    nomes.push(nome);
  }

  return { nomes, colisoes };
}

// Parser CSV incremental (RFC 4180) para arquivos grandes, alimentado em pedaços (chunks).
// Suporta campos entre aspas com vírgulas, quebras de linha e "" (aspa literal), linhas \n, \r\n
// ou \r, e remove o BOM do início. Linhas totalmente vazias são ignoradas.
// Cada registro é entregue a onRegistro(campos) com os campos já sem espaços nas pontas.
//   const p = criarParserCSV((campos) => ...); p.push(chunk); ...; p.end();
function criarParserCSV(onRegistro, separador = ',') {
  let campo = '';
  let registro = [];
  let entreAspas = false;
  let aspaPendente = false; // viu " dentro de campo entre aspas: pode ser "" ou fim das aspas
  let ultimoFoiCR = false;
  let inicio = true;
  let campoTeveAspas = false;

  const fecharCampo = () => {
    registro.push(campo.trim());
    campo = '';
    campoTeveAspas = false;
  };
  const fecharRegistro = () => {
    fecharCampo();
    const vazio = registro.length === 1 && registro[0] === '';
    if (!vazio) onRegistro(registro);
    registro = [];
  };

  function push(texto) {
    let t = String(texto);
    if (inicio) {
      t = t.replace(/^\uFEFF/, '');
      if (t.length) inicio = false;
    }
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];

      if (entreAspas) {
        if (aspaPendente) {
          aspaPendente = false;
          if (ch === '"') { campo += '"'; continue; }
          entreAspas = false; // a aspa anterior fechou o campo; trata ch abaixo
        } else if (ch === '"') {
          aspaPendente = true;
          continue;
        } else {
          campo += ch;
          continue;
        }
      }

      if (ch === '\n' && ultimoFoiCR) { ultimoFoiCR = false; continue; }
      ultimoFoiCR = false;

      if (ch === '"' && !campoTeveAspas && campo.trim() === '') {
        entreAspas = true;
        campoTeveAspas = true;
        campo = '';
      } else if (ch === separador) {
        fecharCampo();
      } else if (ch === '\n') {
        fecharRegistro();
      } else if (ch === '\r') {
        fecharRegistro();
        ultimoFoiCR = true;
      } else {
        campo += ch;
      }
    }
  }

  function end() {
    if (aspaPendente) { aspaPendente = false; entreAspas = false; }
    if (campo !== '' || registro.length > 0 || campoTeveAspas) fecharRegistro();
  }

  return { push, end };
}

// Detecta o terminador de linha olhando a primeira quebra FORA de aspas do texto inicial do arquivo.
// Retorna '\r\n', '\n' ou '\r'; '\n' quando não há quebra no trecho (padrão anterior).
function detectarTerminadorLinha(texto) {
  const t = String(texto ?? '');
  let entreAspas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') entreAspas = !entreAspas; // "" (aspa escapada) alterna duas vezes: sem efeito
    else if (!entreAspas && ch === '\n') return '\n';
    else if (!entreAspas && ch === '\r') {
      if (i + 1 >= t.length) return '\r\n'; // \r no fim do trecho lido: assume \r\n (caso comum)
      return t[i + 1] === '\n' ? '\r\n' : '\r';
    }
  }
  return '\n';
}

// Lê só o início do arquivo (64 KB) e detecta o terminador de linha
function detectarTerminadorArquivo(caminho, bytes = 64 * 1024) {
  const fs = require('node:fs');
  const fd = fs.openSync(caminho, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const lidos = fs.readSync(fd, buffer, 0, bytes, 0);
    return detectarTerminadorLinha(buffer.subarray(0, lidos).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

// Formato do arquivo, detectado pelo início (1 MB):
//   separador   — ';' se o cabeçalho tem mais ';' do que ',' (CSV exportado do sistema acadêmico/Excel BR); senão ','
//   codificacao — 'utf8' se o trecho é UTF-8 válido; senão 'latin1' (ISO-8859-1/Windows-1252)
// Os CSVs do Brightspace (UTF-8, vírgula) continuam { separador: ',', codificacao: 'utf8' }.
function detectarFormatoCSV(buffer) {
  let trecho = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  // Corta na última quebra de linha para não pegar um caractere UTF-8 partido no fim do trecho
  const ultimaQuebra = trecho.lastIndexOf(0x0a);
  if (ultimaQuebra > 0) trecho = trecho.subarray(0, ultimaQuebra);

  let codificacao = 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trecho);
  } catch {
    codificacao = 'latin1';
  }

  const texto = trecho.toString(codificacao);
  const fimCabecalho = texto.search(/\r|\n/);
  const cabecalho = fimCabecalho === -1 ? texto : texto.slice(0, fimCabecalho);
  const contar = (c) => cabecalho.split(c).length - 1;
  const separador = contar(';') > contar(',') ? ';' : ',';

  return { separador, codificacao };
}

function detectarFormatoArquivo(caminho, bytes = 1024 * 1024) {
  const fs = require('node:fs');
  const fd = fs.openSync(caminho, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const lidos = fs.readSync(fd, buffer, 0, bytes, 0);
    return detectarFormatoCSV(buffer.subarray(0, lidos));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  detectarFormatoCSV,
  detectarFormatoArquivo,
  parseLinhaCSV,
  nomesColunasUnicos,
  criarParserCSV,
  detectarTerminadorLinha,
  detectarTerminadorArquivo,
  LIMITE_IDENTIFICADOR_MYSQL,
};
