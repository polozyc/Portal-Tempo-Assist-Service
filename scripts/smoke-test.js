#!/usr/bin/env node
/**
 * Smoke test end-to-end.
 *
 * Sobe nada por conta própria: assume que o servidor já está rodando.
 * Valida os caminhos críticos — autenticação, isolamento de permissões,
 * inventário e fluxo de aprovação — para pegar regressões antes de subir
 * para produção.
 *
 * Uso:
 *   npm start                 (num terminal)
 *   npm run smoke-test        (noutro terminal)
 *
 * Variáveis opcionais:
 *   SMOKE_BASE_URL      (padrão http://localhost:3000)
 *   SMOKE_ADMIN_USER / SMOKE_ADMIN_PASS
 *   SMOKE_LIMITED_USER / SMOKE_LIMITED_PASS   usuário SEM acesso ao inventário
 */

require("dotenv").config();

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || process.env.MASTER_USERNAME;
const ADMIN_PASS = process.env.SMOKE_ADMIN_PASS || process.env.MASTER_PASSWORD;
const LIMITED_USER = process.env.SMOKE_LIMITED_USER;
const LIMITED_PASS = process.env.SMOKE_LIMITED_PASS;

let passed = 0;
let failed = 0;

function check(description, condition, detail = "") {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${description}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

/** fetch que guarda cookies de sessão por "usuário". */
function createSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        // Em produção o cookie de sessão é "secure" e só é emitido em
        // HTTPS. Ao testar localmente por HTTP, simulamos o cabeçalho que
        // um proxy (Render, Nginx) enviaria — senão o login "passa" mas
        // nenhuma sessão é criada e todo o resto falha com 401.
        ...(BASE.startsWith("http://") ? { "X-Forwarded-Proto": "https" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
}

async function main() {
  console.log(`\nSmoke test — ${BASE}\n`);

  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error("MASTER_USERNAME/MASTER_PASSWORD não configurados no .env. Abortando.");
    process.exit(1);
  }

  // ---------- Saúde ----------
  console.log("Saúde do serviço");
  const anon = createSession();
  const health = await anon("GET", "/api/health");
  check("GET /api/health responde 200", health.status === 200, `status ${health.status}`);
  check("banco de dados acessível", health.data?.database === "up", JSON.stringify(health.data));

  // ---------- Autenticação ----------
  console.log("\nAutenticação");
  const unauth = await anon("GET", "/api/my-tickets");
  check("API protegida rejeita anônimo (401)", unauth.status === 401, `status ${unauth.status}`);

  const badLogin = await anon("POST", "/api/login", {
    username: ADMIN_USER,
    password: "senha-obviamente-errada",
  });
  check("login com senha errada é rejeitado (401)", badLogin.status === 401, `status ${badLogin.status}`);
  check(
    "mensagem de erro não revela se o usuário existe",
    badLogin.data?.error === "Usuário ou senha inválidos.",
    badLogin.data?.error
  );

  const admin = createSession();
  const login = await admin("POST", "/api/login", { username: ADMIN_USER, password: ADMIN_PASS });
  check("login válido é aceito (200)", login.status === 200, `status ${login.status}`);
  check("sessão indica acesso ao inventário", login.data?.inventoryAccess === true);

  const me = await admin("GET", "/api/me");
  const sessaoOk = me.data?.authenticated === true;
  check("GET /api/me confirma autenticação", sessaoOk);

  if (!sessaoOk) {
    console.log(
      "\n  \x1b[33m!\x1b[0m O login respondeu 200 mas a sessão não persistiu.\n" +
        "    Causa provável: NODE_ENV=production emite cookie apenas por HTTPS.\n" +
        "    Ao testar em produção, aponte SMOKE_BASE_URL para a URL https:// real,\n" +
        "    ou rode com NODE_ENV=development localmente.\n" +
        "    Os testes seguintes vão falhar em cascata por causa disso.\n"
    );
  }

  // ---------- Validação de entrada ----------
  console.log("\nValidação de entrada");
  const badTicket = await admin("POST", "/api/tickets", { requesterEmail: "não-é-email", subject: "" });
  check("chamado com e-mail inválido é rejeitado (400)", badTicket.status === 400, `status ${badTicket.status}`);

  const badScan = await admin("POST", "/api/inventory/scan", { barcode: "X", action: "INVALIDO" });
  check("scan com ação inválida é rejeitado (400)", badScan.status === 400, `status ${badScan.status}`);

  // ---------- Inventário ----------
  console.log("\nInventário");
  const barcode = `SMOKE-${Date.now()}`;
  const created = await admin("POST", "/api/inventory/items", {
    barcode,
    name: "Item de smoke test",
    category: "teste",
  });
  check("cadastro de item (201)", created.status === 201, `status ${created.status}`);

  const duplicate = await admin("POST", "/api/inventory/items", { barcode, name: "Duplicado" });
  check("código de barras duplicado é recusado (409)", duplicate.status === 409, `status ${duplicate.status}`);

  const out = await admin("POST", "/api/inventory/scan", {
    barcode,
    action: "OUT",
    person: "Smoke Test",
    requester: "Smoke Test",
  });
  check("registro de saída (200)", out.status === 200, `status ${out.status}`);
  check("status do item vira CHECKED_OUT", out.data?.item?.status === "CHECKED_OUT");

  const outAgain = await admin("POST", "/api/inventory/scan", {
    barcode,
    action: "OUT",
    requester: "Smoke Test",
  });
  check("saída duplicada é bloqueada (409)", outAgain.status === 409, `status ${outAgain.status}`);

  const back = await admin("POST", "/api/inventory/scan", { barcode, action: "IN" });
  check("registro de entrada (200)", back.status === 200, `status ${back.status}`);
  check("status do item volta para IN_STOCK", back.data?.item?.status === "IN_STOCK");

  const movements = await admin("GET", "/api/inventory/movements");
  check(
    "histórico retorna o formato { movements, total }",
    Array.isArray(movements.data?.movements) && typeof movements.data?.total === "number",
    JSON.stringify(movements.data).slice(0, 120)
  );

  // ---------- Chamados ----------
  console.log("\nChamados");
  const departments = await admin("GET", "/api/tickets/departments");
  check("lista de setores disponível", Array.isArray(departments.data?.departments));

  const myTickets = await admin("GET", "/api/my-tickets");
  check("meus chamados retorna lista", Array.isArray(myTickets.data));

  const depList = departments.data?.departments || [];
  if (depList.length) {
    const pending = await admin("POST", "/api/tickets", {
      requesterEmail: "smoke@teste.local",
      requesterName: "Smoke Test",
      subject: `Chamado de smoke test ${Date.now()}`,
      description: "Criado automaticamente pelo smoke test.",
      department: depList[0],
      requiresApproval: true,
    });
    check("chamado com aprovação fica pendente (201)", pending.status === 201, `status ${pending.status}`);
    check("resposta indica pendência", pending.data?.pending === true);
  } else {
    console.log("  \x1b[33m!\x1b[0m nenhum setor configurado — pulando teste de aprovação");
  }

  const invalidDept = await admin("POST", "/api/tickets", {
    requesterEmail: "smoke@teste.local",
    subject: "Setor inexistente",
    department: "SetorQueNaoExiste",
    requiresApproval: true,
  });
  check("setor sem gestor é recusado (400)", invalidDept.status === 400, `status ${invalidDept.status}`);

  // ---------- Isolamento de permissões ----------
  console.log("\nIsolamento de permissões");
  if (LIMITED_USER && LIMITED_PASS) {
    const limited = createSession();
    const limitedLogin = await limited("POST", "/api/login", {
      username: LIMITED_USER,
      password: LIMITED_PASS,
    });
    check("login do usuário restrito funciona", limitedLogin.status === 200);
    check("usuário restrito NÃO tem acesso ao inventário", limitedLogin.data?.inventoryAccess === false);

    const blocked = await limited("GET", "/api/inventory/items");
    check("inventário bloqueado para usuário restrito (403)", blocked.status === 403, `status ${blocked.status}`);

    const ownTickets = await limited("GET", "/api/my-tickets");
    check("usuário restrito ainda acessa seus chamados (200)", ownTickets.status === 200);
  } else {
    console.log(
      "  \x1b[33m!\x1b[0m defina SMOKE_LIMITED_USER/SMOKE_LIMITED_PASS para testar o bloqueio de permissões"
    );
  }

  // ---------- Sessão ----------
  console.log("\nEncerramento de sessão");
  await admin("POST", "/api/logout");
  const afterLogout = await admin("GET", "/api/my-tickets");
  check("após logout a API rejeita (401)", afterLogout.status === 401, `status ${afterLogout.status}`);

  // ---------- Resultado ----------
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Passaram: ${passed}   Falharam: ${failed}`);
  console.log(`${"─".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nErro ao executar o smoke test:", err.message);
  console.error("O servidor está rodando? Confira SMOKE_BASE_URL.\n");
  process.exit(1);
});
