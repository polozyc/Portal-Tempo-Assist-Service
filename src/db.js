const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL não configurada no .env. Configure a connection string do seu banco Postgres (ex: Supabase)."
  );
}

// Supabase (e a maioria dos provedores gratuitos de Postgres) exige SSL.
// rejectUnauthorized:false evita erro de certificado autoassinado/intermediário
// comum nesses provedores gratuitos.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  // Planos gratuitos costumam ter limite baixo de conexões simultâneas.
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Um erro em cliente ocioso não deve derrubar o processo inteiro.
pool.on("error", (err) => {
  console.error("[postgres] erro em conexão ociosa:", err.message);
});

/** Verifica se o banco responde — usado pelo /api/health. */
async function healthCheck() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    console.error("[postgres] health check falhou:", err.message);
    return false;
  }
}

async function initSchema() {
  await pool.query(`
    -- ---------- Estoque do laboratório ----------
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      barcode TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      serial_number TEXT,
      status TEXT NOT NULL DEFAULT 'IN_STOCK', -- IN_STOCK | CHECKED_OUT
      location TEXT,
      current_ticket TEXT,
      current_department TEXT,
      current_requester TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS movements (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      action TEXT NOT NULL, -- IN | OUT
      person TEXT,
      ticket_number TEXT,
      department TEXT,
      requester TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_movements_item_id ON movements(item_id);

    -- ---------- Automação de e-mail -> Jira ----------
    CREATE TABLE IF NOT EXISTS processed_emails (
      id SERIAL PRIMARY KEY,
      message_id TEXT UNIQUE NOT NULL,
      subject TEXT,
      sender_email TEXT,
      jira_issue_key TEXT,
      status TEXT NOT NULL DEFAULT 'OK',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ---------- Chamados abertos pelo sistema (com ou sem aprovação) ----------
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      requester_username TEXT NOT NULL,
      requester_name TEXT,
      requester_email TEXT NOT NULL,
      department TEXT,
      subject TEXT NOT NULL,
      description TEXT,
      requires_approval BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | SENT
      approver_username TEXT,
      decision_notes TEXT,
      jira_issue_key TEXT,
      jira_link TEXT,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_username);
    CREATE INDEX IF NOT EXISTS idx_tickets_approver ON tickets(approver_username, status);
  `);

  // Migrações incrementais: rodam sem erro em bancos que já existiam antes
  // dessas colunas. IF NOT EXISTS evita a necessidade de controle de versão
  // externo para este projeto (que tem schema pequeno e estável).
  await pool.query(`
    ALTER TABLE movements ADD COLUMN IF NOT EXISTS registered_by TEXT;
    ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS sync_error TEXT;
    -- Tipo de solicitação escolhido no formulário (Hardware, Sistemas, etc).
    -- Guardamos o nome junto do id para o histórico continuar legível mesmo
    -- se o tipo for renomeado ou removido no Jira depois.
    ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS request_type_id TEXT;
    ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS request_type_name TEXT;
    -- Regras de "de acordo" que dispararam para este chamado (ex:
    -- "Usuário - Criação"). Guardamos para auditoria: permite explicar
    -- depois por que aquele chamado exigiu aprovação.
    ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS approval_reason TEXT;
    -- Decisão completa do agente de IA (categoria, urgência, raciocínio).
    -- Guardar isso permite auditar POR QUE o agente decidiu daquele jeito —
    -- sem esse registro, a triagem automática vira uma caixa-preta.
    ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS agent_decision JSONB;
  `);
}

module.exports = { pool, initSchema, healthCheck };
