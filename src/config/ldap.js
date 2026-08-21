const { Client } = require("ldapts");

/**
 * Autenticação contra o Active Directory (ou qualquer servidor LDAP).
 *
 * ----- Como funciona -----
 * 1. Conecta com uma conta de serviço (somente leitura) e procura o
 *    usuário informado no diretório.
 * 2. Tenta um "bind" com o DN encontrado e a senha digitada. Se o bind
 *    passa, a senha está correta — quem valida é o próprio AD, então o
 *    sistema nunca armazena nem vê a senha real do usuário.
 * 3. Lê os grupos do usuário para definir as permissões.
 *
 * Fazemos a busca antes do bind porque o usuário digita algo curto
 * ("yan.coloda"), mas o AD exige o DN completo para autenticar.
 *
 * ----- Configuração (.env) -----
 *   AUTH_PROVIDER=ldap
 *   LDAP_URL=ldap://dc01.tempoassist.local:389
 *   LDAP_BASE_DN=OU=Usuarios,DC=tempoassist,DC=local
 *   LDAP_BIND_DN=CN=svc-servicedesk,OU=Usuarios,DC=tempoassist,DC=local
 *   LDAP_BIND_PASSWORD=...
 *   LDAP_LOGIN_ATTRIBUTE=sAMAccountName      (padrão do AD)
 *   LDAP_GROUP_INVENTORY=SD-Inventario
 *   LDAP_GROUP_ROLES=Gestor:SD-Gestores,Diretor TI:SD-DiretorTI
 */

const TIMEOUT_MS = 10000;

function ldapConfig() {
  return {
    url: process.env.LDAP_URL,
    baseDN: process.env.LDAP_BASE_DN,
    bindDN: process.env.LDAP_BIND_DN,
    bindPassword: process.env.LDAP_BIND_PASSWORD,
    // sAMAccountName é o campo de login do AD. Em OpenLDAP costuma ser "uid".
    loginAttribute: process.env.LDAP_LOGIN_ATTRIBUTE || "sAMAccountName",
    grupoInventario: process.env.LDAP_GROUP_INVENTORY || "",
    // "Gestor:SD-Gestores,Diretor TI:SD-DiretorTI"
    gruposPapeis: process.env.LDAP_GROUP_ROLES || "",
  };
}

function isLdapEnabled() {
  return (process.env.AUTH_PROVIDER || "").toLowerCase() === "ldap";
}

/** Valida a configuração na subida, para não falhar só no primeiro login. */
function validateLdapConfig() {
  const cfg = ldapConfig();
  const faltando = [];
  if (!cfg.url) faltando.push("LDAP_URL");
  if (!cfg.baseDN) faltando.push("LDAP_BASE_DN");
  if (!cfg.bindDN) faltando.push("LDAP_BIND_DN");
  if (!cfg.bindPassword) faltando.push("LDAP_BIND_PASSWORD");

  if (faltando.length) {
    throw new Error(
      `AUTH_PROVIDER=ldap exige as variáveis: ${faltando.join(", ")}.`
    );
  }
  return cfg;
}

function novoCliente(url) {
  const opcoes = {
    url,
    timeout: TIMEOUT_MS,
    connectTimeout: TIMEOUT_MS,
  };

  // tlsOptions só entra em ldaps://. Se enviado numa conexão ldap:// comum,
  // o cliente tenta negociar TLS numa porta que não fala TLS e a conexão cai.
  if (String(url).toLowerCase().startsWith("ldaps://")) {
    // Ambientes corporativos costumam usar certificado interno; a
    // verificação estrita fica opcional para não travar a implantação.
    opcoes.tlsOptions = {
      rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED === "true",
    };
  }

  return new Client(opcoes);
}

/** Escapa valores usados em filtros LDAP (evita injeção no filtro). */
function escapeFilter(valor) {
  return String(valor || "").replace(/[\\*()\0/]/g, (c) => {
    const mapa = { "\\": "\\5c", "*": "\\2a", "(": "\\28", ")": "\\29", "\0": "\\00", "/": "\\2f" };
    return mapa[c];
  });
}

/** Extrai o CN de um DN: "CN=SD-Gestores,OU=Grupos,..." -> "SD-Gestores" */
function cnDoDn(dn) {
  const m = String(dn).match(/^cn=([^,]+)/i);
  return m ? m[1].trim() : String(dn);
}

