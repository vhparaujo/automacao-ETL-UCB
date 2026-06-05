# CLAUDE.md — Brightspace ETL Automation

## Visão Geral do Projeto

Sistema de automação para download, carga, transformação e exportação dos dados do
Brightspace (D2L) da Universidade Católica de Brasília (UCB). Substitui o processo
manual de: baixar CSVs pelo AVA → rodar SQL → atualizar PowerBI.

**Stack:** Node.js (sem frameworks pesados) + MySQL + node-cron  
**Runtime mínimo:** Node.js 18+  
**Linguagem do projeto:** Português (comentários, logs, mensagens para o usuário)

---

## Arquitetura do Sistema

```
brightspace-etl/
├── CLAUDE.md                    ← este arquivo
├── package.json
├── .env                         ← credenciais (nunca commitar)
├── .env.example                 ← template público
├── .gitignore
│
├── src/
│   ├── auth/
│   │   └── oauth.js             ← autenticação OAuth 2.0 (Authorization Code + Refresh Token)
│   │
│   ├── extractors/
│   │   ├── bds.js               ← download dos 137 BDS (Brightspace Data Sets)
│   │   └── ads.js               ← download dos ADS (Advanced Data Sets sob demanda)
│   │
│   ├── loader/
│   │   └── mysql-loader.js      ← LOAD DATA LOCAL INFILE para cada CSV no MySQL
│   │
│   ├── transforms/
│   │   ├── engine.js            ← executa as queries de transformação configuradas
│   │   └── queries/             ← pasta com os arquivos .sql de transformação
│   │       └── exemplo.sql      ← exemplo comentado
│   │
│   ├── exporter/
│   │   ├── csv-exporter.js      ← exporta resultado de query para CSV
│   │   └── powerbi.js           ← atualiza views MySQL usadas pelo PowerBI
│   │
│   └── pipeline.js              ← orquestra extração → carga → transform → exportação
│
├── config/
│   ├── ads-filters.json         ← filtros dos ADS (editável pelo usuário)
│   ├── schedule.json            ← configuração do agendamento (editável)
│   └── transforms.json          ← quais queries rodar e o que exportar (editável)
│
├── csvs/                        ← CSVs baixados (gerado em runtime, ignorar no git)
├── exports/                     ← CSVs exportados tratados (gerado em runtime)
└── logs/                        ← logs de execução (gerado em runtime)
```

---

## Fase 1 — Autenticação OAuth 2.0

### Contexto

A UCB já tem a aba **OAuth 2.0** habilitada no Manage Extensibility do Brightspace
(confirmado via screenshots). Os apps existentes usam **Authorization** (Authorization
Code Grant). O mesmo fluxo deve ser usado aqui, pois o fluxo Client Credentials
(server-to-server com JWT) requer Service Users que podem ainda não estar disponíveis.

### Fluxo a implementar: Authorization Code Grant com Refresh Token

```
1. Usuário roda: node src/auth/oauth.js --setup
2. App sobe um servidor HTTPS local na porta 9876 com certificado autoassinado
3. App abre URL de autorização no navegador:
   https://auth.brightspace.com/oauth2/auth
     ?response_type=code
     &client_id=CLIENT_ID
     &redirect_uri=https://localhost:9876/callback
     &scope=datahub:dataExports:download datahub:dataExports:read core:*:*
4. Usuário faz login no Brightspace e autoriza
5. Brightspace redireciona para https://localhost:9876/callback?code=XXX
   (O navegador pode exibir aviso de certificado autoassinado — clicar em "Avançar")
6. App captura o code, troca por access_token + refresh_token via POST ao token endpoint
7. Tokens são salvos em .tokens.json com permissão 600
8. Em execuções futuras: usa refresh_token para obter novo access_token automaticamente
```

### Servidor HTTPS local para o callback

O Brightspace exige HTTPS no redirect URI. Usar o módulo `https` nativo do Node.js
com certificado autoassinado gerado em memória via `selfsigned` (npm):

```javascript
// Gerar certificado autoassinado em memória (sem salvar em disco)
// npm install selfsigned
const selfsigned = require('selfsigned');
const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 1 });

const server = https.createServer(
  { key: pems.private, cert: pems.cert },
  requestHandler
);
server.listen(9876);

// O servidor deve ser encerrado imediatamente após capturar o code
// Não deixar o servidor rodando após o setup
```

