# Brightspace Downloads — UCB

Automação do download dos dados do Brightspace (D2L) da Universidade Católica de Brasília e da carga desses dados no MySQL. Substitui o processo manual de baixar os CSVs pelo AVA.

**Stack:** Node.js 18+ · MySQL · node-cron

---

## O que faz

1. **Baixa** os datasets automáticos (BDS — completo semanal e diferencial diário) e os relatórios sob demanda (ADS) via API Brightspace, salvando os CSVs em `csvs/`
2. **Carrega** os CSVs no MySQL (`LOAD DATA LOCAL INFILE`); o BDS diferencial é aplicado como *upsert*
3. **Agenda** tudo para rodar automaticamente (node-cron)
4. **Registra** cada execução em `logs/` e gera um inventário dos CSVs baixados

---

## Instalação

```bash
# Clonar e instalar dependências
npm install

# Copiar e preencher as credenciais
cp .env.example .env
# edite .env com suas credenciais do Brightspace e do MySQL
```

### MySQL (instalado no servidor)

O projeto usa um MySQL já instalado na máquina (sem Docker). Configuração em `.env`: `DB_HOST`,
`DB_PORT` (padrão 3306), `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

**1. Banco e usuário** (uma vez, como root):

```sql
CREATE DATABASE data_ucb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'dataUCB'@'localhost' IDENTIFIED BY 'troque_esta_senha';
GRANT ALL PRIVILEGES ON data_ucb.* TO 'dataUCB'@'localhost';
```

O loader cria, apaga e recria tabelas e índices dentro do banco — por isso o usuário precisa de todos
os privilégios **nesse banco** (não em `*.*`). Use `'dataUCB'@'127.0.0.1'` se a conexão for por TCP e o
MySQL não casar `localhost` com ela.

**2. `local_infile` ligado no servidor** — a carga usa `LOAD DATA LOCAL INFILE`. Para valer depois de
reiniciar o MySQL, coloque no arquivo de configuração (ex.: `/etc/mysql/mysql.conf.d/mysqld.cnf`
no Ubuntu, `/etc/my.cnf` no RHEL/Rocky):

```ini
[mysqld]
local_infile = 1
```

e reinicie (`sudo systemctl restart mysql` ou `mysqld`). Para ligar na hora sem reiniciar:
`SET GLOBAL local_infile = 1;` (some no próximo restart se não estiver no arquivo). Conferir:
`SELECT @@local_infile;` → `1`. Sem isso a carga falha com
`Loading local data is disabled` e o log sugere o comando.

**3. Testar:** `npm run bds && npm run load` (ou `npm run pipeline`). No log aparecem as tabelas, linhas e tempo.

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

## Servidor Linux — agendamento contínuo com pm2

Quem dispara os downloads nos horários de `config/schedule.json` é o próprio `npm start`
(`node src/pipeline.js --watch`, com node-cron). **Se esse processo não estiver rodando, nada dispara.**
No servidor ele é mantido pelo [pm2](https://pm2.keymetrics.io/): roda sem terminal aberto, reinicia se
cair e volta sozinho após reboot. O fuso vem de `fuso_horario` do `schedule.json` — o fuso do servidor
não importa.

### Instalação (uma vez, dentro da pasta do projeto)

```bash
npm install                     # dependências do projeto
cp .env.example .env            # e preencha as credenciais
# autenticação: ver "Setup no servidor (sem navegador)" abaixo
npm run test-auth               # confirma que os tokens funcionam

sudo npm install -g pm2
pm2 start src/pipeline.js --name etl-ucb -- --watch
pm2 save                        # grava a lista de processos
pm2 startup                     # imprime um comando "sudo env PATH=... pm2 startup systemd ..." — execute-o
```

> ⚠️ O `--watch` vai **depois do `--`** (é argumento do pipeline). `pm2 start src/pipeline.js --watch`
> (sem `--`) liga o *file watch* do pm2, que reinicia o processo a cada arquivo gravado em `csvs/` e
> `logs/` — os downloads são mortos no meio. Confira com `pm2 describe etl-ucb` → `watch & reload: ✘`.

Rode o `pm2 start` **na pasta do projeto**: é ela que define onde ficam `.env`, `.tokens.json`,
`config/`, `csvs/` e `logs/`. Use o mesmo usuário Linux do `npm run setup` (dono do `.tokens.json`).

### Setup no servidor (sem navegador)

O `npm run setup` imprime a URL de autorização e espera o retorno em `https://localhost:9876/callback`
**na própria máquina**. Em servidor sem interface gráfica, use um túnel SSH a partir do seu computador:

