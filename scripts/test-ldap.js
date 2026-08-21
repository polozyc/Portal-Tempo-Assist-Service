#!/usr/bin/env node
/**
 * Diagnóstico da integração com o Active Directory.
 *
 * Verifica, em ordem, cada etapa da autenticação — assim um problema de
 * rede não se confunde com senha errada ou grupo mal configurado.
 *
 * Uso:
 *   node scripts/test-ldap.js                      (testa só a conexão)
 *   node scripts/test-ldap.js usuario senha        (testa um login completo)
 */

require("dotenv").config();

const { validateLdapConfig, authenticateLdap, testLdapConnection } = require("../src/config/ldap");

const [, , usuario, senha] = process.argv;

function ok(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function falha(msg, detalhe) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detalhe) console.log(`    ${detalhe}`);
}

async function main() {
  console.log("\nDiagnóstico do Active Directory\n");

  // ---------- 1. Configuração ----------
  console.log("1) Configuração do .env");
  let cfg;
  try {
    cfg = validateLdapConfig();
    ok("todas as variáveis obrigatórias estão preenchidas");
    console.log(`    servidor......: ${cfg.url}`);
    console.log(`    base de busca.: ${cfg.baseDN}`);
    console.log(`    conta serviço.: ${cfg.bindDN}`);
    console.log(`    campo login...: ${cfg.loginAttribute}`);
  } catch (err) {
    falha("configuração incompleta", err.message);
    console.log("\nUse .env.ad.example como referência.\n");
    process.exit(1);
  }

  if ((process.env.AUTH_PROVIDER || "").toLowerCase() !== "ldap") {
    console.log(
      '\n  \x1b[33m!\x1b[0m AUTH_PROVIDER não está como "ldap". O sistema vai usar os usuários do .env.\n'
    );
  }

  // ---------- 2. Conexão e conta de serviço ----------
  console.log("\n2) Conexão com o servidor e conta de serviço");
  try {
    await testLdapConnection();
    ok("conectou e autenticou a conta de serviço");
  } catch (err) {
    falha("não foi possível conectar", err.message);
    console.log("\n  Verifique:");
    console.log("   - o servidor está acessível pela rede (firewall, porta 389/636)");
    console.log("   - LDAP_BIND_DN e LDAP_BIND_PASSWORD estão corretos");
    console.log("   - o DN da conta de serviço está completo\n");
    process.exit(1);
  }

  // ---------- 3. Login de um usuário ----------
  if (!usuario || !senha) {
    console.log(
      "\n  Para testar um login completo (busca, senha e grupos), rode:\n" +
        "    node scripts/test-ldap.js SEU_USUARIO SUA_SENHA\n"
    );
    return;
  }

  console.log(`\n3) Login de "${usuario}"`);
  try {
    const dados = await authenticateLdap(usuario, senha);

    if (!dados) {
      falha("usuário não encontrado ou senha inválida");
      console.log("\n  Verifique:");
      console.log(`   - o usuário existe dentro de ${cfg.baseDN}`);
      console.log(`   - LDAP_LOGIN_ATTRIBUTE (${cfg.loginAttribute}) é o campo certo`);
      console.log("     AD usa sAMAccountName; OpenLDAP costuma usar uid\n");
      process.exit(1);
    }

    ok("autenticado com sucesso");
    console.log(`    nome.........: ${dados.displayName}`);
    console.log(`    e-mail.......: ${dados.email || "(não informado)"}`);
    console.log(`    grupos.......: ${dados.groups.join(", ") || "(nenhum)"}`);

    console.log("\n4) Permissões resultantes");
    if (dados.inventoryAccess) {
      ok(`acessa o Inventário (grupo ${cfg.grupoInventario})`);
    } else {
      console.log(
        `  \x1b[33m!\x1b[0m sem acesso ao Inventário` +
          (cfg.grupoInventario
            ? ` — não pertence a "${cfg.grupoInventario}"`
            : " — LDAP_GROUP_INVENTORY não configurado")
      );
    }

    if (dados.roles.length) {
      ok(`papéis de aprovação: ${dados.roles.join(", ")}`);
    } else {
      console.log(
        "  \x1b[33m!\x1b[0m nenhum papel de aprovação — confira LDAP_GROUP_ROLES e os grupos acima"
      );
    }

    console.log("\nTudo certo. O sistema pode subir com AUTH_PROVIDER=ldap.\n");
  } catch (err) {
    falha("erro durante a autenticação", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nErro inesperado:", err.message, "\n");
  process.exit(1);
});