### Endpoints de autenticação

```
Authorization: https://auth.brightspace.com/oauth2/auth
Token:         https://auth.brightspace.com/core/connect/token
```

### Implementação do src/auth/oauth.js

```javascript
// Responsabilidades:
// 1. --setup: sobe servidor HTTPS local (porta 9876) com certificado autoassinado
//             via biblioteca 'selfsigned', abre o fluxo de autorização no browser,
//             captura o code no callback, troca por tokens, salva em .tokens.json
// 2. getAccessToken(): retorna token válido (renova via refresh_token se necessário)
// 3. Salvar/carregar tokens de arquivo local .tokens.json (nunca commitar)
// 4. O servidor HTTPS local deve ser encerrado logo após capturar o code

// Scopes necessários:
const SCOPES = [
  'datahub:dataExports:download',
  'datahub:dataExports:read',
  'core:*:*'
].join(' ');
```

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

São os 137 datasets gerados automaticamente pelo Brightspace toda madrugada.
Não precisam de filtros — retornam dados de toda a instituição.

### Endpoints BDS

```
# Listar todos os datasets disponíveis
GET /d2l/api/lp/(version)/dataExport/bds/list

# Obter detalhes + links de download de um dataset
GET /d2l/api/lp/(version)/dataExport/bds/(pluginId)

# Resposta inclui:
# - Name: nome do dataset
# - FullDatasetLink: { ExpiryDate, DownloadLink }  ← arquivo ZIP com CSV completo
# - DifferentialDatasetLink: { ... }               ← apenas mudanças desde última extração
```

### Implementação do src/extractors/bds.js

```javascript
// Responsabilidades:
// 1. Listar todos os 137 datasets via API
// 2. Para cada dataset com FullDatasetLink disponível:
//    a. Fazer GET no DownloadLink (retorna ZIP)
//    b. Salvar o ZIP em csvs/zips/
//    c. Extrair o CSV para csvs/
//    d. Deletar o ZIP
// 3. Mostrar progresso: "📥 [23/137] Users — 45.3 MB / 178.5 MB"
// 4. Ao final: log com quantos baixados, quantos pulados, erros

// ATENÇÃO: Alguns arquivos podem ter 100MB+. Usar stream (pipeline do node:stream)
// para download — NÃO usar arrayBuffer() ou res.buffer() (estoura memória)

// Versão da API LP: usar '1.50' como padrão
// Se retornar erro de versão, tentar '1.48', '1.47' em ordem decrescente
```

---

## Fase 3 — Extração ADS (Advanced Data Sets)

### O que são

Relatórios gerados **sob demanda** com filtros obrigatórios. Exemplos:
- Uso do Instrutor
- Uso do Aluno
- Notas Finais

### Endpoints ADS

```
# Listar relatórios ADS disponíveis
GET /d2l/api/lp/(version)/dataExport/list

# Criar um job de exportação (POST com filtros)
POST /d2l/api/lp/(version)/dataExport/create
Body: {
  "DataSetId": "...",
  "Filters": [
    { "Name": "startDate", "Value": "2025-01-01T00:00:00.000Z" },
    { "Name": "endDate",   "Value": "2025-12-31T23:59:59.999Z" },
    { "Name": "parentOrgUnitId", "Value": "6606" },
    { "Name": "roles",     "Value": "110,115" }  ← IDs numéricos, não texto!
  ]
}

# Verificar status do job
GET /d2l/api/lp/(version)/dataExport/download/(exportJobId)
# Status possíveis: Queued, Processing, Complete, Error

# Quando Complete, a resposta inclui a URL de download
```

### Arquivo de configuração: config/ads-filters.json

```json
{
  "_instrucoes": "Configure os filtros para cada relatório ADS. Roles devem ser IDs numéricos.",
  "_como_obter_role_ids": "No Brightspace, vá em Admin > Roles e anote o ID de cada role",
  
  "Uso do instrutor": {
    "ativo": true,
    "parentOrgUnitId": "6606",
    "startDate": "2025-01-01T00:00:00.000Z",
    "endDate": "2025-12-31T23:59:59.999Z",
    "roles": ["109", "110", "115"]
  },
  "Uso do aluno": {
    "ativo": true,
    "parentOrgUnitId": "6606",
    "startDate": "2025-01-01T00:00:00.000Z",
    "endDate": "2025-12-31T23:59:59.999Z",
    "roles": ["112"]
  }
}
```

