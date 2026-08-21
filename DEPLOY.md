# Publicar para teste

Guia para colocar o sistema no ar e testar com outras pessoas.

---

## Custo: zero

| Serviço | Plano | Cartão de crédito | Limites relevantes |
|---|---|---|---|
| Render | Free | Não pede | 750 h/mês, adormece após 15 min |
| Supabase | Free | Não pede | 500 MB de banco, pausa após 7 dias parado |
| UptimeRobot / cron-job.org | Free | Não pede | Ping periódico |

Nenhum deles cobra nem pede cartão. Para um service desk interno com
algumas dezenas de pessoas, esses limites são folgados — 500 MB de banco
comportam centenas de milhares de chamados e movimentações.

> Evite o Postgres do próprio Render: no plano gratuito ele **expira em
> 90 dias**. O do Supabase não tem prazo de validade.

---

## Por que não GitHub Pages

O GitHub Pages serve apenas arquivos estáticos — ele não executa Node.js.
Este sistema precisa de um servidor rodando para manter a sessão de login,
falar com o Postgres e chamar a API do Jira com o token protegido.

Num site estático, o token do Jira ficaria visível para qualquer visitante,
e o login não teria como ser validado.

**O repositório no GitHub continua sendo necessário** — o Render instala
direto dele. É o Pages, especificamente, que não serve para este caso.

---

## Passo 1 — Banco de dados

Se ainda não tiver, crie um Postgres gratuito no [Supabase](https://supabase.com):

1. New Project → escolha a região mais próxima → defina a senha do banco
2. Connect → **Direct Connection string** → modo **Session pooler**
3. Troque `[YOUR-PASSWORD]` pela senha que você definiu

Guarde essa URL: é o `DATABASE_URL`.

> Use senha só com letras e números. Caracteres como `@` e `#` quebram a
> URL de conexão e precisam ser escapados.

---

## Passo 2 — Gerar as senhas dos usuários

Em produção o sistema **recusa iniciar** com senha em texto puro. Gere um
hash para cada pessoa:

```bash
npm run hash-password -- "SenhaDaPessoa"
```

Anote os hashes: eles vão nas variáveis `MASTER_PASSWORD` e `EXTRA_USERS`.

---

## Passo 3 — Subir para o GitHub

```bash
git init
git add .
git commit -m "Service Desk Tempo Assist"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/tempo-assist-servicedesk.git
git push -u origin main
```

Crie o repositório como **privado**.

**Antes de subir**, confirme que o `.env` não está sendo enviado:

```bash
git status --porcelain | grep "\.env$"
```

Se esse comando imprimir alguma coisa, **pare**: o `.env` tem seus tokens e
não pode ir para o Git. O `.gitignore` já cobre isso, então o normal é não
imprimir nada.

---

## Passo 4 — Publicar no Render

1. Acesse [render.com](https://render.com) e conecte sua conta do GitHub
2. **New → Blueprint** e escolha o repositório
   (o arquivo `render.yaml` já traz a configuração pronta)
3. O Render vai pedir as variáveis que não ficam no Git. Preencha:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a URL do Supabase (passo 1) |
| `MASTER_USERNAME` | login do administrador |
| `MASTER_PASSWORD` | hash gerado no passo 2 |
| `EXTRA_USERS` | `joao:HASH:false,maria:HASH:true` |
| `DEPARTMENT_APPROVERS` | `Financeiro:maria,TI:joao` |
| `APPROVAL_ROLES` | `Gestor:maria\|joao,Diretor TI:admin` |
| `JIRA_BASE_URL` | `https://SEUDOMINIO.atlassian.net` |
| `JIRA_EMAIL` | e-mail da conta Atlassian |
| `JIRA_API_TOKEN` | token do Jira |
| `JIRA_SERVICE_DESK_ID` | ex: `2` |
| `JIRA_REQUEST_TYPE_ID` | ex: `15` |

4. Clique em **Apply** e acompanhe os *Logs*

O sistema cria as tabelas sozinho na primeira subida. Se algo estiver
errado na configuração, ele recusa iniciar e diz exatamente o quê.

---

## Passo 5 — Evitar a hibernação (importante)

Os dois serviços gratuitos adormecem por inatividade, cada um com seu prazo:

| Serviço | Adormece após | Efeito |
|---|---|---|
| Render (aplicação) | 15 minutos | Primeira visita demora 30–60s |
| Supabase (banco) | 7 dias sem consultas | Projeto fica **offline** até ser religado no painel |

O segundo é mais sério: se o sistema ficar uma semana parado — férias
coletivas, recesso — o banco pausa e alguém precisa reativá-lo manualmente.

**Um único ping resolve os dois.** Cadastre este endereço no
[cron-job.org](https://cron-job.org) ou [UptimeRobot](https://uptimerobot.com),
a cada 10 minutos:

```
https://SEU-APP.onrender.com/api/health
```

Funciona porque `/api/health` executa uma consulta real no Postgres
(`SELECT 1`) para confirmar que o banco responde. Ou seja, o mesmo ping
mantém a aplicação acordada **e** zera o contador de inatividade do
Supabase — que conta consultas ao banco, não acessos ao painel.

Os dados nunca se perdem em nenhum dos casos: hibernar é diferente de apagar.

---

## Passo 6 — Validar

```bash
SMOKE_BASE_URL=https://SEU-APP.onrender.com \
SMOKE_ADMIN_USER=admin SMOKE_ADMIN_PASS=SuaSenha \
npm run smoke-test
```

São 28 verificações automáticas: login, permissões, inventário, chamados e
aprovações. Se alguma falhar, o script diz qual.

---

## Depois: mudar para o Active Directory

O Render é nuvem e não alcança o AD da empresa. Quando for migrar para
login corporativo, o sistema precisa rodar **dentro da rede interna** —
um servidor Windows ou VM.

O código já suporta os dois modos. Use o `.env.ad.example` como base e
valide a conexão antes de subir:

```bash
npm run test-ldap -- usuario senha
```
