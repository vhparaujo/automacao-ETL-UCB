# CLAUDE.md — Brightspace Downloads (BDS/ADS) + carga MySQL

## Visão Geral do Projeto

Sistema de automação para **download** dos dados do Brightspace (D2L) da Universidade
Católica de Brasília (UCB) — BDS (completo + diferencial) e ADS — e **carga** desses CSVs no MySQL,
com agendamento por cron. Substitui o processo manual de baixar os CSVs pelo AVA.

> **Escopo (16/11/2026):** download + carga no MySQL. Transformações SQL (engine/queries), exportação
> de CSVs tratados e views do PowerBI foram **removidas** — não reintroduzir sem pedido explícito.
> O MySQL é instalado **direto no servidor** (sem Docker / docker-compose).

**Stack:** Node.js (sem frameworks pesados) + MySQL + node-cron  
**Runtime mínimo:** Node.js 18+  
**Linguagem do projeto:** Português (comentários, logs, mensagens para o usuário)

---

## Arquitetura do Sistema

> O código em `src/` é a fonte da verdade. Se este arquivo divergir do código,
> atualize a documentação — não "corrija" o código para bater com a doc.

```
automacao-ETL-UCB/
├── CLAUDE.md                    ← este arquivo
├── README.md
├── package.json
├── .env                         ← credenciais (nunca commitar)
├── .env.example                 ← template público
├── .gitignore
│
├── src/
│   ├── cli.js                   ← menu interativo (npm run cli)
│   ├── pipeline.js              ← orquestra autenticação → arquiva csvs/ → BDS → ADS → carga → inventário; --watch = cron
│   │
│   ├── auth/
│   │   └── oauth.js             ← wrapper fino sobre o pacote brightspace-auth
│   │
│   ├── extractors/
│   │   ├── bds.js               ← download dos BDS (Brightspace Data Sets)
│   │   └── ads.js               ← download dos ADS (Advanced Data Sets sob demanda)
│   │
│   ├── loader/
│   │   └── mysql-loader.js      ← LOAD DATA LOCAL INFILE para cada CSV + upsert dos diferenciais
│   │
│   └── utils/
│       ├── versao-api.js        ← descobre a versão LP via /d2l/api/versions/ (ou LP_API_VERSION)
│       ├── listar-roles.js      ← lista IDs de roles (npm run roles)
│       ├── csv.js               ← parseLinhaCSV() RFC 4180 + nomes de coluna únicos (≤ 64 chars) + parser incremental
│       ├── nomes.js             ← normalização de nomes (acentos/caixa/espaço/_/-) + encontrarSchema() + sugestões
│       ├── datas.js             ← datas relativas dos filtros ADS ("hoje", "-180d", "inicio_semestre"…)
│       ├── bds-extracts.js      ← escolhe o extract BDS mais recente por CreatedDate
│       ├── bds-diferencial.js   ← BDS diferencial: seleção, pastas, manifesto, decisão e SQL do upsert
│       ├── agendamentos.js      ← lerAgendamentos() de schedule.json (vários crons; formato antigo aceito)
│       ├── falha-auth.js        ← detecta refresh token inválido e grava logs/ULTIMA_FALHA_AUTH.txt
│       ├── retentativa.js       ← comRetentativa(): nova tentativa de download (BDS e ADS)
│       ├── ads-config.js        ← slug(), nomeArquivoADS() (arquivo_csv), montarFiltros(), compararFiltros()
│       ├── ads-filtros.js       ← npm run ads:filtros — filtros declarados por cada ADS vs. config
│       ├── ads-periodo.js       ← npm run ads:periodo — grava startDate/endDate no ads-filters.json
│       ├── pasta-csvs.js        ← listarCsvs(), arquivarCsvsAnteriores() (csvs/_anterior/), tabelasNaoAtualizadas()
│       ├── inventario.js        ← npm run inventario → exports/_inventario_csvs.md
│       └── zip.js               ← extrairCsvs(): extração de ZIP em streaming (ZIP64, CSVs de vários GB)
│
├── config/
│   ├── ads-filters.json         ← filtros dos ADS (editável)
│   ├── bds-selecao.json         ← quais BDS baixar no modo automático (editável)
│   ├── bds-diferencial.json     ← chave de cada BDS para aplicar o diferencial (upsert)
│   ├── schemas.json             ← schemas fixos de tabelas (tipos, nome da tabela, aliases, índices)
│   ├── schedule.json            ← agendamentos (cron + BDS completo/diferencial + ADS) + etapas
│   └── roles.txt                ← referência de IDs de roles
│
├── test/                        ← testes unitários (node:test) — npm test
│
├── csvs/                        ← CSVs baixados (gerado em runtime, ignorar no git)
│   └── manuais/                 ← CSVs colocados à mão (fora do AVA): nunca arquivados, carregados em toda carga
├── exports/                     ← _inventario_csvs.md (gerado em runtime)
└── logs/                        ← logs de execução (gerado em runtime)
```

---