### Implementação do src/extractors/ads.js

```javascript
// Responsabilidades:
// 1. Ler config/ads-filters.json
// 2. Para cada relatório onde ativo=true:
//    a. Criar job via POST /dataExport/create
//    b. Fazer polling do status a cada 30s (timeout: 30 minutos)
//    c. Quando Complete: baixar e extrair para csvs/
// 3. Logar progresso e erros
// 4. roles: SEMPRE enviar como IDs numéricos. Documentar isso claramente.
//    A API rejeita strings como "Professor" com erro 400.
```

---

## Fase 4 — Carga no MySQL

### Implementação do src/loader/mysql-loader.js

```javascript
// Responsabilidades:
// 1. Ler config/transforms.json para saber quais tabelas criar/atualizar
// 2. Para cada CSV em csvs/:
//    a. Criar a tabela se não existir (schema inferido ou definido no config)
//    b. TRUNCATE TABLE antes de inserir (dados completos, não incrementais)
//    c. LOAD DATA LOCAL INFILE 'csvs/NomeArquivo.csv'
//       INTO TABLE nome_tabela
//       FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"'
//       LINES TERMINATED BY '\n'
//       IGNORE 1 ROWS  ← pular cabeçalho
//       (col1, col2, @col3, ...) SET col3 = NULLIF(@col3, '')
// 3. Log: tabela carregada, quantidade de linhas, tempo

// ATENÇÃO: Usar mysql2 com allowLocalInfile: true na conexão
// ATENÇÃO: O servidor MySQL também precisa ter local_infile=ON
//          Documentar como habilitar: SET GLOBAL local_infile = 1;

// Configuração de conexão via .env:
// DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
```

---

## Fase 5 — Transformação (Engine SQL)

### Conceito

As transformações são arquivos `.sql` na pasta `src/transforms/queries/`.
O `engine.js` executa esses arquivos em ordem e os resultados ficam disponíveis
como views ou tabelas no MySQL — que é exatamente o que o PowerBI já consome hoje.

### Arquivo de configuração: config/transforms.json

```json
{
  "_instrucoes": "Configure as transformações. Cada item é uma query SQL a executar após a carga.",
  "transformacoes": [
    {
      "nome": "view_alunos_ativos",
      "arquivo": "src/transforms/queries/alunos_ativos.sql",
      "ativo": true,
      "tipo": "view",
      "descricao": "View com alunos ativos por curso no semestre atual"
    },
    {
      "nome": "relatorio_notas",
      "arquivo": "src/transforms/queries/notas_por_curso.sql",
      "ativo": true,
      "tipo": "exportar_csv",
      "arquivo_saida": "exports/notas_por_curso.csv",
      "descricao": "Exporta notas consolidadas por curso"
    }
  ]
}
```

### Implementação do src/transforms/engine.js

```javascript
// Responsabilidades:
// 1. Ler config/transforms.json
// 2. Para cada transformação ativa, em ordem:
//    a. Se tipo === "view": executar CREATE OR REPLACE VIEW ...
//    b. Se tipo === "exportar_csv": executar a query e chamar csv-exporter.js
//    c. Se tipo === "table": executar CREATE TABLE AS SELECT ...
// 3. As queries SQL ficam em arquivos .sql separados (fáceis de editar)
// 4. Log de cada transformação executada

// IMPORTANTE: O usuário deve poder adicionar seus próprios .sql sem mexer no código.
// Basta criar o arquivo e adicionar ao config/transforms.json
```

---

## Fase 6 — Exportação

### src/exporter/csv-exporter.js

```javascript
// Executa uma query SQL e grava resultado como CSV em exports/
// Usar biblioteca 'csv-stringify' para gerar o CSV com cabeçalho
// Nome do arquivo: configurado em transforms.json ou gerado com timestamp
```

### src/exporter/powerbi.js

```javascript
// PowerBI conecta diretamente ao MySQL via connector nativo ou gateway.
// Este módulo garante que as VIEWS estejam atualizadas após a carga.
// Ação: depois de cada transformação tipo "view", executar REFRESH ou apenas
// garantir que CREATE OR REPLACE VIEW foi executado com sucesso.
// Logar: "✅ View 'view_alunos_ativos' atualizada — PowerBI pode sincronizar"
```

---

## Fase 7 — Orquestração e Agendamento

