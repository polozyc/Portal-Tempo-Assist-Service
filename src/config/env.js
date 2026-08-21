/**
 * Carrega e valida a configuração do ambiente UMA vez, na inicialização.
 *
 * Por que isso importa: sem essa validação, uma variável faltando só
 * estoura em produção no meio de uma requisição do usuário (ou pior,
 * silenciosamente usa um valor padrão inseguro). Aqui o app se recusa
 * a subir com configuração inválida, que é o comportamento correto.
 */

const isProduction = process.env.NODE_ENV === "production";

const errors = [];
const warnings = [];

function required(name, { onlyInProduction = false } = {}) {
  const value = process.env[name];
  if (!value) {
    if (onlyInProduction && !isProduction) {
      warnings.push(`${name} não definida (obrigatória em produção).`);
      return null;
    }
    errors.push(`${name} é obrigatória e não está definida.`);
    return null;
  }
  return value;
}

// ---------- Banco ----------
const DATABASE_URL = required("DATABASE_URL");

// ---------- Sessão ----------
const SESSION_SECRET = process.env.SESSION_SECRET;
const INSECURE_SECRETS = [
  "troque-este-segredo-em-producao",
  "troque-por-uma-string-aleatoria-longa",
];

if (!SESSION_SECRET) {
  if (isProduction) {
    errors.push("SESSION_SECRET é obrigatória em produção.");
  } else {
    warnings.push("SESSION_SECRET não definida — usando valor temporário de desenvolvimento.");
  }
} else if (INSECURE_SECRETS.includes(SESSION_SECRET)) {
  const msg = "SESSION_SECRET ainda é o valor de exemplo. Gere um segredo aleatório real.";
  isProduction ? errors.push(msg) : warnings.push(msg);
} else if (SESSION_SECRET.length < 32) {
  const msg = "SESSION_SECRET é curta demais (use pelo menos 32 caracteres aleatórios).";
  isProduction ? errors.push(msg) : warnings.push(msg);
}

// ---------- Jira ----------
const jiraVars = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_SERVICE_DESK_ID",
  "JIRA_REQUEST_TYPE_ID",
];
const missingJira = jiraVars.filter((v) => !process.env[v]);
if (missingJira.length) {
  warnings.push(
    `Configuração do Jira incompleta (${missingJira.join(", ")}). ` +
      `A abertura de chamados vai falhar até isso ser preenchido.`
  );
}

// ---------- Token interno ----------
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (INTERNAL_API_TOKEN === "troque-isto-por-um-token-forte") {
  const msg = "INTERNAL_API_TOKEN ainda é o valor de exemplo.";
  isProduction ? errors.push(msg) : warnings.push(msg);
}

// ---------- Usuários / autenticação ----------
// AUTH_PROVIDER define de onde vêm as contas:
//   local (padrão) -> usuários do .env, para desenvolvimento e testes
//   ldap           -> Active Directory da empresa
const authProvider = (process.env.AUTH_PROVIDER || "local").toLowerCase();

if (!["local", "ldap"].includes(authProvider)) {
  errors.push('AUTH_PROVIDER deve ser "local" ou "ldap".');
}

if (authProvider === "ldap") {
  // No modo AD as contas vivem no diretório; exigir MASTER_* aqui seria
  // pedir uma conta que o sistema nem vai usar.
  const faltando = ["LDAP_URL", "LDAP_BASE_DN", "LDAP_BIND_DN", "LDAP_BIND_PASSWORD"].filter(
    (v) => !process.env[v]
  );
  if (faltando.length) {
    errors.push(`AUTH_PROVIDER=ldap exige: ${faltando.join(", ")}.`);
  }
} else if (!process.env.MASTER_USERNAME || !process.env.MASTER_PASSWORD) {
  errors.push("MASTER_USERNAME e MASTER_PASSWORD são obrigatórios (conta administradora).");
}

// ---------- CORS ----------
// Lista de origens externas autorizadas. Vazio = apenas mesma origem,
// que é o padrão correto para este app (frontend e API no mesmo servidor).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (errors.length) {
  console.error("\n[ERRO DE CONFIGURAÇÃO] O sistema não pode iniciar:\n");
  errors.forEach((e) => console.error(`  - ${e}`));
  console.error("\nCorrija o arquivo .env (use .env.example como referência).\n");
  process.exit(1);
}

if (warnings.length) {
  console.warn("\n[AVISOS DE CONFIGURAÇÃO]");
  warnings.forEach((w) => console.warn(`  - ${w}`));
  console.warn("");
}

module.exports = {
  isProduction,
  PORT: Number(process.env.PORT || 3000),
  DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL !== "false",
  SESSION_SECRET: SESSION_SECRET || "dev-only-secret-nao-use-em-producao",
  SESSION_HOURS: Number(process.env.SESSION_HOURS || 8),
  INTERNAL_API_TOKEN,
  CORS_ORIGINS,
  ENABLE_EMAIL_SYNC: process.env.ENABLE_EMAIL_SYNC === "true",
  SYNC_INTERVAL_MINUTES: Number(process.env.SYNC_INTERVAL_MINUTES || 5),
  // Em desenvolvimento não há proxy na frente: manter "trust proxy" ligado
  // faz o Express não resolver req.ip e o rate-limit reclama de IP indefinido.
  // Por isso o padrão só é "true" em produção (Render, Nginx e afins).
  AUTH_PROVIDER: authProvider,
  TRUST_PROXY:
    process.env.TRUST_PROXY !== undefined
      ? process.env.TRUST_PROXY === "true"
      : process.env.NODE_ENV === "production",
};
