'use strict';

// Utilitários puros para leitura de CSV (sem dependências externas) — usados pelo inventário.

// Faz o parse de UMA linha CSV seguindo a RFC 4180:
//   - campos separados por vírgula;
//   - campos entre aspas podem conter vírgulas;
//   - "" dentro de um campo entre aspas representa uma aspa literal.
// Remove o BOM (﻿) do início e o \r final, se houver.
// Espaços em volta de cada campo são removidos.
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

module.exports = {
  parseLinhaCSV,
  criarParserCSV,
};