```bash
ssh -L 9876:localhost:9876 usuario@servidor   # mantenha esta sessão aberta
cd /caminho/do/projeto && npm run setup       # no servidor, dentro do túnel
```

Abra no **seu** navegador a URL impressa, faça login e aceite o aviso de certificado — o retorno passa
pelo túnel e os tokens são salvos no servidor. Alternativa: rodar o setup no seu computador e copiar o
`.tokens.json` para a pasta do projeto no servidor (`chmod 600 .tokens.json`).

### Dia a dia

```bash
pm2 status               # rodando? quantos restarts?
pm2 logs etl-ucb         # saída em tempo real (Ctrl+C sai; o processo continua)
pm2 restart etl-ucb      # OBRIGATÓRIO após alterar config/schedule.json (lido só ao iniciar)
pm2 stop etl-ucb         # pausa os agendamentos
pm2 delete etl-ucb && pm2 save   # remove de vez
```

- Atualizou o código (`git pull` / `npm install`)? → `pm2 restart etl-ucb`.
- O log detalhado de cada execução continua em `logs/pipeline-YYYY-MM-DD.log`.
- Refresh token expirado: o pipeline grava `logs/ULTIMA_FALHA_AUTH.txt` e não baixa nada — refaça o
  setup (acima); não é preciso reiniciar o pm2.

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
  [4] Rodar downloads + carga MySQL agora
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
(`"bds": "completo" | "diferencial" | false`, `"ads": true | false`); depois dos downloads os CSVs
são carregados no MySQL. `pipeline.baixar_bds` / `pipeline.baixar_ads` / `pipeline.carregar_mysql`
são a chave geral. Padrão (alinhado aos horários em que o Brightspace da UCB gera os BDS):

| Agendamento | Cron | O que roda |
|-------------|------|-----------|
| BDS diferencial + ADS | `0 6 * * *` | Todo dia 6h — BDS **diferencial do dia** (gerado ~5h20) + ADS + carga |
| BDS completo | `0 9 * * 1` | Segunda 9h — BDS **completo** (gerado ~8h20) + carga |

Execuções que coincidirem (ex.: o das 6h de segunda ainda rodando às 9h) entram em fila. No menu:
**[A]** ativa/desativa um agendamento, **[C]** troca o cron, **[P]** restaura o padrão.
Reinicie o `npm start` depois de alterar. O formato antigo (um único `"agendamento"`) continua aceito
como BDS completo + ADS.

#### BDS completo × diferencial

- **Completo:** sai 1x por semana (segunda) com a tabela inteira; os CSVs vão para `csvs/`
  (`csvs/_bds_extracts.json` registra de qual extract veio cada um) e são carregados como sempre
  (DROP + CREATE + LOAD).
- **Diferencial:** sai todo dia com só as linhas **alteradas**, no mesmo CSV/colunas do completo. É aplicado
  como *upsert*: carrega em uma tabela temporária `_dif_<tabela>`, apaga da tabela as linhas com a mesma
  chave e insere as novas. As chaves estão em `config/bds-diferencial.json` (logs usam todas as colunas).
- O download baixa **só o diferencial gerado hoje** (fuso de Brasília), em
  `csvs/diferencial/` (mesmo nome do CSV do completo, ex.: `Users.csv`; o do dia seguinte sobrescreve) —
  os de dias anteriores não são baixados. Se o de hoje ainda não
  saiu, o dataset é pulado (`o diferencial de hoje ainda não foi gerado`). Na segunda depois das ~8h20 o
  diferencial do dia já está no completo e também é pulado.
  A carga pula diferenciais já aplicados (controle na tabela `_etl_bds_estado`).
- **Dia perdido não é recuperado:** se o diferencial de um dia não foi aplicado (servidor desligado, erro),
  a carga do dia seguinte avisa (`⚠️ o diferencial anterior (…) não foi aplicado`) e as alterações dele
  faltam até o completo de segunda — ou rode `npm run bds` + `npm run load` para corrigir na hora.
