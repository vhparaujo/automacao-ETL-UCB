# Brightspace ETL — UCB

Automação do pipeline de dados do Brightspace (D2L) da Universidade Católica de Brasília. Substitui o processo manual de baixar CSVs pelo AVA → rodar SQL → atualizar PowerBI.

**Stack:** Node.js 18+ · MySQL · node-cron

---

## O que faz

1. **Extrai** os 137 datasets automáticos (BDS) e relatórios sob demanda (ADS) via API Brightspace
2. **Carrega** os CSVs no MySQL usando `LOAD DATA LOCAL INFILE`
3. **Transforma** os dados executando queries `.sql` configuráveis
4. **Exporta** resultados como CSVs e atualiza views do PowerBI
5. **Agenda** tudo para rodar automaticamente toda madrugada

---

## Instalação

```bash
# Clonar e instalar dependências
npm install

# Copiar e preencher as credenciais
cp .env.example .env
# edite .env com suas credenciais do Brightspace e MySQL
```

### MySQL (Docker)

O MySQL roda num container definido em `docker-compose.yml` (MySQL 8.4, `local_infile` já habilitado, utf8mb4). Com o Docker Desktop aberto:

```bash
npm run db:up     # cria/sobe o container etl-ucb-mysql em 127.0.0.1:3307 e espera ficar saudável
npm run db:down   # para o container (os dados ficam no volume etl-ucb-mysql-data)
npm run db:logs   # acompanha o log do MySQL
```

O banco, o usuário e a senha vêm do `.env` (`DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`) e são criados na primeira inicialização. A porta só aceita conexões da própria máquina. O container tem `restart: unless-stopped`, então volta sozinho quando o Docker Desktop abre — mas o Docker Desktop precisa estar aberto no horário do agendamento.

> Mudar `DB_USER`/`DB_PASSWORD` depois da primeira inicialização não altera o usuário já criado no volume. Para recriar do zero: `docker compose down -v` (**apaga os dados**) e `npm run db:up`; depois rode `npm run load` para recarregar os CSVs.

---

## Primeiro uso — Autenticação OAuth