## Fase 1 — Autenticação OAuth 2.0 (pacote `brightspace-auth`)

### Contexto

A autenticação é delegada ao pacote **`brightspace-auth`**
(`github:vhparaujo/Authorization-Service-UCB`), que encapsula todo o fluxo
**Authorization Code Grant com Refresh Token**: setup interativo, servidor HTTPS local
de callback (certificado autoassinado via `selfsigned`, dependência interna do pacote),
troca de code por tokens, cache em `.tokens.json` e renovação automática.

> **Não reimplementar OAuth manualmente neste projeto.** Toda a lógica de autenticação
> vive no pacote `brightspace-auth`. O `src/auth/oauth.js` é apenas um wrapper fino.

### Como o pacote é usado

```javascript
require('dotenv').config();
const { BrightspaceAuth } = require('brightspace-auth');

const auth = new BrightspaceAuth({
  clientId:     process.env.BRIGHTSPACE_CLIENT_ID,
  clientSecret: process.env.BRIGHTSPACE_CLIENT_SECRET,
  redirectUri:  process.env.BRIGHTSPACE_REDIRECT_URI,
  scopes:       process.env.BRIGHTSPACE_SCOPES,
});

// Primeira vez (uma única vez por projeto): abre o browser e salva os tokens
await auth.setup();

// Uso normal: retorna token válido, renovando via refresh_token se necessário
const token = await auth.getAccessToken();
```

### Implementação do src/auth/oauth.js (wrapper)

```javascript
// Responsabilidades (todas delegadas ao pacote brightspace-auth):
// 1. Criar uma instância única de BrightspaceAuth com as credenciais/scopes do .env
// 2. getAccessToken(): delega para auth.getAccessToken() (token válido, renova sozinho)
// 3. --setup: delega para auth.setup() (fluxo interativo de autorização, 1x por projeto)
// 4. --test:  valida a autenticação chamando /users/whoami com o token obtido
//
// module.exports = { getAccessToken }  ← interface consumida por pipeline/bds/ads/etc.
//
// Scopes: lidos de BRIGHTSPACE_SCOPES no .env. Default da UCB caso ausente:
//   'datahub:dataExports:download datahub:dataExports:read datasets:bds:read core:*:*'
```

### Pré-requisito por projeto consumidor

Antes do primeiro uso: copiar `.env.example` para `.env` e preencher as credenciais
reais do Brightspace. Em seguida rodar `npm run setup` **uma única vez** — depois os
tokens ficam salvos em `.tokens.json` e são renovados automaticamente.

### Registro do App no Brightspace (já realizado pelo usuário)

O app já foi registrado no Brightspace com as seguintes configurações:
- Nome: `Automação ETL UCB` (ou similar)
- Tipo: **Authorization grant**
- Redirect URI: `https://localhost:9876/callback` ← **HTTPS obrigatório**
- Scopes: `datahub:dataExports:download datahub:dataExports:read core:*:*`
- Access Token Lifetime: `3600` (1 hora)
- **Refresh Token: habilitado** ← essencial para automação sem login manual repetido

O Client ID e Client Secret gerados devem estar no `.env`.

---

## Fase 2 — Extração BDS (Brightspace Data Sets)

### O que são

São os ~135 datasets gerados automaticamente pelo Brightspace. Não precisam de filtros — retornam
dados de toda a instituição. Cada um tem dois plugins (conferido na API da UCB em 12/11/2026):

| Tipo | Quando sai (Brasília) | API mantém | Conteúdo |
|------|-----------------------|------------|----------|
| `Full` (completo) | segunda ~08:20 | só o último | a tabela inteira |
| `Differential` | todo dia ~05:21 | ~14 dias | linhas alteradas desde o diferencial anterior — **mesmo nome de CSV e mesmas colunas** do completo |

### Fluxo real (src/extractors/bds.js)

```
# 1. Listar os datasets (scope datasets:bds:read, API LP 1.49+)
GET /d2l/api/lp/(version)/datasets/bds
# → ObjectListPage de BrightspaceDataSetInfo:
#   { SchemaId, Full: { PluginId, Name, Description, ExtractsLink }, Differential: {...}, ExtractsLink }
#   O código usa ds.Full.Name como nome; ds.Full.ExtractsLink (completo) ou
#   ds.Differential.ExtractsLink (diferencial) para os extracts.

# 2. Listar os extracts do plugin Full (URL opaca vinda da resposta acima)
GET ds.Full.ExtractsLink
# → ObjectListPage de BrightspaceDataSetExtractInfo:
#   { SchemaId, PluginId, BdsType, CreatedDate, QueuedForProcessingDate,
#     DownloadSize, DownloadLink, Version }

# 3. Escolher o extract mais recente — selecionarExtractMaisRecente() (src/utils/bds-extracts.js)
#    Ordena por CreatedDate desc (fallback QueuedForProcessingDate). A API não garante ordem.
#    Se nenhum extract tiver data, usa o primeiro da lista e avisa UMA vez no log.

# 4. Baixar o ZIP
GET extract.DownloadLink
# → 200 com o arquivo, ou 302 para URL pré-autenticada (redirects são seguidos;
#   o Bearer só é enviado para hosts da UCB/Brightspace)

# 5. Salvar em csvs/zips/, extrair os .csv para csvs/ e apagar o ZIP
#    extrairCsvs() (src/utils/zip.js): streaming com zlib + ZIP64 — memória constante.
#    NÃO voltar para adm-zip na extração: ele monta o CSV inteiro num Buffer e quebra
#    no SystemAccessLog (ZIP 1,2 GB → CSV 7,4 GB: "Cannot create a Buffer larger than…").
```

