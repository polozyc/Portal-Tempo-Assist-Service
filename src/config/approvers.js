/**
 * Mapeia cada setor ao usuário (gestor) responsável por aprovar
 * chamados desse setor. Configurado via .env:
 *
 *   DEPARTMENT_APPROVERS="Financeiro:maria,TI:joao"
 *
 * O "usuario" referenciado aqui precisa ser um username válido do
 * diretório em src/config/users.js (é ele quem vai logar e aprovar).
 *
 * A busca é case-insensitive (o usuário pode digitar "financeiro" ou
 * "Financeiro" no formulário), mas guardamos a grafia original para
 * exibir corretamente na interface.
 */
function buildApproverMap() {
  const raw = process.env.DEPARTMENT_APPROVERS || "";
  const map = new Map();

  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) return;

      const department = entry.slice(0, separator).trim();
      const username = entry.slice(separator + 1).trim();
      if (!department || !username) return;

      map.set(department.toLowerCase(), { department, username });
    });

  return map;
}

/** Retorna o username do gestor responsável pelo setor, ou null. */
function getApproverForDepartment(department) {
  const entry = buildApproverMap().get(String(department || "").trim().toLowerCase());
  return entry ? entry.username : null;
}

/**
 * Indica se o usuário pode aprovar algo — seja por ser gestor de um setor
 * (DEPARTMENT_APPROVERS) ou por exercer um papel (APPROVAL_ROLES).
 *
 * Precisa cobrir os dois casos: sem isso, um "Diretor TI" que só aprova
 * por papel não conseguiria abrir a tela de Aprovações.
 */
function isApproverUsername(username) {
  if (!username) return false;

  const porSetor = [...buildApproverMap().values()].some((e) => e.username === username);
  if (porSetor) return true;

  return [...buildRoleMap().values()].some((e) => e.usuarios.includes(username));
}

/** Lista os setores (com a grafia original) que este gestor aprova. */
function departmentsForApprover(username) {
  return [...buildApproverMap().values()]
    .filter((e) => e.username === username)
    .map((e) => e.department);
}

/** Lista todos os setores configurados — usado para popular o formulário. */
function listDepartments() {
  return [...buildApproverMap().values()].map((e) => e.department);
}

/**
 * Mapeia PAPÉIS de aprovação (Gestor, Diretor TI, Superior...) aos usuários
 * que podem exercê-los. Usado pelas regras em src/config/approvalRules.js.
 *
 * Configuração no .env (papéis separados por vírgula, usuários por "|"):
 *   APPROVAL_ROLES="Gestor:maria|joao,Diretor TI:adm.tempo,Superior:maria"
 *
 * É separado de DEPARTMENT_APPROVERS de propósito: aquele responde
 * "quem aprova o setor X", este responde "quem exerce o papel Y".
 */
function buildRoleMap() {
  const raw = process.env.APPROVAL_ROLES || "";
  const map = new Map();

  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) return;

      const role = entry.slice(0, separator).trim();
      const usuarios = entry
        .slice(separator + 1)
        .split("|")
        .map((u) => u.trim())
        .filter(Boolean);

      if (!role || !usuarios.length) return;
      map.set(role.toLowerCase(), { role, usuarios });
    });

  return map;
}

/** Usuários que podem aprovar em nome de um papel. */
function usersForRole(role) {
  const entry = buildRoleMap().get(String(role || "").trim().toLowerCase());
  return entry ? entry.usuarios : [];
}

/**
 * Todos os usuários que podem aprovar algo — seja por setor
 * (DEPARTMENT_APPROVERS) ou por papel (APPROVAL_ROLES).
 */
function listAllApprovers() {
  const porSetor = [...buildApproverMap().values()].map((e) => e.username);
  const porPapel = [...buildRoleMap().values()].flatMap((e) => e.usuarios);
  return [...new Set([...porSetor, ...porPapel])];
}

module.exports = {
  getApproverForDepartment,
  isApproverUsername,
  departmentsForApprover,
  listDepartments,
  usersForRole,
  listAllApprovers,
};
