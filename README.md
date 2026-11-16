# Brightspace Downloads — UCB

Automação do download dos dados do Brightspace (D2L) da Universidade Católica de Brasília. Substitui o processo manual de baixar os CSVs pelo AVA.

**Stack:** Node.js 18+ · node-cron

---

## O que faz

1. **Baixa** os datasets automáticos (BDS — completo semanal e diferencial diário) e os relatórios sob demanda (ADS) via API Brightspace, salvando os CSVs em `csvs/`
2. **Agenda** os downloads para rodarem automaticamente (node-cron)
3. **Registra** cada execução em `logs/` e gera um inventário dos CSVs baixados

---

## Instalação

```bash
# Clonar e instalar dependências
npm install

# Copiar e preencher as credenciais
cp .env.example .env
# edite .env com suas credenciais do Brightspace
```

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
║   Brightspace Downloads — UCB  v1.0      ║
╚══════════════════════════════════════════╝

  [1] Configurar autenticação OAuth
  [2] Gerenciar datasets automáticos (BDS/ADS)
  [3] Configurar agendamento
  [4] Rodar downloads automáticos agora
  [5] Download sob demanda
  [6] Ver último log
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

O `npm start` roda os agendamentos de `config/schedule.json` → `agendamentos`. Cada um diz o que baixar
(`"bds": "completo" | "diferencial" | false`, `"ads": true | false`); `pipeline.baixar_bds` /
`pipeline.baixar_ads` são a chave geral. Padrão (alinhado aos horários em que o Brightspace da UCB gera os BDS):

| Agendamento | Cron | O que roda |
|-------------|------|-----------|
| BDS diferencial + ADS | `0 6 * * *` | Todo dia 6h — BDS **diferencial do dia** (gerado ~5h20) + ADS |
| BDS completo | `0 9 * * 1` | Segunda 9h — BDS **completo** (gerado ~8h20) |

Execuções que coincidirem (ex.: o das 6h de segunda ainda rodando às 9h) entram em fila. No menu:
**[A]** ativa/desativa um agendamento, **[C]** troca o cron, **[P]** restaura o padrão.
Reinicie o `npm start` depois de alterar. O formato antigo (um único `"agendamento"`) continua aceito
como BDS completo + ADS.

#### BDS completo × diferencial

- **Completo:** sai 1x por semana (segunda) com a tabela inteira; os CSVs vão para `csvs/` e
  `csvs/_bds_extracts.json` registra de qual extract veio cada um.
- **Diferencial:** sai todo dia com só as linhas **alteradas**, no mesmo CSV/colunas do completo.
- O download baixa **só o diferencial gerado hoje** (fuso de Brasília), em
  `csvs/diferencial/` (mesmo nome do CSV do completo, ex.: `Users.csv`; o do dia seguinte sobrescreve) —
  os de dias anteriores não são baixados. Se o de hoje ainda não
  saiu, o dataset é pulado (`o diferencial de hoje ainda não foi gerado`). Na segunda depois das ~8h20 o
  diferencial do dia já está no completo e também é pulado.
- `csvs/diferencial/_bds_extracts.json` registra, para cada CSV, a data do diferencial (`criado`), a do
  completo em que ele se baseia (`base`) e a do diferencial anterior na API (`anterior`) — quem consome
  os CSVs usa isso para saber se perdeu algum dia (**dia perdido não é baixado de novo**).
- O diferencial **não** traz exclusões físicas (ex.: desinscrição); exclusões lógicas (`IsDeleted`,
  `DateDeleted`) chegam normalmente. O completo de segunda traz o estado inteiro.

---

### [4] Rodar downloads automáticos agora

Executa os downloads manualmente, sem esperar o agendamento:

| Opção | Equivalente npm | O que faz |
|-------|----------------|-----------|
| [1] BDS completo + ADS | `npm run pipeline` | Arquiva `csvs/` em `csvs/_anterior/` + BDS + ADS automáticos + inventário |
| [2] Apenas BDS completo | `npm run bds` | Só baixa os BDS automáticos |
| [3] Apenas ADS | `npm run ads` | Só baixa os ADS marcados como automáticos |
| [4] BDS diferencial + ADS | `npm run pipeline -- --diferencial` | Como [1], mas baixa o BDS diferencial do dia |
| [5] Apenas BDS diferencial | `npm run bds:diferencial` | Só baixa o diferencial do dia |

O que é baixado na execução completa também segue `pipeline.baixar_bds` / `pipeline.baixar_ads` em `config/schedule.json`.

**`csvs/_anterior/`:** no pipeline completo (`npm run pipeline`, opção [1] e o agendamento), o conteúdo atual de `csvs/` é movido para `csvs/_anterior/` **antes** dos downloads — nada é apagado, mas só a última execução fica guardada (o `_anterior` antigo é substituído). Assim, `csvs/` fica só com o que foi baixado na execução — um CSV baixado sob demanda semanas atrás não se mistura com os de hoje. O inventário ignora `csvs/_anterior/` e `csvs/zips/`. Execuções parciais (`--apenas-*`) e downloads sob demanda pela CLI **não** mexem na pasta. No fim, o resumo lista os downloads que falharam mesmo após a nova tentativa.