### Diferencial — `download({ tipo: 'diferencial' })` (`--diferencial`, agendamento `"bds": "diferencial"`)

```
# Por dataset: data do último Full (ds.Full.ExtractsLink) → selecionarDiferencialDoDia()
# (src/utils/bds-diferencial.js): SÓ o Differential mais recente, se criado HOJE (America/Sao_Paulo)
# e depois do último Full — os de dias anteriores não são baixados. Senão pula o dataset com o motivo
# ("ainda não foi gerado" / "já está no completo"). CSVs direto em csvs/diferencial/ (sobrescrevem os do
# dia anterior, como no completo) + registro em csvs/diferencial/_bds_extracts.json
# { "Users.csv": { dataset, tipo, criado, base (data do Full), anterior (diferencial anterior na API) } }.
# O loader usa "anterior" para avisar quando o diferencial de um dia não foi aplicado (lacuna até o
# próximo completo).
# Completo: grava csvs/_bds_extracts.json { "Users.csv": { dataset, tipo: "Full", criado } } —
# o loader usa para registrar a base de cada tabela; o inventário usa o "dataset" como origem.
```

> Os endpoints antigos `/dataExport/bds/list`, `/dataExport/bds/(pluginId)`,
> `FullDatasetLink` e `DifferentialDatasetLink` **não são usados**. Não migrar o código para eles.

### Seleção dos datasets

- `download({ modo: 'auto' })` (pipeline): usa `config/bds-selecao.json`
  (`todos: true` baixa tudo; senão, só os nomes em `automaticos`).
- `modo: 'todos'` e `modo: 'selecao'` (`nomes: [...]`) são usados pela CLI.
- O casamento de nomes é **normalizado** (`mesmoNome()` em `src/utils/nomes.js`):
  ignora acentos, maiúsculas/minúsculas, espaços, `_` e `-` — `Usuarios` = `Usuários`.

### Nova tentativa de download (BDS e ADS) — `src/utils/retentativa.js`

- Cada dataset BDS / relatório ADS que falha é tentado **mais uma vez** (`DOWNLOAD_TENTATIVAS=2` no
  total, espera `DOWNLOAD_ESPERA_SEGUNDOS=30` entre elas; token renovado a cada tentativa).
- Não repetem (falhariam igual): erro de configuração (`erroDefinitivo()` / `naoRepetir` — nome do CSV,
  período inválido, relatório ADS inexistente), HTTP 400/403 (`erro.status`) e falha de autenticação.
- ADS: se o job já foi concluído e só o download/extração falhou, a nova tentativa baixa o MESMO job
  (não gera o relatório de novo).
- `download({ log })`: o pipeline passa o logger — cada tentativa falha vira `[AVISO]` no
  `logs/pipeline-YYYY-MM-DD.log`; a falha definitiva vira `[ERRO] DOWNLOAD FALHOU — BDS/ADS "nome" não
  baixado após N tentativa(s): …` e o fim do pipeline grava `[ERRO] RESUMO — N download(s) NÃO concluído(s)`.
  Os dois `download()` retornam `falhas: [{ nome, mensagem, tentativas }]`.

### Observações

- Downloads grandes (100MB+): sempre `stream/promises.pipeline()` — nunca `arrayBuffer()`.
- Log por dataset: tamanho, quantidade de CSVs e data do extract escolhido.
- Nomes no bds-selecao.json precisam bater com `Full.Name` da API (ex.: "Objetos do Conteúdo" → ContentObjects.csv; "Objetos de conteúdo" não existe). Nome ausente → o download avisa com sugestões e segue.
- A versão LP vem de `obterVersaoLP()` (`src/utils/versao-api.js`): `LP_API_VERSION` do `.env`
  ou a `LatestVersion` do produto `lp` em `GET /d2l/api/versions/` (cacheada por processo).

---

## Fase 3 — Extração ADS (Advanced Data Sets)

### O que são

Relatórios gerados **sob demanda** com filtros obrigatórios. Exemplos:
- Uso do instrutor
- Uso do Aluno
- Notas finais

### Fluxo real (src/extractors/ads.js)

