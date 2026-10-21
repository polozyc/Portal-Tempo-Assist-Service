require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
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

// Valida configuração de usuários ao carregar o módulo
try {
  validateUserDirectory();
} catch (err) {
  console.error("[ERRO DE CONFIGURAÇÃO]", err.message);
}

// Inicializa o schema do banco lazy (uma vez, na primeira requisição)
let schemaReady = false;
let schemaInit = null;
async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaInit) {
    schemaInit = initSchema().then(() => { schemaReady = true; });
  }
  await schemaInit;
}

const app = express();
const publicDir = path.join(__dirname, "public");

if (config.TRUST_PROXY) {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
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

if (config.CORS_ORIGINS.length) {
  app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
}

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

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
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProduction,
      maxAge: 1000 * 60 * 60 * config.SESSION_HOURS,
    },
  })
);

// Garante schema do banco antes de qualquer rota
app.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error("[db] erro ao inicializar schema:", err.message);
    res.status(503).json({ error: "Banco de dados indisponível." });
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." },
  skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Aguarde um momento." },
});

// Health check
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

app.use("/api/login", loginLimiter);
app.use("/api", authRoutes);

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

app.use(
  express.static(publicDir, {
    index: false,
    maxAge: config.isProduction ? "1h" : 0,
  })
);

app.use("/api/tickets", apiLimiter, requireAuthApi, ticketRoutes);
app.use("/api/inventory", apiLimiter, requireAuthApi, requireInventoryAccessApi, inventoryRoutes);
app.use("/api/approvals", apiLimiter, requireAuthApi, requireApproverAccessApi, approvalRoutes);
app.use("/api/my-tickets", apiLimiter, requireAuthApi, myTicketsRoutes);
app.use("/api/chat", apiLimiter, requireAuthApi, chatRoutes);

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

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
