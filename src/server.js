require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const helmet = require("helmet");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const pgSession = require("connect-pg-simple")(session);

const config = require("./config/env");
const { pool, initSchema, healthCheck } = require("./db");
const { validateUserDirectory } = require("./config/users");

const inventoryRoutes = require("./routes/inventory");
const ticketRoutes = require("./routes/tickets");
const authRoutes = require("./routes/auth");
const approvalRoutes = require("./routes/approvals");
const myTicketsRoutes = require("./routes/myTickets");
const chatRoutes = require("./routes/chat");

const {
  requireAuthApi,
  requireAuthPage,
  requireInventoryAccessApi,
  requireInventoryAccessPage,
  requireApproverAccessApi,
  requireApproverAccessPage,
} = require("./middleware/requireAuth");
const { errorHandler, notFoundHandler, asyncHandler } = require("./middleware/errorHandler");
const { syncEmails } = require("./services/emailJiraSync");

const app = express();
const publicDir = path.join(__dirname, "public");

// Atrás de proxy (Render, Nginx, etc) o Express precisa confiar no
// X-Forwarded-Proto, senão cookies "secure" nunca são enviados.
if (config.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

// ---------- Segurança de cabeçalhos ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' é necessário porque as páginas usam <style> e
        // pequenos <script> inline. Se um dia extrairmos tudo para
        // arquivos externos, dá para remover e apertar mais.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ---------- CORS ----------
// Por padrão este app é same-origin (frontend e API no mesmo servidor),
// então NÃO habilitamos CORS. Refletir qualquer origem com credentials:true
// permitiria que qualquer site fizesse requisições autenticadas em nome
// do usuário logado. Só liberamos origens explicitamente listadas.
if (config.CORS_ORIGINS.length) {
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
    })
  );
}

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

// ---------- Sessão persistida no Postgres ----------
// Sem isso o Express usa MemoryStore: vaza memória, perde todas as sessões
// a cada restart/deploy (usuários deslogados) e não funciona com mais de
// uma instância do app.
app.use(
  session({
    name: "tempoassist.sid",
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // renova a validade a cada requisição ativa
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProduction, // exige HTTPS em produção
      maxAge: 1000 * 60 * 60 * config.SESSION_HOURS,
    },
  })
);

// ---------- Rate limiting ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 tentativas de login por IP a cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." },
  skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // uso normal fica bem abaixo disso
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Aguarde um momento." },
});

// ---------- Health check (público, usado por monitoramento) ----------
app.get(
  "/api/health",
  asyncHandler(async (req, res) => {
    const dbOk = await healthCheck();
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      database: dbOk ? "up" : "down",
      time: new Date().toISOString(),
    });
  })
);

// ---------- Autenticação (público) ----------
app.use("/api/login", loginLimiter);
app.use("/api", authRoutes);

// ---------- Páginas protegidas (antes dos arquivos estáticos) ----------
app.get("/", (req, res) => {
  if (req.session?.user) return res.redirect("/hub.html");
  return res.redirect("/login.html");
});

const sendPage = (file) => (req, res) => res.sendFile(path.join(publicDir, file));

app.get("/hub.html", requireAuthPage, sendPage("hub.html"));
app.get("/tickets.html", requireAuthPage, sendPage("tickets.html"));
app.get("/my-tickets.html", requireAuthPage, sendPage("my-tickets.html"));
app.get("/chat.html", requireAuthPage, sendPage("chat.html"));
app.get("/inventory.html", requireAuthPage, requireInventoryAccessPage, sendPage("inventory.html"));
app.get("/approvals.html", requireAuthPage, requireApproverAccessPage, sendPage("approvals.html"));

// Arquivos estáticos públicos (login.html, css, js). As páginas protegidas
// acima já foram interceptadas antes de chegar aqui.
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: config.isProduction ? "1h" : 0,
  })
);

// ---------- APIs protegidas ----------
// Cada área tem seu próprio prefixo: se todas ficassem em "/api" direto,
// o middleware de permissão de uma área rodaria também para outra
// (bug real que já corrigimos neste projeto).
app.use("/api/tickets", apiLimiter, requireAuthApi, ticketRoutes);
app.use("/api/inventory", apiLimiter, requireAuthApi, requireInventoryAccessApi, inventoryRoutes);
app.use("/api/approvals", apiLimiter, requireAuthApi, requireApproverAccessApi, approvalRoutes);
app.use("/api/my-tickets", apiLimiter, requireAuthApi, myTicketsRoutes);
app.use("/api/chat", apiLimiter, requireAuthApi, chatRoutes);

// ---------- Sincronização de e-mail (token de máquina, não sessão) ----------
function requireInternalToken(req, res, next) {
  const token = req.headers["x-internal-token"];
  if (!config.INTERNAL_API_TOKEN || token !== config.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

app.post(
  "/api/sync/emails",
  requireInternalToken,
  asyncHandler(async (req, res) => {
    const results = await syncEmails();
    res.json({ processed: results.length, results });
  })
);

// ---------- Tratamento de erros (sempre por último) ----------
app.use(notFoundHandler);
app.use(errorHandler);

// ---------- Agendador opcional ----------
if (config.ENABLE_EMAIL_SYNC) {
  cron.schedule(`*/${config.SYNC_INTERVAL_MINUTES} * * * *`, async () => {
    try {
      const results = await syncEmails();
      if (results.length) console.log(`[sync] ${results.length} e-mail(s) processado(s).`);
    } catch (err) {
      console.error("[sync] erro:", err.message);
    }
  });
}

// ---------- Inicialização ----------
let server;

// Valida usuários/gestores ANTES de abrir a porta: erro de configuração
// deve impedir a subida, não aparecer no primeiro login do usuário.
try {
  const total = validateUserDirectory();
  console.log(`Diretório de usuários carregado: ${total} conta(s).`);
} catch (err) {
  console.error("\n[ERRO DE CONFIGURAÇÃO] O sistema não pode iniciar:\n");
  console.error(`  - ${err.message}\n`);
  process.exit(1);
}

initSchema()
  .then(() => {
    server = app.listen(config.PORT, () => {
      console.log(`Tempo Assist Service Desk rodando na porta ${config.PORT}`);
      console.log(`Ambiente: ${config.isProduction ? "produção" : "desenvolvimento"}`);
      console.log(
        config.ENABLE_EMAIL_SYNC
          ? `Sincronização de e-mails ativa (a cada ${config.SYNC_INTERVAL_MINUTES} min).`
          : "Sincronização automática de e-mails desativada (ENABLE_EMAIL_SYNC=false)."
      );
    });
  })
  .catch((err) => {
    console.error("Erro ao conectar/preparar o banco de dados Postgres:", err.message);
    console.error("Confira se DATABASE_URL está correta no .env.");
    process.exit(1);
  });

// ---------- Encerramento gracioso ----------
// Sem isso, um deploy/restart corta requisições no meio e deixa conexões
// do Postgres penduradas.
async function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando com segurança...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end().catch(() => {});
  console.log("Encerrado.");
  process.exit(0);
}

["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => shutdown(sig)));

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

module.exports = app;