```
# 1. Listar relatórios ADS disponíveis e achar o DataSetId pelo nome (case-insensitive)
GET /d2l/api/lp/(version)/dataExport/list

# 2. Criar o job de exportação
POST /d2l/api/lp/(version)/dataExport/create
Body: {
  "DataSetId": "...",
  "Filters": [
    { "Name": "startDate",       "Value": "2026-01-01T00:00:00.000Z" },  ← UTC com Z (offset → 400)
    { "Name": "endDate",         "Value": "2026-06-30T23:59:59.999Z" },
    { "Name": "parentOrgUnitId", "Value": "6606" },
    { "Name": "roles",           "Value": "110,115" }                    ← IDs numéricos, não texto!
  ]
}
# → { ExportJobId, ... }

# 3. Polling a cada 10s (timeout 30 min), token renovado a cada consulta
GET /d2l/api/lp/(version)/dataExport/jobs/(exportJobId)   → { Status }
#   0 = na fila, 1 = processando → continua esperando
#   2 = concluído → baixa
#   3 = erro, 4 = apagado → falha na hora (interpretarStatusJob())
#   (NÃO usar HEAD no download: job com erro devolve 404 para sempre e parecia "processando")

# 4. Download do ZIP (mesma URL, GET) → extrai o CSV como csvs/<nome_normalizado>.csv
GET /d2l/api/lp/(version)/dataExport/download/(exportJobId)
```

Todas as chaves do relatório em `ads-filters.json`, exceto `ativo`, `automatico`, `arquivo_csv` e
as iniciadas por `_`, viram `Filters` (`montarFiltros()`; arrays são unidos por vírgula). Cada ADS
declara filtros próprios em `DataSetData.Filters` (`Name`, `Type` 1–5, `Description`,
`DefaultValue`) — confira com `npm run ads:filtros`. O CSV é salvo como `nomeArquivoADS()`:
`arquivo_csv` ou `slug(nome)`; os nomes `notas_finais`, `uso_do_aluno` e `uso_do_instrutor` não
podem mudar (schemas.json depende deles; há teste em `test/ads-config.test.js`).

### Arquivo de configuração: config/ads-filters.json

```json
{
  "_instrucoes": "...",
  "Uso do instrutor": {
    "automatico": true,
    "ativo": true,
    "parentOrgUnitId": "6606",
    "startDate": "inicio_semestre",
    "endDate": "agora",
    "roles": ["109"]
  }
}
```

- `automatico: true` → roda no pipeline agendado; `false` → só sob demanda (CLI).
- `ativo: false` → ignorado em todos os modos.

#### Datas relativas (`startDate` / `endDate`)

Resolvidas em `processarJob()` no momento da execução por `resolverPeriodo()`
(`src/utils/datas.js`), sempre em ISO UTC com `Z`. O log mostra o período efetivo:
`📅 Período: 2026-07-01T00:00:00.000Z → 2026-12-31T23:59:59.999Z`.

| Valor | startDate | endDate |
|-------|-----------|---------|
| ISO com `Z` (ex.: `2026-01-01T00:00:00.000Z`) | mantido como está | mantido como está |
| ISO com offset (`…-03:00`) | convertido para UTC/`Z` | convertido para UTC/`Z` |
| `agora` | instante da execução | instante da execução (padrão de todos os ADS) |
| `hoje` | hoje 00:00:00.000Z | hoje 23:59:59.999Z |
| `-Nd` (ex.: `-180d`) | N dias atrás, 00:00:00.000Z | N dias atrás, 23:59:59.999Z |
| `inicio_ano` / `fim_ano` | 01/01 00:00:00.000Z | 31/12 23:59:59.999Z |
| `inicio_semestre` / `fim_semestre` | 01/01 ou 01/07 | 30/06 ou 31/12 |

- Semestre 1 = jan–jun, semestre 2 = jul–dez. O "dia" é o dia UTC (o cron das 3h de Brasília
  roda às 06:00 UTC, mesmo dia).
- Expressão inválida ou período invertido → erro só naquele relatório; os demais continuam.
- Configs antigas (datas ISO absolutas) continuam funcionando sem alteração.
- `YYYY-MM-DD` também é aceito (início/fim do dia UTC conforme o campo).
- **Gravar no JSON pelo terminal:** `npm run ads:periodo -- --inicio <valor> [--fim <valor>] [--so "Nome,Nome"]`
  (`src/utils/ads-periodo.js`, `atualizarPeriodos()` pura e testada). Sem argumentos lista o período atual.
  Só altera relatórios que já têm a chave; erro (valor, nome, período invertido) → nada é gravado; escrita atômica.
- **Só nesta execução:** `--inicio <valor>` / `--fim <valor>` (`lerArgsPeriodo()` em `datas.js`) sobrescrevem
  `startDate`/`endDate` de todos os ADS da execução (`aplicarPeriodo()` em `ads.js` — só nos relatórios que já
  têm a chave), sem gravar no JSON. Validados antes de autenticar; proibidos com `--watch`.
  Ex.: `npm run ads -- --inicio 2026-08-01`, `npm run pipeline -- --inicio -30d --fim hoje`.

### Roles

SEMPRE IDs numéricos (`npm run roles` lista os disponíveis). A API rejeita
strings como "Professor" com erro 400.

