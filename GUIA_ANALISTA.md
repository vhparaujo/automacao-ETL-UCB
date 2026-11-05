# Guia do Analista — criando queries e views

Este guia é para quem vai **escrever SQL** em cima dos dados do Brightspace: views para o
PowerBI, CSVs para entrega e tabelas auxiliares. Não é preciso mexer em código Node.js —
só em arquivos `.sql` e em `config/transforms.json`.

---

## 1. Como os dados chegam até você

```
Brightspace ──(madrugada)──► csvs/*.csv ──► MySQL (data_ucb) ──► suas queries (.sql) ──► PowerBI / exports/
```

Toda madrugada o pipeline baixa os CSVs, **recarrega as tabelas do zero** e em seguida executa,
em ordem, todas as transformações ativas de `config/transforms.json`. Ou seja: uma view
registrada lá é recriada automaticamente todo dia, logo depois da carga.

**Duas origens de dados:**

| Origem | O que é | Nome das colunas | Filtros |
|---|---|---|---|
| **BDS** (Brightspace Data Sets) | Extração **completa da instituição inteira**, todo o histórico | Inglês (`UserId`, `OrgUnitId`…) | **Nenhum** — você filtra no `WHERE` |
| **ADS** (Advanced Data Sets) | Relatório gerado com filtros (período, unidade, roles) definidos em `config/ads-filters.json` | Português, com espaços e acentos | Já vêm filtrados |

> Consequência prática: em tabelas BDS, quase toda query precisa filtrar **período**, **tipo de
> unidade organizacional** e **registros apagados**. Sem isso você conta 10 anos de dados,
> grupos, templates etc.

---

## 2. Conhecendo as tabelas

### 2.1 Inventário (comece por aqui)

```bash
npm run inventario
```

Abra `exports/_inventario_csvs.md`. Para cada CSV ele mostra:

- a **tabela MySQL** de destino e se ela tem **schema fixo** (📋) ou **todas as colunas TEXT** (🔍);
- a lista de colunas;
- o **formato das datas** (ex.: `2026-11-01T21:53:49.3100000Z` → "ISO com Z");
- se as colunas de ID são **todas numéricas** (ex.: `OrgDefinedId` em `Users` **não** é — tem letras).

O inventário não mostra nenhum dado pessoal, então pode ser compartilhado.

### 2.2 Conectando no MySQL

O MySQL roda em Docker (`npm run db:up` para subir).

| Campo | Valor |
|---|---|
| Host | `127.0.0.1` |
| Porta | `3307` |
| Usuário | `dataUCB` (senha no `.env`, peça a quem administra) |
| Banco | `data_ucb` |

Use MySQL Workbench, DBeaver ou outro cliente. Comandos úteis:

```sql
SHOW TABLES;
DESCRIBE organizationalunits;                         -- colunas e tipos
SELECT * FROM organizationalunits LIMIT 50;           -- olhar os dados
SELECT Type, COUNT(*) FROM organizationalunits GROUP BY Type ORDER BY 2 DESC;  -- valores possíveis
```

> Tabelas grandes (`courseaccess` ~22 mi linhas, `userenrollments` ~14 mi, `graderesults` ~13 mi):
> sempre use `LIMIT` ao explorar e filtre antes de fazer `JOIN`.
>
> **Workbench:** o tempo limite padrão é 30 s (`Error Code: 2013. Lost connection to MySQL server
> during query`). Aumente em *Settings → SQL Editor → DBMS connection read timeout interval* (ex.: 600)
> e reabra a conexão. Atenção: quando o Workbench desiste, a consulta **continua rodando no servidor** —
> veja com `SHOW PROCESSLIST;` e encerre com `KILL QUERY <Id>;`.

### 2.4 Índices (já existem — você não precisa fazer nada)

As tabelas com schema fixo são carregadas com índices nas colunas usadas em `JOIN`/`WHERE`
(ex.: `UserId`, `OrgUnitId`, `RoleId`, `Type`) e com estatísticas atualizadas (`ANALYZE TABLE`).
Consultas como "alunos sem acesso" (cruzando `userenrollments` × `courseaccess`) levam segundos.
Veja os índices de uma tabela com `SHOW INDEX FROM userenrollments;`.

Se uma consulta sua cruzar ou filtrar uma coluna sem índice e ficar lenta, adicione em
`config/schemas.json`, na entrada da tabela, e rode `npm run load` (ou espere a madrugada):

```json
"indices": [["UserId"], ["OrgUnitId", "RoleId"]]
```