---

### [5] Download sob demanda

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

### [6] Ver último log

Exibe as últimas 50 linhas do log mais recente em `logs/`. Útil para verificar erros após uma execução.

Se existir `logs/ULTIMA_FALHA_AUTH.txt`, mostra antes um alerta destacado de que a última execução falhou na autenticação e é preciso rodar `npm run setup`.

---

## Comandos npm diretos

```bash
npm run setup       # Configurar autenticação OAuth (primeiro uso)
npm run cli         # Abrir CLI interativa
npm run pipeline    # Baixar agora BDS completo + ADS automáticos
npm run bds         # Baixar apenas BDS (completo)
npm run bds:diferencial   # Baixar apenas o BDS diferencial do dia
npm run ads         # Baixar apenas ADS
npm run ads -- --inicio 2026-08-01   # ADS com outro startDate (só nesta execução)
npm run start       # Iniciar com agendamento automático (modo watch)
npm run roles       # Listar IDs das roles disponíveis no Brightspace
npm run test-auth   # Testar se a autenticação está funcionando
npm test            # Rodar os testes unitários (node:test, sem acessar o Brightspace)
npm run ads:filtros # Filtros que cada ADS aceita vs. config/ads-filters.json
npm run ads:periodo -- --inicio 2026-08-01   # Grava novo startDate em todos os ADS
npm run inventario  # Gerar exports/_inventario_csvs.md
```

---

## Estrutura de arquivos de configuração

| Arquivo | Descrição |
|---------|-----------|
| `.env` | Credenciais (nunca commitar) |
| `config/ads-filters.json` | Filtros e configurações dos relatórios ADS |
| `config/bds-selecao.json` | Lista de BDS para download automático |
| `config/schedule.json` | Agendamentos (cron + BDS completo/diferencial + ADS) e chave geral de BDS/ADS |

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

#### Alterar o período no JSON pelo terminal (`npm run ads:periodo`)

Para mudar `startDate`/`endDate` **gravando** em `config/ads-filters.json` (vale para as próximas
execuções e para o agendamento), sem abrir o arquivo no servidor:

```bash
npm run ads:periodo                                          # mostra o período atual de cada ADS
npm run ads:periodo -- --inicio 2026-08-01                   # startDate de TODOS os ADS
npm run ads:periodo -- --inicio inicio_semestre --fim agora  # início e fim
npm run ads:periodo -- --inicio -30d --so "Uso do Aluno,Notas finais"   # só esses relatórios
```

Só altera os relatórios que já têm a chave. Valor inválido, nome de relatório inexistente ou início
depois do fim → erro e **nada é gravado**. A gravação é atômica (arquivo temporário + rename).
Não precisa de autenticação.

#### Trocar o período só em uma execução (`--inicio` / `--fim`)

Para rodar com outro período **sem editar o JSON**, passe `--inicio` e/ou `--fim`. O valor substitui
`startDate`/`endDate` de **todos** os ADS da execução (só nos que já têm esse filtro no config) e
vale apenas para aquela execução — `config/ads-filters.json` não é alterado e o agendamento segue igual.

```bash
npm run ads -- --inicio 2026-08-01                 # todos os ADS a partir de 01/08
npm run ads -- --inicio -30d --fim hoje            # últimos 30 dias
npm run pipeline -- --inicio=inicio_semestre       # execução completa com outro início
```

Aceita os mesmos valores da tabela acima, além de `YYYY-MM-DD` (início do dia em `--inicio`, fim do
dia em `--fim`). Valor inválido ou início depois do fim → erro antes de autenticar. Não combina com
`--watch`. Na CLI ([4] → [1], [3] ou [4]) há a pergunta "Data de início dos ADS".

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

Gera `exports/_inventario_csvs.md` com, para cada CSV de `csvs/` (sem `_anterior/` e `zips/`): tamanho, número de registros (lido em stream), origem (ADS pelo nome configurado; BDS pelo dataset registrado em `csvs/_bds_extracts.json`), colunas na ordem do cabeçalho, o formato das colunas de data/hora (com um exemplo) e se as colunas de ID são todas numéricas. Roda automaticamente no fim do pipeline completo.

> **Privacidade:** só as colunas de data/hora mostram um exemplo de valor (formato não reconhecido vira máscara, ex.: `99/99/9999`). Nenhum outro valor — nome, e-mail, matrícula — entra no inventário. As detecções usam as 1.000 primeiras linhas.

---

## Estrutura de pastas geradas em runtime

```
csvs/              ← CSVs da execução atual (BDS completo + ADS) e _bds_extracts.json
csvs/diferencial/  ← BDS diferencial do dia e _bds_extracts.json
csvs/_anterior/    ← CSVs da execução anterior (substituído a cada execução completa)
csvs/zips/         ← temporário dos downloads
exports/           ← _inventario_csvs.md
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

# Pastas
CSVS_DIR=./csvs
EXPORTS_DIR=./exports
LOGS_DIR=./logs

# Downloads BDS/ADS: total de tentativas (1 = sem nova tentativa) e espera entre elas
DOWNLOAD_TENTATIVAS=2
DOWNLOAD_ESPERA_SEGUNDOS=30
```