---

## Fase 4 — Carga no MySQL

### src/loader/mysql-loader.js

```javascript
// Para cada CSV em csvs/:
// 1. detectarFormatoArquivo() (src/utils/csv.js) olha o 1º MB: separador (',' ou ';' — o que mais aparece
//    no cabeçalho) e codificação (UTF-8 válido → utf8; senão latin1). BDS/ADS = ',' + utf8 (nada muda);
//    exports do sistema acadêmico (csvs/manuais/) = ';' + latin1 → LOAD DATA com CHARACTER SET latin1 e
//    FIELDS TERMINATED BY ';'. Lê o cabeçalho com parseLinhaCSV(linha, separador) — RFC 4180: separador
//    entre aspas, "" como aspa literal, remove BOM e \r final.
// 2. Procura schema fixo em config/schemas.json com encontrarSchema() (src/utils/nomes.js):
//    chave exata → chave normalizada → "aliases" normalizados.
//    a. Com schema: DROP + CREATE TABLE com as colunas/tipos do schema (colunas extras do CSV
//       são ignoradas); nome da tabela = "tabela" do schema.
//    b. Sem schema: TODAS as colunas TEXT (tipoColuna() só com INFERIR_TIPOS=true), log
//       "🔍 Sem schema fixo para … carregada com todas as colunas TEXT"; trunca nomes para
//       64 chars e desambigua colisões com _2, _3…; se a tabela existe com outra estrutura,
//       DROP + CREATE; com a mesma estrutura, só TRUNCATE.
//    Só lê os .csv do nível de cima de csvs/ (ignora csvs/_anterior/ e csvs/zips/) + os de csvs/manuais/
//    (listarCsvsManuais(): CSVs postos à mão, não arquivados por arquivarCsvsAnteriores(); nome igual a um
//    CSV baixado → ignorado com aviso). Tabela = nome do arquivo; tipos via schemas.json como qualquer outro.
// 3. LOAD DATA LOCAL INFILE com variáveis posicionais (@col_0, @col_1, …) e
//    SET coluna = NULLIF(@col_N, '') — booleanos: CASE TRUE/FALSE → 1/0 (expressaoValor()).
// 4. Log: tabela, linhas, tempo (📋 = schema fixo, 🔍 = inferido).
//
// Conexão mysql2 usa infileStreamFactory (habilita LOCAL INFILE no cliente).
// Servidor precisa de local_infile=ON (local_infile = 1 no [mysqld] do my.cnf/mysqld.cnf).
// Conexão via .env: DB_HOST, DB_PORT (padrão 3306), DB_USER, DB_PASSWORD, DB_NAME
```

### config/schemas.json

```json
"Users": {
  "tabela": "users",
  "aliases": ["Usuários"],
  "colunas": { "UserId": "INT", "UserName": "VARCHAR(255)" }
}
```

- Chave = nome do CSV sem extensão. `aliases` (opcional) = outros nomes possíveis do arquivo
  (ex.: em português). Casamento ignora acentos, caixa, espaços, `_` e `-`.
- Entradas sem `aliases` continuam funcionando como antes (casamento exato ou normalizado).
- Para adicionar um alias: veja o nome real do CSV em `csvs/` e inclua em `aliases`.
- Coluna: `"Nome no CSV": "TIPO"` ou `"Nome no CSV": { "tipo": "TIPO", "coluna": "nome na tabela" }`
  (para nomes > 64 chars, ex.: colunas SCORM do `uso_do_aluno`). A tabela segue a ordem do schema.
- `planejarColunasSchema()` casa cabeçalho × schema (exato, depois normalizado) e o loader avisa:
  `⚠️ … coluna(s) do schema não existem no CSV (ficarão NULL)` / `ℹ️ … coluna(s) do CSV fora do schema`.
  Os schemas devem bater 1:1 com os cabeçalhos reais (conferidos em 05/11/2026).
- `"indices": [["UserId"], ["OrgUnitId", "RoleId"]]` (opcional): `montarSqlIndices()` cria um único
  `ALTER TABLE … ADD INDEX …` DEPOIS do LOAD DATA (não UNIQUE; TEXT com prefixo 191; coluna inexistente →
  aviso e índice ignorado). Depois de cada carga roda `ANALYZE TABLE` (todas as tabelas) — sem isso o
  otimizador estimava errado e escolhia `hash join (no condition)` (consulta de 600 s+ → 2 s com índices).
- Booleanos (`TINYINT(1)`/`BOOL`): `expressaoValor()` converte `TRUE`/`FALSE` (qualquer caixa) → 1/0 —
  o MySQL (sql_mode='') gravava 0 para o texto. Vale também para tipos inferidos (INFERIR_TIPOS=true).