Cada item é um índice; um índice com várias colunas serve para filtros que usam a primeira coluna
(ou a primeira e a segunda juntas). Não crie índice à mão com `CREATE INDEX`: a tabela é recriada na
próxima carga e ele some. Tabelas sem schema (🔍 TEXT) não têm índices.

### 2.3 O que cada coluna significa

O inventário diz **quais** colunas existem, não **o que significam**. A referência oficial é a
documentação dos **Brightspace Data Sets** da D2L (busque pelo nome do dataset, ex.:
"Brightspace Data Sets Users", "Organizational Units", "User Enrollments").

---

## 3. Tipos de coluna: o que muda na sua query

### 3.1 Tabelas com schema fixo (📋)

Definidas em `config/schemas.json`, com tipos de verdade (`INT`, `DATETIME`, `DECIMAL`…).
Datas e números funcionam direto:

```sql
WHERE ou.CreatedDate >= '2026-07-01'
```

### 3.2 Tabelas sem schema (🔍 — todas as colunas TEXT)

Todo dataset sem entrada em `config/schemas.json` é carregado com **todas as colunas TEXT**
(para nunca perder dado por tipo errado). Você converte na query:

```sql
-- Data ISO com Z (ex.: 2024-03-12T03:00:00.0000000Z) → DATETIME (UTC)
STR_TO_DATE(LEFT(ExpiryDate, 19), '%Y-%m-%dT%H:%i:%s')

-- Número inteiro / decimal
CAST(AwardId AS UNSIGNED)
CAST(Score AS DECIMAL(10,2))

-- Booleano (os CSVs trazem TRUE/FALSE)
UPPER(IsDeleted) = 'FALSE'

-- Vazio no CSV vira NULL (não string vazia)
WHERE ExpiryDate IS NOT NULL
```

Se você usa muito uma tabela TEXT, vale pedir para incluí-la em `config/schemas.json` com
os tipos certos (aí as conversões acima deixam de ser necessárias).

### 3.3 Datas são UTC

Todas as datas do Brightspace estão em **UTC**. Para horário de Brasília:

```sql
DATE_SUB(DayAccessed, INTERVAL 3 HOUR)
```

### 3.4 Colunas com espaço e acento (ADS)

Tabelas ADS (`notas_finais`, `uso_do_instrutor`, `uso_do_aluno`…) têm nomes em português.
Use **crase**:

```sql
SELECT `ID do Usuário`, `Nome da oferta de curso` FROM notas_finais;
```

Nomes com mais de 64 caracteres são **truncados** pelo MySQL (e, se colidirem, recebem `_2`,
`_3`). Confira com `DESCRIBE <tabela>`.

---

## 4. Filtros típicos dos BDS

```sql
-- Só disciplinas (ofertas de curso) — exclui grupos, templates, seções, departamentos
WHERE ou.Type = 'Course Offering'

-- Ignorar registros apagados
  AND ou.IsDeleted = 0

-- Período: semestre 2026/2
  AND ue.EnrollmentDate >= '2026-07-01' AND ue.EnrollmentDate < '2027-01-01'

-- Só alunos (RoleId numérico — veja os IDs com: npm run roles)
  AND ue.RoleId = 110   -- "Aluno" (há também 175 Aluno Uniubec e 172 Aluno Esperançar)
```

Valores reais de `organizationalunits.Type` (nov/2026): `Course Offering`, `Group`,
`Course Template`, `Cursos`, `Período Letivo`, `Section`, `Segmento`, `Filial`…
Sempre confira com `SELECT DISTINCT` antes de filtrar.

---

## 5. Criando uma transformação — passo a passo

### Passo 1 — Escreva e teste a query no Workbench

Itere até o resultado ficar certo. Só depois salve em arquivo.

### Passo 2 — Salve o `.sql` em `src/transforms/queries/`

Nome do arquivo = nome da view/tabela (ex.: `vw_alunos_sem_acesso.sql`). Use um dos modelos:

**`view`** — para o PowerBI (recriada a cada execução, sempre com dados do dia):