### Arquivo de configuração: config/schedule.json

```json
{
  "_instrucoes": "Configure o agendamento. Use cron syntax ou intervalos predefinidos.",
  "_exemplos_cron": {
    "todo_dia_3h": "0 3 * * *",
    "segunda_e_quinta_3h": "0 3 * * 1,4",
    "toda_semana_domingo_2h": "0 2 * * 0"
  },
  "agendamento": {
    "ativo": true,
    "cron": "0 3 * * *",
    "descricao": "Toda madrugada às 3h",
    "fuso_horario": "America/Sao_Paulo"
  },
  "pipeline": {
    "baixar_bds": true,
    "baixar_ads": true,
    "carregar_mysql": true,
    "executar_transformacoes": true,
    "exportar_csvs": true
  }
}
```

### src/pipeline.js

```javascript
// Orquestra todo o pipeline em sequência:
// 1. auth.getAccessToken() → valida/renova autenticação
// 2. bds.download()        → baixa os 137 BDS
// 3. ads.download()        → baixa os ADS configurados
// 4. mysqlLoader.load()    → carrega todos os CSVs no MySQL
// 5. engine.run()          → executa transformações
// 6. exporter.exportAll()  → gera CSVs de saída
// 7. Log final com resumo: duração total, arquivos processados, erros

// Também deve ser executável manualmente:
// node src/pipeline.js               → roda tudo agora
// node src/pipeline.js --apenas-bds  → só baixa BDS
// node src/pipeline.js --apenas-ads  → só baixa ADS
// node src/pipeline.js --apenas-load → só carrega no MySQL
// node src/pipeline.js --apenas-transform → só transforma
```

---

## Arquivo .env.example

```env
# Brightspace / D2L
BRIGHTSPACE_HOST=https://ava.catolica.edu.br
BRIGHTSPACE_CLIENT_ID=seu_client_id_aqui
BRIGHTSPACE_CLIENT_SECRET=seu_client_secret_aqui
BRIGHTSPACE_REDIRECT_URI=https://localhost:9876/callback

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=dataUCB
DB_PASSWORD=sua_senha_aqui
DB_NAME=data_ucb

# Configurações do pipeline
LOG_LEVEL=info
CSVS_DIR=./csvs
EXPORTS_DIR=./exports
LOGS_DIR=./logs
```

---

## Dependências (package.json)

```json
{
  "dependencies": {
    "mysql2": "^3.x",
    "node-cron": "^3.x",
    "dotenv": "^16.x",
    "csv-stringify": "^6.x",
    "adm-zip": "^0.5.x",
    "selfsigned": "^2.x"
  }
}
```

---

## Sequência de Implementação

Implementar **nesta ordem exata**, testando cada fase antes de avançar:

### Etapa 1 — Scaffolding
- [ ] Criar estrutura de pastas completa
- [ ] Criar `package.json` com scripts: `setup`, `start`, `pipeline`, `dev`
- [ ] Criar `.env.example` e `.gitignore`
- [ ] Criar `config/schedule.json`, `config/ads-filters.json`, `config/transforms.json` com exemplos

### Etapa 2 — Autenticação
- [ ] Implementar `src/auth/oauth.js`
- [ ] Testar: `node src/auth/oauth.js --setup` abre o browser e salva tokens
- [ ] Testar: `node src/auth/oauth.js --test` retorna `{ ok: true, user: '...' }`

### Etapa 3 — BDS
- [ ] Implementar `src/extractors/bds.js`
- [ ] Testar: listar todos os 137 datasets e logar nomes
- [ ] Testar: baixar apenas o primeiro dataset com stream + progresso
- [ ] Testar: baixar todos os datasets

### Etapa 4 — ADS
- [ ] Implementar `src/extractors/ads.js`
- [ ] Testar: criar job para "Uso do instrutor" com filtros do ads-filters.json
- [ ] Testar: polling de status e download quando concluído

### Etapa 5 — Carga MySQL
- [ ] Implementar `src/loader/mysql-loader.js`
- [ ] Testar: `LOAD DATA LOCAL INFILE` de um CSV pequeno
- [ ] Testar: carregar todos os CSVs em batch

### Etapa 6 — Transformações
- [ ] Implementar `src/transforms/engine.js`
- [ ] Criar `src/transforms/queries/exemplo.sql` como modelo comentado
- [ ] Testar: executar uma query de exemplo e verificar resultado