- `Version` do Brightspace é `BIGINT` (passa de 2.147.483.647).
- `"formato": "br"` (entrada do schema; usado nos 6 CSVs manuais do sistema acadêmico — DisciplinasPorAlunos,
  ProvaveisFormandos, Financeiro, BolsasCadastradas, DadosPessoais, CuboAcademico): `expressaoValor(…, { formatoBR })`
  converte DECIMAL `"1234,5678"` (REPLACE vírgula → ponto; sem separador de milhar) e DATE/DATETIME
  `"dd/mm/aaaa[ hh:mm:ss]"` (STR_TO_DATE). Sem a flag, nada muda (BDS/ADS em ISO). Texto SIM/NÃO fica VARCHAR.
- O MySQL compara nomes de coluna sem caixa NEM acento: `nomesColunasUnicos()` desambigua
  "RESPONSÁVEL FINANCEIRO" × "RESPONSAVEL FINANCEIRO" com `_2` (no schema: `"coluna": "RESPONSAVEL FINANCEIRO_2"`).

### BDS diferencial — `aplicarDiferenciais()` (depois dos CSVs do nível de cima)

```javascript
// Para cada CSV de csvs/diferencial/ (ordem cronológica do "criado" em diferencial/_bds_extracts.json):
// 1. planejarCarga() (mesma do completo) → tabela/colunas; a tabela precisa existir com a mesma
//    estrutura (senão erro: "rode o BDS completo").
// 2. Chave em config/bds-diferencial.json (encontrarChave(), casamento normalizado). Sem chave → erro.
// 3. decidirAplicacao() com _etl_bds_estado (tabela, completo_criado, diferencial_criado):
//    pula já aplicados e anteriores ao completo carregado; avisa se o completo da tabela é mais
//    antigo que o "base" do diferencial, se o "anterior" não foi aplicado (lacuna) ou se não há
//    registro de completo.
// 4. Índices do schema que faltam na tabela são criados (custo único; sem eles o DELETE…JOIN em
//    systemaccesslog levava 10 min+). Índices compostos casados com a chave: (UserId, Timestamp)
//    nos logs, (UserId, OrgUnitId) em userenrollments, (UserId, GradeObjectId) em graderesults.
// 5. CREATE TABLE _dif_<tabela> LIKE <tabela> → LOAD DATA → índice da chave no staging →
//    transação: DELETE t JOIN staging ON chave (<=>) + INSERT … SELECT + estado → ANALYZE → DROP staging.
// O completo (CSV listado em csvs/_bds_extracts.json) grava completo_criado e zera diferencial_criado.
// tabelasNaoAtualizadas() ignora tabelas que começam com "_" (_etl_bds_estado, _dif_*).
```

- Diferencial não traz exclusões físicas (ex.: desinscrição) — o completo semanal corrige.

---

## Fase 5 — Orquestração e Agendamento

### Arquivo de configuração: config/schedule.json

```json
{
  "fuso_horario": "America/Sao_Paulo",
  "agendamentos": [
    { "nome": "BDS diferencial + ADS", "ativo": true, "cron": "0 6 * * *", "bds": "diferencial", "ads": true },
    { "nome": "BDS completo",          "ativo": true, "cron": "0 9 * * 1", "bds": "completo",    "ads": false }
  ],
  "pipeline": { "baixar_bds": true, "baixar_ads": true, "carregar_mysql": true }
}
```

- `lerAgendamentos()` (`src/utils/agendamentos.js`) valida `bds` (`"completo"|"diferencial"|false`) e aceita
  o formato antigo (`"agendamento": { cron, ativo, fuso_horario }` = BDS completo + ADS).
- `iniciarAgendamento()` agenda cada item ativo (cron validado com `cron.validate`) e roda as execuções
  em **fila** (uma por vez). Cada execução é `completo: true` (arquiva csvs/, inventário no fim);
  `pipeline.baixar_bds/baixar_ads` continuam valendo como chave geral.
- **Produção (servidor Linux):** o `--watch` roda sob **pm2** (`pm2 start src/pipeline.js --name etl-ucb -- --watch`
  + `pm2 save` + `pm2 startup`), a partir da pasta do projeto. O schedule.json é lido só ao iniciar →
  `pm2 restart etl-ucb` após mudar. Setup OAuth no servidor: túnel `ssh -L 9876:localhost:9876` (ver README).
- Horários escolhidos depois da geração no Brightspace (completo ~8h20 de segunda, diferencial ~5h20).
- CLI [3]: lista os agendamentos, [A] ativa/desativa, [C] troca o cron, [P] restaura `AGENDAMENTOS_PADRAO`.

### src/pipeline.js

