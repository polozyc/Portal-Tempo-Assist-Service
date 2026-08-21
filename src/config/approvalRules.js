/**
 * Catálogo de chamados que exigem "de acordo".
 *
 * A tabela oficial da empresa é formada por DUAS partes — a entidade e a
 * ação — e o de acordo só é exigido quando as duas aparecem juntas:
 *
 *      "JUVO - Criação/Reset"  ->  entity: JUVO    actions: criação, reset
 *
 * Por isso "JUVO não entra" (entidade sem ação) é um incidente e passa
 * direto, enquanto "criar acesso ao JUVO" exige aprovação.
 *
 * ----- Como escrever os termos -----
 * Escreva SEM acento e em minúsculas: o detector normaliza o texto do
 * chamado da mesma forma antes de comparar.
 *
 * Um termo terminado em "*" casa por prefixo. É o jeito mais simples de
 * cobrir as variações da mesma palavra:
 *      "cria*"  casa com criar, criacao, criação, criando, criações
 *      "reset*" casa com reset, resetar, resetei, resetado
 *
 * Erros de digitação são tolerados automaticamente pelo detector
 * (criaçaoo, criacao, cirar...), então não é preciso listá-los aqui.
 *
 * ----- Campos -----
 *   entity      termos que identificam o sistema/objeto (basta um casar)
 *   actions     termos de ação (basta um casar). Se omitido, a entidade
 *               sozinha basta — usado para itens da tabela sem ação
 *               explícita, como WhatsApp e USB.
 *   roles       quem precisa aprovar
 *   conditional true = "quando aplicável": o sistema sugere, não obriga
 */

// Ações que aparecem repetidamente na tabela, agrupadas para reuso.
const CRIACAO = ["cria*", "cadastr*", "abertura", "abrir", "nov*"];
const RESET = ["reset*", "redefini*", "desbloque*", "nova senha", "troca de senha"];
const INCLUSAO = ["inclus*", "inclui*", "incluir", "adicion*", "acrescent*"];
const LIBERACAO = ["libera*", "liberar", "permiss*", "autoriz*", "habilit*", "conced*"];

const APPROVAL_RULES = [
  {
    id: "usuario-criacao",
    label: "Usuário - Criação",
    roles: ["Gestor"],
    entity: ["usuario", "user", "login", "conta", "colaborador", "funcionario"],
    actions: CRIACAO,
  },
  {
    id: "usuario-reset",
    label: "Usuário - Reset",
    roles: ["Gestor"],
    entity: ["usuario", "user", "login", "conta", "senha"],
    actions: RESET,
  },
  {
    id: "usuario-desligamento",
    label: "Usuário - Desligamento",
    roles: ["Gestor"],
    entity: ["usuario", "user", "login", "conta", "colaborador", "funcionario"],
    actions: ["desligament*", "desligar", "demiss*", "demitid*", "inativ*", "exclu*", "remov*", "bloque*"],
  },
  {
    id: "juvo",
    label: "JUVO - Criação/Reset",
    roles: ["Gestor"],
    entity: ["juvo"],
    actions: [...CRIACAO, ...RESET, ...LIBERACAO],
  },
  {
    id: "toa",
    label: "TOA - Criação/Reset",
    roles: ["Gestor"],
    entity: ["toa"],
    actions: [...CRIACAO, ...RESET, ...LIBERACAO],
  },
  {
    id: "diretorio-criacao",
    label: "Diretório - Criação",
    roles: ["Gestor"],
    entity: ["diretorio", "pasta", "compartilhamento"],
    actions: CRIACAO,
  },
  {
    id: "diretorio-liberacao",
    label: "Diretório - Liberação",
    roles: ["Gestor"],
    conditional: true, // tabela: "quando aplicável"
    entity: ["diretorio", "pasta", "compartilhamento"],
    actions: [...LIBERACAO, "acesso"],
  },
  {
    id: "power-bi",
    label: "Power BI - Criação/Reset/Inclusão",
    roles: ["Gestor"],
    entity: ["power bi", "powerbi", "power-bi"],
    actions: [...CRIACAO, ...RESET, ...INCLUSAO, ...LIBERACAO],
  },
  {
    id: "dimep",
    label: "Dimep - Criação",
    roles: ["Gestor"],
    entity: ["dimep"],
    actions: CRIACAO,
  },
  {
    id: "chave-email",
    label: "Chave de E-mail - Criação/Inclusão",
    roles: ["Gestor"],
    entity: ["chave de e-mail", "chave de email", "chave"],
    actions: [...CRIACAO, ...INCLUSAO],
  },
  {
    id: "email-fake-blip",
    label: "E-mail Fake BLIP - Criação",
    roles: ["Gestor"],
    entity: ["blip"],
    actions: CRIACAO,
  },
  {
    id: "teams-licencas",
    label: "Teams Licenças",
    roles: ["Gestor"],
    entity: ["teams"],
    actions: ["licenc*", "licencia*"],
  },
  {
    id: "teams-gravacao",
    label: "Teams Gravação de Tela",
    roles: ["Gestor"],
    entity: ["teams"],
    actions: ["grava*"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    roles: ["Gestor", "Gestão TI"],
    entity: ["whatsapp", "whats app", "whats-app"],
    // Sem ação na tabela: a entidade basta (o detector ainda descarta
    // relatos de problema, como "whatsapp travando").
  },
  {
    id: "sap-reset",
    label: "SAP - Reset",
    roles: ["Superior"],
    entity: ["sap"],
    actions: RESET,
  },
  {
    id: "sap-criacao",
    label: "SAP - Criação",
    roles: ["Gestor/Responsável"],
    entity: ["sap"],
    actions: [...CRIACAO, ...LIBERACAO],
  },
  {
    id: "usb",
    label: "USB",
    roles: ["Diretor TI"],
    entity: ["usb", "pendrive", "pen drive"],
    // Sem ação na tabela.
  },
  {
    id: "enviar-em-nome",
    label: "Enviar em Nome da Chave",
    roles: ["Gestor"],
    entity: ["enviar em nome", "enviar como", "send as", "em nome da chave"],
    // A própria expressão já é o pedido — não existe "relatar problema
    // de enviar em nome". Por isso a entidade sozinha basta.
    entityIsRequest: true,
  },
];

/** Todos os papéis citados no catálogo, sem repetição. */
function listApprovalRoles() {
  const roles = new Set();
  APPROVAL_RULES.forEach((r) => r.roles.forEach((role) => roles.add(role)));
  return [...roles];
}

module.exports = { APPROVAL_RULES, listApprovalRoles };
