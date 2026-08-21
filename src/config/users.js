const bcrypt = require("bcryptjs");
const { authenticateLdap, isLdapEnabled, validateLdapConfig } = require("./ldap");

/**
 * Diretório de usuários para login.
 *
 * Hoje isso é montado a partir do .env (sem depender do Active Directory
 * ainda). Quando integrar com o AD da empresa, troque a função
 * `findUser` para consultar o AD/LDAP — o resto do sistema (sessão,
 * middlewares de acesso) não precisa mudar.
 *
 * SENHAS:
 * Em produção use SEMPRE hashes bcrypt (começam com "$2a$", "$2b$" ou "$2y$").
 * Gere com:  npm run hash-password -- "suaSenhaAqui"
 *
 * Senhas em texto puro ainda funcionam (para não travar ambiente de teste),
 * mas o sistema emite um aviso no console e RECUSA subir em produção
 * (NODE_ENV=production) com senhas em texto puro.
 *
 * Configuração no .env:
 *   MASTER_USERNAME / MASTER_PASSWORD  -> conta com acesso total
 *   EXTRA_USERS="usuario:senhaOuHash:acessoInventario,..."
 *
 * ATENÇÃO: hashes bcrypt contêm ":" ? Não — bcrypt usa "$" e "/", nunca ":".
 * Por isso o split(":") é seguro. Mas para evitar ambiguidade, o parser abaixo
 * usa apenas o PRIMEIRO e o ÚLTIMO separador, permitindo senhas com ":".
 */

const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];

function isHashed(password) {
  return BCRYPT_PREFIXES.some((p) => String(password).startsWith(p));
}

let warnedPlaintext = false;

function warnIfPlaintext(users) {
  const plaintextUsers = Object.values(users)
    .filter((u) => !isHashed(u.password))
    .map((u) => u.username);

  if (!plaintextUsers.length) return;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `Senhas em texto puro não são permitidas em produção. Usuários afetados: ${plaintextUsers.join(", ")}. ` +
        `Gere hashes com: npm run hash-password -- "suaSenha"`
    );
  }

  if (!warnedPlaintext) {
    console.warn(
      `[AVISO DE SEGURANÇA] Senhas em texto puro detectadas para: ${plaintextUsers.join(", ")}.\n` +
        `  Isso é aceitável apenas em desenvolvimento. Antes de ir para produção, gere hashes com:\n` +
        `  npm run hash-password -- "suaSenha"`
    );
    warnedPlaintext = true;
  }
}

/**
 * Faz o parse de "usuario:senha:flag" tolerando ":" dentro da senha,
 * usando o primeiro e o último separador como delimitadores.
 */
function parseUserEntry(entry) {
  const first = entry.indexOf(":");
  const last = entry.lastIndexOf(":");
  if (first === -1 || first === last) return null;

  return {
    username: entry.slice(0, first).trim(),
    password: entry.slice(first + 1, last),
    inventoryAccess: entry.slice(last + 1).trim().toLowerCase() === "true",
  };
}

function buildUserDirectory() {
  const users = {};

  const masterUser = process.env.MASTER_USERNAME;
  const masterPass = process.env.MASTER_PASSWORD;
  if (masterUser && masterPass) {
    users[masterUser] = {
      username: masterUser,
      password: masterPass,
      inventoryAccess: true,
    };
  }

  (process.env.EXTRA_USERS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const parsed = parseUserEntry(entry);
      if (!parsed || !parsed.username || !parsed.password) return;
      users[parsed.username] = parsed;
    });

  warnIfPlaintext(users);
  return users;
}

/**
 * Valida credenciais no modo escolhido em AUTH_PROVIDER.
 *
 *   local (padrão) -> usuários do .env; usado para desenvolvimento e testes
 *   ldap           -> Active Directory da empresa
 *
 * Os dois modos devolvem o mesmo formato, então o restante do sistema
 * (sessão, permissões, telas) não muda ao alternar entre eles.
 */
async function findUser(username, password) {
  if (isLdapEnabled()) {
    return findUserLdap(username, password);
  }
  return findUserLocal(username, password);
}

/**
 * Modo LDAP/AD. As permissões vêm dos grupos do diretório, e não do .env:
 * quem administra o AD controla quem acessa o quê, sem mexer no sistema.
 */
async function findUserLdap(username, password) {
  const usuario = await authenticateLdap(username, password);
  if (!usuario) return null;

  return {
    username: usuario.username,
    displayName: usuario.displayName,
    email: usuario.email,
    inventoryAccess: usuario.inventoryAccess,
    ldapRoles: usuario.roles,
  };
}

/**
 * Modo local. Usa comparação bcrypt quando a senha configurada é um hash;
 * caso contrário compara em tempo constante para reduzir a chance de
 * timing attack.
 */
function findUserLocal(username, password) {
  if (!username || !password) return null;

  const users = buildUserDirectory();
  const user = users[username];

  // Sempre roda uma comparação (mesmo com usuário inexistente) para que o
  // tempo de resposta não revele se o usuário existe.
  const stored = user ? user.password : "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduO";

  let matches = false;
  if (isHashed(stored)) {
    matches = bcrypt.compareSync(password, stored);
  } else {
    matches = timingSafeEqualStr(password, stored);
  }

  if (user && matches) {
    return { username: user.username, inventoryAccess: user.inventoryAccess };
  }
  return null;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return require("crypto").timingSafeEqual(bufA, bufB);
}

function listUsernames() {
  return Object.keys(buildUserDirectory());
}

/**
 * Valida o diretório de usuários na INICIALIZAÇÃO.
 *
 * Sem isso, o erro de "senha em texto puro em produção" só apareceria no
 * primeiro login — o deploy pareceria bem-sucedido e todo login retornaria
 * 500. Falhar cedo, na subida, é o comportamento correto.
 */
function validateUserDirectory() {
  // No modo LDAP os usuários vivem no Active Directory — não faz sentido
  // exigir contas no .env nem checar senhas em texto puro.
  if (isLdapEnabled()) {
    validateLdapConfig(); // lança se faltar alguma variável do LDAP
    console.log("Autenticação: Active Directory (LDAP).");
    return 0;
  }

  const users = buildUserDirectory(); // lança em produção se houver texto puro

  if (!Object.keys(users).length) {
    throw new Error(
      "Nenhum usuário configurado. Defina MASTER_USERNAME e MASTER_PASSWORD no .env."
    );
  }

  // Avisa sobre gestores mapeados que não existem no diretório — senão o
  // chamado fica pendente para alguém que nunca conseguirá aprová-lo.
  const { listDepartments, getApproverForDepartment } = require("./approvers");
  const orfaos = listDepartments()
    .map((dep) => ({ dep, approver: getApproverForDepartment(dep) }))
    .filter(({ approver }) => approver && !users[approver]);

  if (orfaos.length) {
    console.warn(
      `[AVISO] Setores com gestor inexistente em EXTRA_USERS/MASTER_USERNAME: ` +
        orfaos.map(({ dep, approver }) => `${dep} -> "${approver}"`).join(", ") +
        `. Chamados desses setores ficariam pendentes sem ninguém para aprovar.`
    );
  }

  return Object.keys(users).length;
}

module.exports = { findUser, listUsernames, validateUserDirectory };
