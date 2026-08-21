# Tempo Assist — Service Desk

Sistema com duas partes:

1. **Automação Outlook → Jira**: lê os e-mails não lidos da caixa geral do service desk e
   cria automaticamente uma solicitação no Jira Service Management, usando o e-mail de
   quem escreveu como solicitante (o Jira cria o cliente sozinho se ele ainda não existir).
2. **Estoque do laboratório**: cadastro de equipamentos por código de barras e registro de
   entrada/saída usando um leitor de código de barras USB comum (ele funciona como um
   teclado — não precisa de driver especial).

---

## 1. Rodando localmente

```bash
npm install
cp .env.example .env    # preencha as variáveis, ver seção 2 e 3
npm start
```

Acesse `http://localhost:3000` para a tela de estoque.

---

## 2. Configurar a leitura do e-mail (Microsoft Graph)

O acesso ao Graph é **gratuito** — não tem custo além da licença do Microsoft 365 que
vocês já têm. Passos no [Azure Portal](https://portal.azure.com):

1. **Azure Active Directory → App registrations → New registration**
   - Nome: `tempo-assist-servicedesk-sync`
   - Deixe o resto padrão e registre.
2. Copie o **Application (client) ID** e o **Directory (tenant) ID** → vão em
   `MS_CLIENT_ID` e `MS_TENANT_ID` no `.env`.
3. **Certificates & secrets → New client secret** → copie o valor gerado →
   `MS_CLIENT_SECRET` (esse valor só aparece uma vez, salve com cuidado).
4. **API permissions → Add a permission → Microsoft Graph → Application permissions**
   → adicione `Mail.Read` (e `Mail.ReadWrite` se quiser que o próprio app marque
   os e-mails como lidos, que é o comportamento atual do código).
5. Clique em **Grant admin consent** (precisa de um admin do Microsoft 365 para isso).
6. Preencha `MS_MAILBOX` com o e-mail da caixa geral do service desk
   (ex: `servicedesk@tempoassist.com.br`).

> Sem o "Grant admin consent" as chamadas à API vão retornar erro 403.

---

## 3. Configurar o Jira Service Management

1. Confirme que a fila do service desk é um projeto do tipo **Jira Service Management**
   (não Jira Software comum) — só assim o campo `raiseOnBehalfOf` funciona e cria o
   cliente automaticamente a partir do e-mail.
2. Crie um token de API em `https://id.atlassian.com/manage-profile/security/api-tokens`
   → `JIRA_API_TOKEN`. Use o e-mail dessa conta em `JIRA_EMAIL`.
   - Recomendo criar uma conta de serviço (ex: `integracao@tempoassist.com.br`) com
     permissão de "Agente" no service desk, em vez de usar o e-mail de uma pessoa.
3. Descubra o `serviceDeskId` e `requestTypeId`:
   ```bash
   curl -u seu-email@empresa.com:SEU_TOKEN \
     https://SEUDOMINIO.atlassian.net/rest/servicedeskapi/servicedesk
   ```
   Pegue o `id` do desk desejado, depois:
   ```bash
   curl -u seu-email@empresa.com:SEU_TOKEN \
     https://SEUDOMINIO.atlassian.net/rest/servicedeskapi/servicedesk/{id}/requesttype
   ```
   Pegue o `id` do tipo de solicitação que os chamados por e-mail devem usar
   (ex: "Chamado geral" / "Suporte via e-mail").
4. Preencha `JIRA_BASE_URL`, `JIRA_SERVICE_DESK_ID`, `JIRA_REQUEST_TYPE_ID` no `.env`.

**Se o projeto for Jira comum (não JSM)**: o campo `reporter` só pode ser setado para um
e-mail que já tenha conta no Jira — não dá para usar o e-mail de qualquer pessoa externa
diretamente. Nesse caso me avise que ajusto o `jiraClient.js` para: criar o chamado com um
usuário de integração como reporter e colocar "Solicitante: fulano@empresa.com" no título
ou em um campo customizado, além de comentar o e-mail original na issue.

---

## 4. Banco de dados (Postgres)

O sistema usa **Postgres** (não SQLite) — ou seja, o banco não fica preso no disco do
servidor, funciona igual local ou hospedado na nuvem.

**Para criar um banco gratuito (Supabase):**
1. Crie uma conta em [supabase.com](https://supabase.com) e um novo projeto (grátis).
2. Vá em **Project Settings → Database → Connection string**, escolha o modo **URI**.
3. Cole essa URL em `DATABASE_URL` no `.env`.
4. Deixe `DATABASE_SSL=true` (padrão do Supabase).

O sistema cria as tabelas sozinho na primeira vez que sobe (não precisa rodar migração
manual).

## 5. Deploy gratuito

O app precisa ficar rodando continuamente (por causa do agendador que verifica e-mails
a cada alguns minutos), então serverless "puro" (Vercel functions, por ex.) não serve bem.

### Render.com (recomendado)
1. Suba este projeto num repositório do GitHub.
2. No Render: **New → Web Service** → conecte o repositório.
   - Build command: `npm install`
   - Start command: `npm start`
   - Plano: **Free**
3. Adicione todas as variáveis do `.env` em **Environment** (incluindo `DATABASE_URL`
   do Supabase).
4. O plano free do Render "dorme" após ~15 min sem tráfego. Para evitar isso, cadastre
   a URL `https://SEU-APP.onrender.com/api/health` em um serviço gratuito de ping, tipo
   [cron-job.org](https://cron-job.org) ou [UptimeRobot](https://uptimerobot.com),
   rodando a cada 5–10 minutos.
5. Como o banco agora é externo (Supabase), o "sono" do Render ou um redeploy **não
   apaga mais nada** — só reinicia o servidor, os dados continuam no Postgres.

---

## 6. Estrutura do projeto

```
src/
  server.js              # app Express + agendador (node-cron)
  db.js                  # conexão Postgres + criação do schema (tabelas)
  routes/
    inventory.js         # API do estoque (/api/inventory/items, /scan, /movements)
    tickets.js            # abertura de chamados (/api/tickets)
    approvals.js           # aprovação de chamados pelo gestor (/api/approvals)
    myTickets.js            # chamados do próprio usuário (/api/my-tickets)
  services/
    graphClient.js        # autenticação e leitura de e-mails via Microsoft Graph
    jiraClient.js          # criação de chamado no Jira Service Management
    emailJiraSync.js       # orquestra: lê e-mail -> cria chamado -> marca como lido
  public/                 # frontend do estoque (HTML/CSS/JS puro, sem build)
```

## 6. Testando a sincronização manualmente

Com o servidor rodando:
```bash
curl -X POST http://localhost:3000/api/sync/emails \
  -H "x-internal-token: SEU_INTERNAL_API_TOKEN"
```