```javascript
// Orquestra em sequência (cada etapa respeita baixar_bds / baixar_ads / carregar_mysql de
// config/schedule.json → pipeline). Ponto único que valida a autenticação (alerta ULTIMA_FALHA_AUTH),
// arquiva csvs/, grava o log do dia, faz o resumo das falhas e roda o cron.
// 1. getAccessToken()          → valida/renova autenticação
//    • Refresh token inválido/expirado (erros do brightspace-auth, invalid_grant, HTTP 400/401):
//      loga "🔐 Refresh token inválido ou expirado — rode "npm run setup" para reautenticar",
//      grava logs/ULTIMA_FALHA_AUTH.txt e ENCERRA sem as etapas seguintes (exit code 1 manual).
//    • Sucesso: remove logs/ULTIMA_FALHA_AUTH.txt se existir.
//    • Pipeline completo (sem --apenas-*; também o cron): move csvs/ → csvs/_anterior/ antes de baixar.
// 2. bds.download({ tipo })    → baixar_bds; tipo = opcoes.bdsTipo ('completo' | 'diferencial')
//                                (avisa nomes do bds-selecao.json ausentes na API, com sugestões)
// 3. ads.download()            → baixar_ads
// 4. load()                    → carregar_mysql (CSVs de csvs/ + diferenciais de csvs/diferencial/)
//    + lista tabelas do MySQL não atualizadas nesta execução
// 5. gerarInventario()        → exports/_inventario_csvs.md (só pipeline completo)
// 6. Resumo: duração, datasets BDS, relatórios ADS, tabelas/linhas, downloads que falharam, erros
//
// Execução manual:
// node src/pipeline.js                    → BDS completo + ADS + carga agora
// node src/pipeline.js --apenas-bds       → só baixa BDS (completo)
// node src/pipeline.js --diferencial      → pipeline com o BDS diferencial do dia (também com --apenas-bds)
// node src/pipeline.js --apenas-ads       → só baixa ADS
// node src/pipeline.js --apenas-load      → só carrega no MySQL
// node src/pipeline.js --apenas-ads --inicio 2026-08-01 [--fim hoje] → ADS com outro período (só nesta execução)
// node src/pipeline.js --watch            → agendamento com node-cron (npm start)
```

---

## Arquivo .env.example

```env
# Brightspace / D2L
BRIGHTSPACE_HOST=https://ava.catolica.edu.br
BRIGHTSPACE_CLIENT_ID=seu_client_id_aqui
BRIGHTSPACE_CLIENT_SECRET=seu_client_secret_aqui
BRIGHTSPACE_REDIRECT_URI=https://localhost:9876/callback
BRIGHTSPACE_SCOPES=datahub:dataExports:download datahub:dataExports:read datasets:bds:read core:*:*

# MySQL (instalado no servidor, local_infile=ON)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=dataUCB
DB_PASSWORD=sua_senha_aqui
DB_NAME=data_ucb

# Configurações do pipeline
LOG_LEVEL=info
CSVS_DIR=./csvs
# Inventário dos CSVs (exports/_inventario_csvs.md)
EXPORTS_DIR=./exports
LOGS_DIR=./logs
# Downloads BDS/ADS: total de tentativas (1 = sem nova tentativa) e espera entre elas
DOWNLOAD_TENTATIVAS=2
DOWNLOAD_ESPERA_SEGUNDOS=30
# Tabelas sem schema fixo: false = todas TEXT (padrão); true = infere tipos pelo nome da coluna
INFERIR_TIPOS=false
```

---

## Dependências (package.json)

```json
{
  "dependencies": {
    "brightspace-auth": "github:vhparaujo/Authorization-Service-UCB",
    "mysql2": "^3.x",
    "node-cron": "^3.x",
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "adm-zip": "^0.5.x"        ← só nos testes (criar ZIPs); a extração usa src/utils/zip.js
  }
}
```

> `selfsigned` deixou de ser dependência direta — agora é dependência interna do
> pacote `brightspace-auth`, que cuida de todo o fluxo OAuth.

---

## Pontos de Atenção Críticos

### API Brightspace
- **Endpoints chamados pelo código** (lista completa):
  `GET /d2l/api/versions/` (versao-api.js) · `GET /d2l/api/lp/(v)/datasets/bds` + `Full.ExtractsLink` +
  `DownloadLink` (bds.js) · `GET /dataExport/list`, `POST /dataExport/create`,
  `GET /dataExport/jobs/(jobId)`, `GET /dataExport/download/(jobId)` (ads.js) · `GET /d2l/api/lp/(v)/roles/` (listar-roles.js) ·
  `GET /d2l/api/lp/(v)/users/whoami` (oauth.js --test). Tokens: `auth.brightspace.com` (pacote brightspace-auth).
- **Roles devem ser IDs numéricos** — nunca texto ("Professor", "Aluno"). Erro 400 se texto.
- **POST requests exigem header `X-Csrf-Token`** — obtido via cookie ou endpoint dedicado.
  Com OAuth2 e Bearer token, esse requisito muda: verificar se o CSRF ainda é necessário
  com Authorization header. Testar e documentar comportamento real.
- **Versão da API LP:** descoberta via `GET /d2l/api/versions/` (`src/utils/versao-api.js`);
  force com `LP_API_VERSION` no `.env` se necessário.
- **Datas nos filtros ADS:** sempre UTC com `Z` (offset `-03:00` causa 400).
- **Downloads grandes (>100MB):** sempre usar `stream.pipeline()` do Node.js nativo.
  Nunca `response.arrayBuffer()` ou `response.buffer()`.

