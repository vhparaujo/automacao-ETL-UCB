'use strict';

// Utilitários puros para leitura de cabeçalhos CSV (sem dependências externas).

const LIMITE_IDENTIFICADOR_MYSQL = 64;

// Faz o parse de UMA linha CSV seguindo a RFC 4180:
//   - campos separados por vírgula;
//   - campos entre aspas podem conter vírgulas;
//   - "" dentro de um campo entre aspas representa uma aspa literal.
// Remove o BOM (﻿) do início e o \r final, se houver.
// Espaços em volta de cada campo são removidos (comportamento herdado do loader).
function parseLinhaCSV(linha) {
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
    } else if (ch === ',') {
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
function nomesColunasUnicos(colunas, limite = LIMITE_IDENTIFICADOR_MYSQL) {
  const usados = new Set();
  const nomes = [];
  const colisoes = [];

  for (const original of colunas) {
    let nome = original.substring(0, limite);

    if (usados.has(nome.toLowerCase())) {
      let n = 2;
      let candidato;
      do {
        const sufixo = `_${n}`;
        candidato = original.substring(0, limite - sufixo.length) + sufixo;
        n++;
      } while (usados.has(candidato.toLowerCase()));
      colisoes.push({ original, final: candidato });
      nome = candidato;
    }

    usados.add(nome.toLowerCase());
    nomes.push(nome);
  }

  return { nomes, colisoes };
}

// Parser CSV incremental (RFC 4180) para arquivos grandes, alimentado em pedaços (chunks).
// Suporta campos entre aspas com vírgulas, quebras de linha e "" (aspa literal), linhas \n, \r\n
// ou \r, e remove o BOM do início. Linhas totalmente vazias são ignoradas.
// Cada registro é entregue a onRegistro(campos) com os campos já sem espaços nas pontas.
//   const p = criarParserCSV((campos) => ...); p.push(chunk); ...; p.end();
function criarParserCSV(onRegistro) {
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
      } else if (ch === ',') {
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

module.exports = {
  parseLinhaCSV,
  nomesColunasUnicos,
  criarParserCSV,
  detectarTerminadorLinha,
  detectarTerminadorArquivo,
  LIMITE_IDENTIFICADOR_MYSQL,
};