```sql
-- ============================================================================
-- vw_alunos_sem_acesso
-- Objetivo: alunos inscritos em ofertas de curso que nunca acessaram a disciplina.
-- Tabelas: organizationalunits, userenrollments, courseaccess
-- Dados pessoais: NÃO (só IDs e contagens)
-- Autor: <seu nome> — <data>
-- ============================================================================
CREATE OR REPLACE VIEW vw_alunos_sem_acesso AS
SELECT
  ou.OrgUnitId AS org_unit_id,
  ou.Name      AS disciplina,
  COUNT(*)     AS alunos_sem_acesso
FROM organizationalunits ou
JOIN userenrollments ue
  ON ue.OrgUnitId = ou.OrgUnitId
 AND ue.RoleId = 110   -- "Aluno"
LEFT JOIN (SELECT DISTINCT OrgUnitId, UserId FROM courseaccess) ca
  ON ca.OrgUnitId = ue.OrgUnitId AND ca.UserId = ue.UserId
WHERE ou.Type = 'Course Offering'
  AND ca.UserId IS NULL
GROUP BY ou.OrgUnitId, ou.Name;
```

**`exportar_csv`** — um único `SELECT` (sem `CREATE`); o resultado vira o CSV:

```sql
-- Exporta disciplinas ativas do semestre
SELECT OrgUnitId, Name, Code, StartDate, EndDate
FROM organizationalunits
WHERE Type = 'Course Offering'
  AND StartDate >= '2026-07-01'
```

**`table`** — tabela materializada (use quando a view ficar lenta no PowerBI):

```sql
DROP TABLE IF EXISTS tb_acessos_por_dia;
CREATE TABLE tb_acessos_por_dia AS
SELECT OrgUnitId, DATE(DayAccessed) AS dia, COUNT(DISTINCT UserId) AS usuarios
FROM courseaccess
WHERE DayAccessed >= '2026-07-01'
GROUP BY OrgUnitId, DATE(DayAccessed);
```

O modelo mais completo que já existe é `src/transforms/queries/vw_teste_inscritos_vs_acessos.sql`.

### Passo 3 — Registre em `config/transforms.json`

Adicione um item dentro de `"transformacoes"`:

```json
{
  "nome": "vw_alunos_sem_acesso",
  "arquivo": "src/transforms/queries/vw_alunos_sem_acesso.sql",
  "tipo": "view",
  "ativo": false,
  "descricao": "Alunos inscritos em ofertas de curso que nunca acessaram"
}
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `nome` | sim | Identificador. Para `view`, use o mesmo nome da view. |
| `arquivo` | sim | Caminho do `.sql`. |
| `tipo` | sim | `view`, `exportar_csv` ou `table`. |
| `ativo` | sim | `true` = roda toda madrugada. Deixe `false` enquanto testa. |
| `arquivo_saida` | só `exportar_csv` | Ex.: `exports/alunos.csv` (padrão: `exports/<nome>.csv`). |
| `descricao` | recomendado | O que é, para quem vem depois. |

> **A ordem importa.** As transformações rodam na ordem do arquivo. Se a sua view usa outra
> view ou tabela criada por transformação, ela precisa vir **depois** dela na lista.

### Passo 4 — Teste só a sua transformação

```bash
npm run transform -- --so vw_alunos_sem_acesso
```

- Roda **apenas** a(s) transformação(ões) pedida(s), direto no MySQL — não autentica no
  Brightspace, não baixa nem recarrega nada.
- Funciona mesmo com `"ativo": false` (para testar antes de ativar).
- Várias de uma vez: `--so vw_a,vw_b` ou `--so vw_a --so vw_b` (rodam na ordem do config).
- `exportar_csv` pedida com `--so` sempre gera o CSV, mesmo com `exportar_csvs: false` no schedule.
- Nome errado → mostra os nomes parecidos.

Saída esperada:

```
🔧 Transformações — 1 selecionada(s) via --so...
  ⏳ vw_alunos_sem_acesso               ✅ view atualizada
✅ Transformações: 1 executadas, 0 erros
```

Erro comum: `Table 'data_ucb.xxx' doesn't exist` → o dataset ainda não foi baixado/carregado.
Peça para incluí-lo em `config/bds-selecao.json` (BDS) ou `config/ads-filters.json` (ADS).

### Passo 5 — Ative

Mude para `"ativo": true` (ou use `npm run cli` → **[4] Gerenciar transformações** → **[T]**).
A partir da próxima madrugada ela roda sozinha. `npm run transform` (sem `--so`) roda todas as ativas.

### Passo 6 — Conecte no PowerBI

Obter dados → MySQL → servidor `127.0.0.1:3307`, banco `data_ucb` → escolha a view.
No fim de cada execução o log lista as views atualizadas:
`✅ View 'vw_alunos_sem_acesso' atualizada — PowerBI pode sincronizar`.

---

## 6. Boas práticas