### MySQL
- Instalado **direto no servidor** (sem Docker). Banco `data_ucb`, usuário `dataUCB` com
  `ALL PRIVILEGES ON data_ucb.*` (o loader faz DROP/CREATE/ALTER/INDEX). Passo a passo no README.
- `local_infile` precisa estar ON no servidor: `local_infile = 1` em `[mysqld]` do my.cnf/mysqld.cnf
  (persistente) ou `SET GLOBAL local_infile = 1;` (até reiniciar). Conferir: `SELECT @@local_infile;`.
- Na conexão mysql2: `infileStreamFactory` (habilita LOCAL INFILE no cliente)
- Completo: DROP/TRUNCATE + `LOAD DATA`; diferencial: upsert (ver Fase 4)
- Tratar valores nulos: `SET coluna = NULLIF(@coluna, '')`

### Segurança
- **Nunca commitar `.env` ou `.tokens.json`**
- `.gitignore` deve incluir: `.env`, `.tokens.json`, `csvs/`, `exports/`, `logs/`, `node_modules/`
- Tokens OAuth salvos em arquivo local com permissões restritas (chmod 600)

### Logs
- Cada execução do pipeline gera arquivo em `logs/pipeline-YYYY-MM-DD.log`
- Formato: `[HH:MM:SS] [NIVEL] mensagem`
- Ao final do pipeline: resumo com duração, datasets baixados, tabelas carregadas, downloads com falha, erros
- Falha de autenticação: `logs/ULTIMA_FALHA_AUTH.txt` (a CLI [6] mostra alerta enquanto existir)

---

## Mensagens e UX

Todos os logs e mensagens devem ser em **português**, claros e informativos:

```
🚀 Iniciando download Brightspace — 05/06/2025 03:00:00
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📡 Autenticação: renovando token... ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 BDS — Baixando 137 datasets...
  📥 [01/137] Users.csv              — 12.4 MB ✅
  📥 [02/137] Enrollments.csv        — 45.1 MB ✅
  ⚠️  [15/137] ScormActivity.csv     — erro: timeout, pulando
  ...
  ✅ BDS concluído: 135 baixados, 2 erros — 8m 32s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 ADS — Gerando relatórios sob demanda...
  ⏳ Uso do instrutor: aguardando job... (30s) (60s) ✅ — baixando
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Pipeline concluído em 14m 21s
   📦 137 datasets BDS | 2 relatórios ADS
   🗄️  52 tabelas MySQL atualizadas
   📒 Inventário: exports/_inventario_csvs.md
   ⚠️  2 erros (ver logs/pipeline-2025-06-05.log)
```

---

## Comandos npm

```json
"scripts": {
  "setup":     "node src/auth/oauth.js --setup",
  "start":     "node src/pipeline.js --watch",
  "pipeline":  "node src/pipeline.js",
  "bds":       "node src/pipeline.js --apenas-bds",
  "bds:diferencial": "node src/pipeline.js --apenas-bds --diferencial",
  "ads":       "node src/pipeline.js --apenas-ads",
  "load":      "node src/pipeline.js --apenas-load",
  "cli":       "node src/cli.js",
  "roles":     "node src/utils/listar-roles.js",
  "test-auth": "node src/auth/oauth.js --test",
  "test":      "node --test",
  "ads:filtros": "node src/utils/ads-filtros.js",
  "ads:periodo": "node src/utils/ads-periodo.js",
  "inventario":  "node src/utils/inventario.js"
}
```

## Testes

- `npm test` roda `node --test`, que descobre `test/**/*.test.js` (sem dependências extras).
  Usa-se `node --test` sem argumento de diretório porque `node --test test/` quebra no Node 22+.
- Os testes não acessam MySQL nem Brightspace: módulos externos são mockados via `require.cache`.
- Funções puras testadas: `src/utils/retentativa.js`, `src/utils/csv.js`, `nomes.js`, `datas.js` (inclui `lerArgsPeriodo`), `ads-periodo.js`, `bds-extracts.js`,
  `bds-diferencial.js`, `agendamentos.js` (inclui os crons do schedule.json real),
  `falha-auth.js`, `pasta-csvs.js`, `inventario.js`, `zip.js`, funções puras do loader (`loader-tipos.test.js`);
  o pipeline (arquivar csvs/, falha de auth) com mocks.

---

## Contexto do Negócio

- **Instituição:** Universidade Católica de Brasília (UCB)
- **Sistema:** Brightspace (D2L) — `ava.catolica.edu.br`
- **OrgUnitId padrão da instituição:** 6606
- **Dados:** ~135 BDS (completo semanal + diferenciais diários) + ADS sob demanda (Uso do Instrutor, Uso do Aluno, etc.)
- **Banco MySQL:** no servidor, porta 3306, user `dataUCB`, banco `data_ucb`
- **Entrega:** as tabelas no MySQL (e os CSVs em `csvs/`); o tratamento dos dados (views, relatórios) é feito fora deste projeto
