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

module.exports = { parseLinhaCSV, nomesColunasUnicos, LIMITE_IDENTIFICADOR_MYSQL };