### Etapa 7 — Exportação
- [ ] Implementar `src/exporter/csv-exporter.js`
- [ ] Testar: gerar CSV de uma query simples em `exports/`

### Etapa 8 — Pipeline completo
- [ ] Implementar `src/pipeline.js`
- [ ] Testar pipeline completo de ponta a ponta
- [ ] Implementar agendamento com `node-cron` lendo `config/schedule.json`

### Etapa 9 — CLI interativa (UX)
- [ ] Implementar `src/cli.js` com menu interativo para:
  - Configurar autenticação (setup OAuth)
  - Editar `ads-filters.json` (adicionar/remover relatórios ADS, definir filtros)
  - Editar `schedule.json` (alterar frequência do agendamento)
  - Editar `transforms.json` (gerenciar transformações)
  - Rodar pipeline agora manualmente
  - Ver logs da última execução

---

## Pontos de Atenção Críticos

### API Brightspace
- **Roles devem ser IDs numéricos** — nunca texto ("Professor", "Aluno"). Erro 400 se texto.
- **POST requests exigem header `X-Csrf-Token`** — obtido via cookie ou endpoint dedicado.
  Com OAuth2 e Bearer token, esse requisito muda: verificar se o CSRF ainda é necessário
  com Authorization header. Testar e documentar comportamento real.
- **Versão da API LP:** tentar `1.50`, fallback para `1.48`, `1.47`.
- **Downloads grandes (>100MB):** sempre usar `stream.pipeline()` do Node.js nativo.
  Nunca `response.arrayBuffer()` ou `response.buffer()`.

### MySQL
- Habilitar `local_infile`: `SET GLOBAL local_infile = 1;`
- Na conexão mysql2: `{ allowLocalInfile: true }`
- `TRUNCATE TABLE` antes de cada `LOAD DATA` (dados são sempre completos do BDS)
- Tratar valores nulos: `SET coluna = NULLIF(@coluna, '')`

### Segurança
- **Nunca commitar `.env` ou `.tokens.json`**
- `.gitignore` deve incluir: `.env`, `.tokens.json`, `csvs/`, `exports/`, `logs/`, `node_modules/`
- Tokens OAuth salvos em arquivo local com permissões restritas (chmod 600)

### Logs
- Cada execução do pipeline gera arquivo em `logs/pipeline-YYYY-MM-DD.log`
- Formato: `[HH:MM:SS] [NIVEL] mensagem`
- Ao final do pipeline: resumo com duração, datasets baixados, tabelas carregadas, erros

---

## Mensagens e UX

Todos os logs e mensagens devem ser em **português**, claros e informativos:

```
🚀 Iniciando pipeline Brightspace ETL — 05/06/2025 03:00:00
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
🗄️  MySQL — Carregando dados...
  ✅ users              — 15.234 linhas — 2.1s
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 Transformações...
  ✅ view_alunos_ativos — view atualizada
  ✅ notas_por_curso    — exports/notas_por_curso.csv (2.341 linhas)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Pipeline concluído em 14m 21s
   📦 137 datasets BDS | 2 relatórios ADS
   🗄️  52 tabelas MySQL atualizadas
   📄 3 CSVs exportados → exports/
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
  "ads":       "node src/pipeline.js --apenas-ads",
  "load":      "node src/pipeline.js --apenas-load",
  "transform": "node src/pipeline.js --apenas-transform",
  "cli":       "node src/cli.js"
}
```

---

## Contexto do Negócio

- **Instituição:** Universidade Católica de Brasília (UCB)
- **Sistema:** Brightspace (D2L) — `ava.catolica.edu.br`
- **OrgUnitId padrão da instituição:** 6606
- **Banco MySQL:** host 127.0.0.1, porta 3307, user `dataUCB`, banco `data_ucb`
- **Dados:** 137 BDS diários + ADS sob demanda (Uso do Instrutor, Uso do Aluno, etc.)
- **Consumidores:** PowerBI (via views MySQL) + CSVs para entrega manual
- **Processo atual:** 100% manual — este sistema automatiza tudo

O processo atual de transformação dos dados já existe em SQL (no arquivo `load datas.sql`
do projeto TesteAPI-D2L). As queries desse arquivo devem ser migradas para
`src/transforms/queries/` como ponto de partida. O usuário poderá editar esses
arquivos e adicionar novos sem tocar no código Node.js.