/** Mapa "Gestor:SD-Gestores,Diretor TI:SD-DiretorTI" -> [{papel, grupo}] */
function parseGruposPapeis(raw) {
  return String(raw || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf(":");
      if (i === -1) return null;
      return { papel: e.slice(0, i).trim(), grupo: e.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

/**
 * Autentica no AD e devolve os dados do usuário, ou null se as
 * credenciais forem inválidas.
 *
 * Lança erro apenas em falha de infraestrutura (servidor fora do ar,
 * conta de serviço inválida) — assim o login sabe diferenciar
 * "senha errada" de "AD indisponível".
 */
async function authenticateLdap(username, password) {
  const cfg = validateLdapConfig();

  // Senha vazia faria um "unauthenticated bind", que o LDAP aceita como
  // sucesso — e qualquer usuário entraria sem senha.
  if (!username || !password) return null;

  const cliente = novoCliente(cfg.url);

  try {
    await cliente.bind(cfg.bindDN, cfg.bindPassword);

    const filtro = `(&(objectClass=*)(${cfg.loginAttribute}=${escapeFilter(username)}))`;
    const { searchEntries } = await cliente.search(cfg.baseDN, {
      scope: "sub",
      filter: filtro,
      attributes: ["dn", "cn", "displayName", "mail", "memberOf", cfg.loginAttribute],
    });

    if (!searchEntries.length) {
      console.log(`[ldap] usuário "${username}" não encontrado no diretório.`);
      return null;
    }
    const entrada = searchEntries[0];

    // --- Valida a senha: quem decide é o AD ---
    const clienteUsuario = novoCliente(cfg.url);
    try {
      await clienteUsuario.bind(entrada.dn, password);
    } catch {
      console.log(`[ldap] senha inválida para "${username}".`);
      return null;
    } finally {
      await clienteUsuario.unbind().catch(() => {});
    }

    // --- Grupos ---
    // O AD entrega "memberOf" direto; OpenLDAP e alguns ambientes exigem
    // consultar os grupos pelo membro. Cobrimos os dois casos.
    let gruposDn = entrada.memberOf || [];
    if (typeof gruposDn === "string") gruposDn = [gruposDn];

    if (!gruposDn.length) {
      const raizGrupos = process.env.LDAP_GROUP_BASE_DN || cfg.baseDN;
      const { searchEntries: gruposEntries } = await cliente.search(raizGrupos, {
        scope: "sub",
        filter: `(|(member=${escapeFilter(entrada.dn)})(uniqueMember=${escapeFilter(entrada.dn)}))`,
        attributes: ["dn", "cn"],
      });
      gruposDn = gruposEntries.map((g) => g.dn);
    }

    const grupos = gruposDn.map(cnDoDn);

    const inventoryAccess = cfg.grupoInventario
      ? grupos.some((g) => g.toLowerCase() === cfg.grupoInventario.toLowerCase())
      : false;

    const papeis = parseGruposPapeis(cfg.gruposPapeis)
      .filter(({ grupo }) => grupos.some((g) => g.toLowerCase() === grupo.toLowerCase()))
      .map(({ papel }) => papel);

    console.log(
      `[ldap] "${username}" autenticado. Grupos: [${grupos.join(", ")}]. ` +
        `Inventário: ${inventoryAccess}. Papéis: [${papeis.join(", ")}]`
    );

    return {
      username: String(entrada[cfg.loginAttribute] || entrada.cn || username),
      displayName: String(entrada.displayName || entrada.cn || username),
      email: entrada.mail ? String(entrada.mail) : null,
      inventoryAccess,
      roles: papeis,
      groups: grupos,
    };
  } finally {
    await cliente.unbind().catch(() => {});
  }
}

/** Testa a conexão e a conta de serviço — usado na subida do sistema. */
async function testLdapConnection() {
  const cfg = validateLdapConfig();
  const cliente = novoCliente(cfg.url);
  try {
    await cliente.bind(cfg.bindDN, cfg.bindPassword);
    return true;
  } finally {
    await cliente.unbind().catch(() => {});
  }
}

module.exports = { authenticateLdap, isLdapEnabled, validateLdapConfig, testLdapConnection };