A autenticação é feita pelo pacote [`brightspace-auth`](https://github.com/vhparaujo/Authorization-Service-UCB), que cuida do fluxo OAuth 2.0 (Authorization Code + Refresh Token), do cache dos tokens e da renovação automática. As credenciais e os scopes vêm do `.env` (`BRIGHTSPACE_CLIENT_ID`, `BRIGHTSPACE_CLIENT_SECRET`, `BRIGHTSPACE_REDIRECT_URI`, `BRIGHTSPACE_SCOPES`).

Rode o setup **uma única vez** por projeto:

```bash
npm run setup
```

Abre o navegador para login no Brightspace. Aceite o aviso de certificado autoassinado e autorize o app. Os tokens são salvos localmente em `.tokens.json` e, a partir daí, renovados automaticamente via refresh token — não é preciso repetir o login.

Para verificar se a autenticação está funcionando:

```bash
npm run test-auth
```

---

## CLI Interativa

A forma mais fácil de usar o sistema. Inicia um menu interativo no terminal:

```bash
npm run cli
```

### Menu principal

```
╔══════════════════════════════════════════╗
║   Brightspace ETL — UCB  v1.0            ║
╚══════════════════════════════════════════╝

  [1] Configurar autenticação OAuth
  [2] Gerenciar datasets automáticos (BDS/ADS)
  [3] Configurar agendamento
  [4] Gerenciar transformações SQL
  [5] Rodar pipeline agora
  [6] Download sob demanda
  [7] Ver último log
  [0] Sair
```

---

### [1] Configurar autenticação OAuth

Verifica se o `.env` existe e guia o usuário pelo fluxo de autorização OAuth 2.0. Exibe os scopes necessários antes de abrir o navegador.

**Quando usar:** primeiro uso ou quando o refresh token expirar. Se o refresh token for revogado/expirar, o pipeline (inclusive o agendado) para logo na autenticação com a mensagem `🔐 Refresh token inválido ou expirado — rode "npm run setup" para reautenticar` e grava `logs/ULTIMA_FALHA_AUTH.txt`; o arquivo é removido automaticamente na próxima autenticação bem-sucedida.

---

### [2] Gerenciar datasets automáticos (BDS/ADS)

Submenu com 3 opções:

**[1] BDS — editar lista de downloads automáticos**
- Alterna entre baixar **todos os 137 datasets** ou uma **lista personalizada**
- Adiciona ou remove datasets da lista automática pelo nome (ex: `Usuários`, `Users`). A comparação ignora acentos, maiúsculas/minúsculas, espaços, `_` e `-` — `Usuarios` e `Usuários` são o mesmo dataset

**[2] ADS — ativar/desativar relatórios automáticos**
- Lista todos os relatórios ADS configurados
- Alterna cada um entre `🔄 automático` (roda no pipeline) e `🖱️ sob demanda` (apenas manual)

**[3] Adicionar novo relatório ADS**
- Solicita: nome do relatório (como aparece no Brightspace), OrgUnitId, período (data início/fim), IDs das roles
- As datas aceitam `YYYY-MM-DD` ou expressões relativas (`agora`, `hoje`, `-180d`, `inicio_semestre`…) — ver [Datas relativas nos filtros ADS](#datas-relativas-nos-filtros-ads)
- Pergunta se deve rodar automaticamente no pipeline
- Salva em `config/ads-filters.json`

> **Atenção:** roles devem ser **IDs numéricos** (ex: `109,110`), nunca texto. Para descobrir os IDs, use `npm run roles`.

---

### [3] Configurar agendamento

Define quando o pipeline roda automaticamente. Opções predefinidas:

| Opção | Cron | Descrição |
|-------|------|-----------|
| [1] | `0 3 * * *` | Diário às 3h |
| [2] | `0 3 * * 1,4` | Segunda e quinta às 3h |
| [3] | `0 2 * * 0` | Todo domingo às 2h |
| [4] | personalizado | Qualquer expressão cron |
| [5] | — | Ativar ou desativar o agendamento |

Configuração salva em `config/schedule.json`.

---

### [4] Gerenciar transformações SQL

Lista todas as transformações configuradas em `config/transforms.json` com seu status (`✅` ativo / `⏸️` inativo).

- **[T]** Ativar/desativar uma transformação pelo número

Para adicionar uma nova transformação:
1. Crie o arquivo `.sql` em `src/transforms/queries/`
2. Adicione a entrada em `config/transforms.json` com `nome`, `arquivo`, `tipo` (`view`, `exportar_csv` ou `table`) e `ativo: true`
3. Teste só ela: `npm run transform -- --so <nome>`

Passo a passo completo para analistas (tipos de coluna, filtros típicos dos BDS, modelos de `.sql`, privacidade e problemas conhecidos): **[GUIA_ANALISTA.md](GUIA_ANALISTA.md)**.

---

### [5] Rodar pipeline agora

Executa o pipeline manualmente, sem esperar o agendamento:

| Opção | Equivalente npm | O que faz |
|-------|----------------|-----------|
| [1] Pipeline completo | `npm run pipeline` | Arquiva `csvs/` em `csvs/_anterior/` + BDS + ADS automáticos + carga + transformações + inventário |
| [2] Apenas BDS | `npm run bds` | Só baixa os BDS automáticos |
| [3] Apenas ADS | `npm run ads` | Só baixa os ADS marcados como automáticos |
| [4] Apenas carga MySQL | `npm run load` | Carrega os CSVs já baixados no MySQL |
| [5] Apenas transformações | `npm run transform` | Executa as queries SQL configuradas |

As etapas executadas no pipeline completo seguem `pipeline` em `config/schedule.json`. Com `"exportar_csvs": false`, as transformações do tipo `exportar_csv` são puladas (`⏭️  pulada (exportar_csvs = false)`), enquanto `view` e `table` continuam rodando; o resumo final mostra quantas foram puladas. Ao final das transformações, o pipeline lista as views atualizadas para o PowerBI.

**`csvs/_anterior/`:** no pipeline completo (`npm run pipeline`, opção [1] e o agendamento), o conteúdo atual de `csvs/` é movido para `csvs/_anterior/` **antes** dos downloads — nada é apagado, mas só a última execução fica guardada (o `_anterior` antigo é substituído). Assim, um CSV baixado sob demanda semanas atrás não é recarregado toda noite. O loader e o inventário ignoram `csvs/_anterior/` e `csvs/zips/`. Execuções parciais (`--apenas-*`) e downloads sob demanda pela CLI **não** mexem na pasta. No fim, o resumo lista as tabelas do MySQL que **não** foram atualizadas nesta execução (o CSV delas não foi baixado).

---

### [6] Download sob demanda

Baixa dados específicos sem alterar as configurações de automação:

**[1] Baixar BDS específico(s)**
- Carrega a lista completa de datasets disponíveis na API
- Permite selecionar por número (ex: `1,5,12`) ou digitar `todos`

**[2] Baixar todos os BDS disponíveis**
- Baixa todos os 137 datasets (pode demorar e usar muito espaço)
- Pede confirmação antes de iniciar

**[3] Baixar relatório ADS específico**
- Lista os relatórios disponíveis na API com indicação de quais já têm configuração salva
- Se o relatório não tiver configuração, solicita os filtros (período, roles, OrgUnitId)
- Oferece salvar a configuração para uso futuro

---

### [7] Ver último log

Exibe as últimas 50 linhas do log mais recente em `logs/`. Útil para verificar erros após uma execução.

Se existir `logs/ULTIMA_FALHA_AUTH.txt`, mostra antes um alerta destacado de que a última execução falhou na autenticação e é preciso rodar `npm run setup`.

---

## Comandos npm diretos

```bash
npm run setup       # Configurar autenticação OAuth (primeiro uso)
npm run cli         # Abrir CLI interativa
npm run pipeline    # Rodar pipeline completo agora
npm run bds         # Baixar apenas BDS
npm run ads         # Baixar apenas ADS
npm run load        # Carregar CSVs no MySQL
npm run transform   # Executar transformações SQL
npm run transform -- --so vw_x   # Só a transformação vw_x (sem autenticar/baixar/carregar)
npm run start       # Iniciar com agendamento automático (modo watch)
npm run roles       # Listar IDs das roles disponíveis no Brightspace
npm run test-auth   # Testar se a autenticação está funcionando
npm test            # Rodar os testes unitários (node:test, sem MySQL/Brightspace)
npm run db:up       # Subir o MySQL (Docker)
npm run db:down     # Parar o MySQL (Docker)
npm run db:logs     # Log do MySQL (Docker)
npm run ads:filtros # Filtros que cada ADS aceita vs. config/ads-filters.json
npm run inventario  # Gerar exports/_inventario_csvs.md
```

---

## Estrutura de arquivos de configuração

| Arquivo | Descrição |
|---------|-----------|
| `.env` | Credenciais (nunca commitar) |
| `config/ads-filters.json` | Filtros e configurações dos relatórios ADS |
| `config/bds-selecao.json` | Lista de BDS para download automático |
| `config/schemas.json` | Schemas fixos das tabelas (tipos, nome da tabela, `aliases`) |
| `config/schedule.json` | Cron, agendamento e etapas do pipeline (`exportar_csvs` etc.) |
| `config/transforms.json` | Transformações SQL a executar |

### Datas relativas nos filtros ADS

Em `config/ads-filters.json`, `startDate` e `endDate` aceitam datas ISO em UTC (`2026-01-01T00:00:00.000Z`, como antes) **ou** expressões relativas, recalculadas a cada execução — assim os relatórios agendados não ficam presos a um período fixo:

| Valor | `startDate` | `endDate` |
|-------|-------------|-----------|
| `agora` | instante exato da execução | instante exato da execução (ex.: `2026-11-11T14:32:07.512Z`) |
| `hoje` | hoje 00:00:00.000Z | hoje 23:59:59.999Z |
| `-Nd` (ex.: `-180d`) | N dias atrás, 00:00:00.000Z | N dias atrás, 23:59:59.999Z |
| `inicio_ano` / `fim_ano` | 01/01 do ano corrente | 31/12 do ano corrente |
| `inicio_semestre` / `fim_semestre` | 01/01 ou 01/07 | 30/06 ou 31/12 |

Semestre 1 = jan–jun, semestre 2 = jul–dez. As datas são sempre enviadas à API em UTC com `Z` (offsets como `-03:00` causam erro 400). O log mostra o período efetivo de cada relatório:

```
📅 Período: 2026-07-01T00:00:00.000Z → 2026-12-31T23:59:59.999Z
```

Exemplo:

```json
"Uso do instrutor": {
  "automatico": true,
  "ativo": true,
  "parentOrgUnitId": "6606",
  "startDate": "inicio_semestre",
  "endDate": "agora",
  "roles": ["109"]
}
```

Expressão inválida (ou início depois do fim) gera erro apenas naquele relatório; os demais continuam.

### Schemas fixos e aliases

O loader procura em `config/schemas.json` um schema para cada CSV pelo nome do arquivo (sem `.csv`). A comparação ignora acentos, maiúsculas/minúsculas, espaços, `_` e `-`, e também considera o campo opcional `aliases`:

```json
"Users": {
  "tabela": "users",
  "aliases": ["Usuários"],
  "colunas": { "UserId": "INT", "UserName": "VARCHAR(255)" }
}
```

Para corrigir um CSV que deveria ter schema, veja o nome real do arquivo em `csvs/` (ou no inventário) e adicione-o em `aliases` da entrada correspondente. Entradas sem `aliases` continuam funcionando como antes.

### CSVs sem schema fixo: todas as colunas `TEXT`

Quando um CSV não casa com nenhum schema, a tabela é criada com **todas as colunas `TEXT`**, e o log destaca:

```
🔍 Sem schema fixo para "<arquivo>" → tabela "<tabela>" carregada com todas as colunas TEXT
```

É o padrão seguro para dados ainda desconhecidos: a inferência pelo nome da coluna pode truncar dados sem erro (ex.: `ID definido da organização` contém texto, mas viraria `INT`). Para voltar à inferência, defina `INFERIR_TIPOS=true` no `.env`. Se a tabela já existir com outra estrutura (colunas novas ou tipos antigos), ela é recriada (`♻️` no log); com a mesma estrutura, só é truncada. Tabelas com schema fixo não mudam. Use `CAST`/`STR_TO_DATE` nas queries, ou crie um schema em `config/schemas.json` depois de inspecionar o inventário.

### Nome do CSV dos ADS (`arquivo_csv`)

O CSV de cada ADS é salvo como `csvs/<nome>.csv`, onde `<nome>` é o nome do relatório sem acentos, em minúsculas, com `_` no lugar de espaços e símbolos (`Notas finais` → `notas_finais.csv`, `Premiações emitidas` → `premiacoes_emitidas.csv`). Para escolher outro nome — por exemplo, para não colidir com um BDS de mesmo nome — use `arquivo_csv` (sem `.csv`; só letras, números, `_` e `-`):

```json
"Premiações emitidas": {
  "_revisar": "confirmar filtros com npm run ads:filtros",
  "automatico": false,
  "ativo": true,
  "arquivo_csv": "ads_premiacoes_emitidas",
  "startDate": "2026-07-01T00:00:00.000Z",
  "endDate": "2026-12-31T23:59:59.999Z"
}
```

As chaves `ativo`, `automatico`, `arquivo_csv` e qualquer chave iniciada por `_` (comentários, como `_revisar`) **não** são enviadas à API; todas as outras viram filtros do relatório.

### Filtros de cada ADS (`npm run ads:filtros`)

Cada relatório ADS declara os seus filtros (ex.: "Notas finais" só tem intervalo de datas). Para ver o que a API declara e comparar com `config/ads-filters.json`:

```bash
npm run ads:filtros            # relatórios configurados
npm run ads:filtros -- --todos # todos os ADS disponíveis na API
```

Para cada relatório mostra os filtros declarados (nome, tipo, descrição, valor padrão), marca `⚠️  filtro desconhecido` para chaves do config que a API não declara e `ℹ️  não configurado — a API usará o padrão` para filtros declarados ausentes do config. Se a resposta não vier no formato documentado, imprime o JSON bruto do primeiro item.

### Inventário dos CSVs (`npm run inventario`)

Gera `exports/_inventario_csvs.md` com, para cada CSV de `csvs/` (sem `_anterior/` e `zips/`): tamanho, número de registros (lido em stream), tabela MySQL de destino, se tem schema fixo ou será `TEXT`, origem (BDS/ADS, pelo nome configurado), colunas na ordem do cabeçalho, o formato das colunas de data/hora (com um exemplo) e se as colunas de ID são todas numéricas. Roda automaticamente no fim do pipeline completo.

> **Privacidade:** só as colunas de data/hora mostram um exemplo de valor (formato não reconhecido vira máscara, ex.: `99/99/9999`). Nenhum outro valor — nome, e-mail, matrícula — entra no inventário. As detecções usam as 1.000 primeiras linhas.

---

## Estrutura de pastas geradas em runtime

```
csvs/            ← CSVs da execução atual (os únicos carregados no MySQL)
csvs/_anterior/  ← CSVs da execução anterior (substituído a cada pipeline completo)
csvs/zips/       ← temporário dos downloads
exports/         ← CSVs exportados após transformação e _inventario_csvs.md
logs/       ← Logs de cada execução (pipeline-YYYY-MM-DD.log)
              e ULTIMA_FALHA_AUTH.txt quando a autenticação falhar
```

---

## Variáveis de ambiente (.env)

```env
# Brightspace / D2L
BRIGHTSPACE_HOST=https://ava.catolica.edu.br
BRIGHTSPACE_CLIENT_ID=seu_client_id
BRIGHTSPACE_CLIENT_SECRET=seu_client_secret
BRIGHTSPACE_REDIRECT_URI=https://localhost:9876/callback
BRIGHTSPACE_SCOPES=datahub:dataExports:download datahub:dataExports:read datasets:bds:read core:*:*

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=dataUCB
DB_PASSWORD=sua_senha
DB_NAME=data_ucb

# Tabelas sem schema fixo: false (padrão) = todas TEXT; true = infere tipos pelo nome da coluna
INFERIR_TIPOS=false
```