- Se a tabela não estiver com o completo mais recente, a carga avisa
  (`⚠️ o completo de … não foi carregado`) — rode `npm run bds` + `npm run load`.
- O diferencial **não** traz exclusões físicas (ex.: desinscrição); exclusões lógicas (`IsDeleted`,
  `DateDeleted`) chegam normalmente. O completo de segunda corrige o restante.
- Dataset novo no `bds-selecao.json`: inclua a chave dele em `config/bds-diferencial.json`, senão o
  diferencial dele não é aplicado (erro no log) e a tabela fica como no último completo.

---

### [4] Rodar downloads + carga MySQL agora

Executa os downloads e a carga manualmente, sem esperar o agendamento:

| Opção | Equivalente npm | O que faz |
|-------|----------------|-----------|
| [1] BDS completo + ADS + carga | `npm run pipeline` | Arquiva `csvs/` em `csvs/_anterior/` + BDS + ADS automáticos + carga MySQL + inventário |
| [2] Apenas BDS completo | `npm run bds` | Só baixa os BDS automáticos |
| [3] Apenas ADS | `npm run ads` | Só baixa os ADS marcados como automáticos |
| [4] BDS diferencial + ADS + carga | `npm run pipeline -- --diferencial` | Como [1], mas baixa o BDS diferencial do dia |
| [5] Apenas BDS diferencial | `npm run bds:diferencial` | Só baixa o diferencial do dia (aplicado no próximo `npm run load`) |
| [6] Apenas carga MySQL | `npm run load` | Carrega no MySQL os CSVs já baixados (`csvs/` + `csvs/diferencial/`) |

As etapas da execução completa também seguem `pipeline.baixar_bds` / `pipeline.baixar_ads` / `pipeline.carregar_mysql` em `config/schedule.json`.

**`csvs/_anterior/`:** no pipeline completo (`npm run pipeline`, opção [1] e o agendamento), o conteúdo atual de `csvs/` é movido para `csvs/_anterior/` **antes** dos downloads — nada é apagado, mas só a última execução fica guardada (o `_anterior` antigo é substituído). Assim, `csvs/` fica só com o que foi baixado na execução — um CSV baixado sob demanda semanas atrás não é recarregado toda noite. O loader e o inventário ignoram `csvs/_anterior/` e `csvs/zips/`; os diferenciais em `csvs/diferencial/` são aplicados pelo loader como upsert. Execuções parciais (`--apenas-*`) e downloads sob demanda pela CLI **não** mexem na pasta. No fim, o resumo lista os downloads que falharam mesmo após a nova tentativa e as tabelas do MySQL que **não** foram atualizadas nesta execução (o CSV delas não foi baixado).

**`csvs/manuais/` (CSVs que não vêm do AVA):** coloque o arquivo em `csvs/manuais/` (a pasta é criada na primeira execução completa; pode criá-la à mão). Ele **nunca** é arquivado e é recarregado (DROP/TRUNCATE + LOAD DATA) em toda carga — o agendamento e `npm run load`. Para carregar na hora: `npm run load`. A tabela recebe o nome do arquivo (ex.: `Metas_Cursos.csv` → `metas_cursos`), com todas as colunas TEXT; para tipos/índices, crie uma entrada em `config/schemas.json` com a chave = nome do arquivo sem `.csv`. Para atualizar os dados, substitua o arquivo; para parar de carregar, apague-o (a tabela continua no banco — apague-a no MySQL se quiser). Um manual com o mesmo nome de um CSV baixado é ignorado (com aviso), porque iria para a mesma tabela. Requisitos: cabeçalho na 1ª linha. Separador (`,` ou `;`) e codificação (UTF-8 ou ISO-8859-1/latin1, como os exports do sistema acadêmico) são detectados sozinhos — o log mostra `ℹ️ Formato detectado: separador ";", codificação latin1`. Datas `dd/mm/aaaa` e decimais com vírgula só são convertidos com `"formato": "br"` no schema (sem schema, tudo fica TEXT como veio).

Schemas prontos (`config/schemas.json`, `"formato": "br"`) para os exports do sistema acadêmico — o nome do arquivo precisa ser exatamente este:

| Arquivo em `csvs/manuais/` | Tabela |
|---|---|
| `DisciplinasPorAlunos.csv` | `disciplinas_por_alunos` |
| `ProvaveisFormandos.csv` | `provaveis_formandos` |
| `Financeiro.csv` | `financeiro` |
| `BolsasCadastradas.csv` | `bolsas_cadastradas` |
| `DadosPessoais.csv` | `dados_pessoais` |
| `CuboAcademico.csv` | `cubo_academico` |

Os tipos foram tirados dos arquivos de 19/11/2026. Se um export novo trouxer coluna a mais, ela aparece no log como `ℹ️ … fora do schema (não carregadas)`; coluna que sumiu, como `⚠️ … ficarão NULL` — ajuste o schema.

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
npm run pipeline    # Baixar agora BDS completo + ADS automáticos e carregar no MySQL
npm run bds         # Baixar apenas BDS (completo)
npm run bds:diferencial   # Baixar apenas o BDS diferencial do dia
npm run ads         # Baixar apenas ADS
npm run ads -- --inicio 2026-08-01   # ADS com outro startDate (só nesta execução)
npm run load        # Carregar no MySQL os CSVs já baixados
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
| `config/schedule.json` | Agendamentos (cron + BDS completo/diferencial + ADS) e chave geral das etapas |
| `config/schemas.json` | Schemas fixos das tabelas MySQL (tipos, nome da tabela, `aliases`, `indices`) |
| `config/bds-diferencial.json` | Chave de cada BDS para aplicar o diferencial (upsert) |

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

### Schemas fixos e aliases

O loader procura em `config/schemas.json` um schema para cada CSV pelo nome do arquivo (sem `.csv`). A comparação ignora acentos, maiúsculas/minúsculas, espaços, `_` e `-`, e também considera o campo opcional `aliases`:

```json
"Users": {
  "tabela": "users",
  "aliases": ["Usuários"],
  "colunas": { "UserId": "INT", "UserName": "VARCHAR(255)" },
  "indices": [["UserId"]]
}
```

Com schema, a tabela é recriada (DROP + CREATE) com os tipos do schema; colunas do CSV fora dele são ignoradas e colunas do schema ausentes no CSV ficam `NULL` (com aviso). `indices` cria índices depois da carga. Para corrigir um CSV que deveria ter schema, veja o nome real do arquivo em `csvs/` (ou no inventário) e adicione-o em `aliases`.

### CSVs sem schema fixo: todas as colunas `TEXT`

Quando um CSV não casa com nenhum schema, a tabela é criada com **todas as colunas `TEXT`**, e o log destaca:

```
🔍 Sem schema fixo para "<arquivo>" → tabela "<tabela>" carregada com todas as colunas TEXT
```

É o padrão seguro para dados ainda desconhecidos: a inferência pelo nome da coluna pode truncar dados sem erro (ex.: `ID definido da organização` contém texto, mas viraria `INT`). Para voltar à inferência, defina `INFERIR_TIPOS=true` no `.env`. Se a tabela já existir com outra estrutura, ela é recriada (`♻️` no log); com a mesma estrutura, só é truncada.

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
csvs/              ← CSVs da execução atual (BDS completo + ADS; os únicos carregados) e _bds_extracts.json
csvs/diferencial/  ← BDS diferencial do dia e _bds_extracts.json (aplicados como upsert)
csvs/_anterior/    ← CSVs da execução anterior (substituído a cada execução completa)
csvs/manuais/      ← CSVs colocados à mão (não vêm do AVA): nunca arquivados, recarregados em toda carga
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

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=dataUCB
DB_PASSWORD=sua_senha
DB_NAME=data_ucb

# Pastas
CSVS_DIR=./csvs
EXPORTS_DIR=./exports
LOGS_DIR=./logs

# Downloads BDS/ADS: total de tentativas (1 = sem nova tentativa) e espera entre elas
DOWNLOAD_TENTATIVAS=2
DOWNLOAD_ESPERA_SEGUNDOS=30

# Tabelas sem schema fixo: false (padrão) = todas TEXT; true = infere tipos pelo nome da coluna
INFERIR_TIPOS=false
```