- **Prefixos:** `vw_` para views, `tb_` para tabelas materializadas, `export_` para CSVs.
- **Cabeçalho de comentário** em todo `.sql`: objetivo, tabelas usadas, se tem dado pessoal, autor.
- **Nomes de coluna de saída** em `snake_case` sem acento (`AS disciplina`, `AS pct_com_acesso`) —
  facilita no PowerBI.
- **Filtre cedo:** subconsultas com `DISTINCT`/`WHERE` antes do `JOIN` nas tabelas grandes.
- **Consulta lenta?** Rode `EXPLAIN FORMAT=TREE <sua consulta>`: `Table scan` em tabela grande ou
  `hash join (no condition)` indicam falta de índice na coluna do `JOIN` (veja 2.4).
- **Divisão:** use `NULLIF(denominador, 0)` para não dividir por zero.
- **Não edite tabelas carregadas** (`users`, `courseaccess`…): elas são apagadas e recarregadas
  toda madrugada. Crie sempre views/tabelas novas.
- **Não use `SELECT *` em views** — se o Brightspace adicionar colunas, a view muda sem aviso.

## 7. Privacidade (LGPD)

Views e CSVs ficam acessíveis a quem tem acesso ao PowerBI / à pasta `exports/`.

- Prefira **dados agregados** (contagens, médias, percentuais) e **IDs numéricos**.
- **Nome, e-mail, matrícula (`OrgDefinedId`), username** só quando o relatório realmente
  exigir — e registre isso no cabeçalho do `.sql` (`Dados pessoais: SIM — motivo`).
- Nunca envie CSVs de `exports/` com dados pessoais por canais abertos.

---

## 8. Problemas conhecidos e correções (nov/2026)

**Corrigido em 05/11/2026** (vale a partir da próxima carga, `npm run load` ou madrugada):

- Colunas booleanas (`IsActive`, `IsDeleted`, `Ativo`…) chegavam como `TRUE`/`FALSE` e eram gravadas
  como `0`. Agora viram `1`/`0` corretamente — `IsDeleted = 0` e `IsActive = 1` funcionam.
- Schemas de `Users`, `notas_finais`, `uso_do_aluno`, `GradeObjects` e `GradeResults` conferidos com
  os cabeçalhos reais. **Nomes de coluna mudaram** — use os do CSV:
  - `users`: saíram `Organization`, `SignupDate`, `FirstLoginDate`, `LastAccessed` (não existem no
    BDS); entraram `CreationDate` e `DateDeleted`.
  - `notas_finais`: a nota é `` `Nota final calculada (porcentagem)` `` / `` `Nota final ajustada (porcentagem)` ``;
    entraram semestre e seção. `ID do semestre` é texto (pode vir `12345|67890`).
  - `uso_do_aluno`: nomes conforme o CSV (`ID da oferta de curso`, `Número de envios de atividades`…);
    as duas colunas SCORM viraram `Data de conclusão do último SCORM` e `Data da última visita ao SCORM`.
  - `graderesults`: saiu `IsExempt`, entrou `IsDeleted`. `gradeobjects`: entraram `ToolId` e `Version`.
- `Version` passou a `BIGINT` (o valor do Brightspace estourava o `INT`).

**Ainda em aberto:**

| Problema | Efeito |
|---|---|
| `uso_do_aluno` veio com 0 linhas | Tipos das colunas ainda não validados com dados; `Tempo Total Gasto no Conteúdo` está como texto |
| `DECIMAL(10,2)`/`DECIMAL(10,4)` em notas/pesos (`MaxPoints`, `Weight`, `Points*`, `Weighted*`) | Valores com mais casas são arredondados (diferença na 3ª/5ª casa) |

**Para não acontecer de novo:** a carga agora avisa no log quando o schema e o CSV divergem:

```
⚠️  2 coluna(s) do schema não existem no CSV (ficarão NULL): LastAccessed, SignupDate
ℹ️  1 coluna(s) do CSV fora do schema (não carregadas): CreationDate
```

Regra geral: se uma coluna está **inteira NULL**, procure esse aviso no log da carga ou compare
`DESCRIBE <tabela>` com as colunas do CSV no inventário.

---

## 9. Resumo rápido

```bash
npm run db:up                                   # sobe o MySQL
npm run inventario                              # vê tabelas/colunas → exports/_inventario_csvs.md
# escreve e testa a query no Workbench
# salva em src/transforms/queries/<nome>.sql
# registra em config/transforms.json com "ativo": false
npm run transform -- --so <nome>                # testa só a sua
# muda para "ativo": true → roda toda madrugada
```
