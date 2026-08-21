const { APPROVAL_RULES } = require("../config/approvalRules");

/** Normaliza: minúsculas, sem acento, pontuação vira espaço. */
function normalize(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Distância de Damerau-Levenshtein: número mínimo de edições (inserir,
 * remover, substituir ou TROCAR DE LUGAR dois caracteres vizinhos) para
 * transformar uma palavra na outra.
 *
 * A troca de vizinhos importa porque é o erro de digitação mais comum:
 * "cirar" -> "criar" custa 1 aqui, mas custaria 2 na Levenshtein simples.
 */
function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // remoção
        d[i][j - 1] + 1, // inserção
        d[i - 1][j - 1] + custo // substituição
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposição
      }
    }
  }
  return d[m][n];
}

/**
 * Quantos erros toleramos, conforme o tamanho da palavra.
 *
 * Palavras curtas ficam sem tolerância de propósito: com 1 erro permitido,
 * "sap" casaria com "sup" e "usb" com "usa", gerando aprovações indevidas.
 */
function tolerancia(palavra) {
  if (palavra.length <= 3) return 0;
  if (palavra.length <= 7) return 1;
  return 2;
}

function tokenizar(texto) {
  return texto.split(/\s+/).filter(Boolean);
}

/**
 * Verifica se um termo aparece no texto.
 *
 * Aceita três formas:
 *   "cria*"        prefixo — casa com criar, criacao, criando...
 *   "power bi"     expressão de várias palavras
 *   "juvo"         palavra única (com tolerância a digitação)
 */
function termoPresente(texto, tokens, termo) {
  const alvo = normalize(termo.replace(/\*$/, ""));
  if (!alvo) return false;

  const ehPrefixo = termo.trim().endsWith("*");
  const palavras = alvo.split(" ");

  // --- Expressão com mais de uma palavra ---
  if (palavras.length > 1) {
    if (texto.includes(alvo)) return true;
    // Janela deslizante, para tolerar digitação em cada palavra.
    for (let i = 0; i + palavras.length <= tokens.length; i++) {
      const casaTudo = palavras.every((p, k) => {
        const token = tokens[i + k];
        if (p === token) return true;
        return damerauLevenshtein(p, token) <= tolerancia(p);
      });
      if (casaTudo) return true;
    }
    return false;
  }

  // --- Palavra única ---
  return tokens.some((token) => {
    if (ehPrefixo) {
      if (token.startsWith(alvo)) return true;

      const tol = tolerancia(alvo);
      if (tol === 0) return false;

      // Token mais curto que o prefixo ("rest" para o prefixo "reset*"):
      // compara a palavra inteira.
      if (token.length < alvo.length) {
        return damerauLevenshtein(alvo, token) <= tol;
      }

      // Caso normal: compara só o começo do token ("criaçaoo" -> "criaç").
      return damerauLevenshtein(alvo, token.slice(0, alvo.length)) <= tol;
    }
    if (token === alvo) return true;
    return damerauLevenshtein(alvo, token) <= tolerancia(alvo);
  });
}

function algumTermo(texto, tokens, termos) {
  return termos.some((t) => termoPresente(texto, tokens, t));
}

/**
 * ----- Análise de intenção -----
 * Citar um sistema não é pedir acesso a ele. "JUVO não entra" é incidente;
 * "criar acesso ao JUVO" é solicitação.
 */
const TERMOS_INCIDENTE = [
  "nao entra", "nao consigo entrar", "nao consigo acessar", "nao consigo logar",
  "nao loga", "nao funciona", "nao esta funcionando", "parou de funcionar",
  "nao abre", "nao carrega", "nao responde", "nao aparece", "nao registra",
  "sem acesso", "perdi o acesso", "perdi acesso",
  "caiu", "queda", "fora do ar", "indisponivel", "instabilidade",
  "erro", "falha", "travando", "travou", "lento", "lentidao",
  "problema", "defeito", "com defeito",
  "quebrado", "quebrada", "quebrados", "quebradas",
  "danificado", "danificada", "estragado", "estragada", "inoperante",
  "parou", "sumiu", "desapareceu",
];

const TERMOS_SOLICITACAO_FORTE = [
  "cria*", "cadastr*", "abertura", "reset*", "redefini*", "desbloque*",
  "inclus*", "inclui*", "adicion*", "libera*", "habilit*", "ativ*",
  "conced*", "autoriz*", "solicit*", "desligament*", "demiss*",
  "inativ*", "exclu*", "remov*", "transfer*", "licenc*", "permiss*",
];

const TERMOS_SOLICITACAO_FRACA = ["acesso", "acessar", "preciso", "necessito", "gostaria"];

function classificarIntencao(texto, tokens) {
  // Pedido explícito vence relato: "não consigo entrar, favor resetar"
  // continua sendo uma solicitação.
  if (algumTermo(texto, tokens, TERMOS_SOLICITACAO_FORTE)) return "solicitacao";
  if (algumTermo(texto, tokens, TERMOS_INCIDENTE)) return "incidente";
  if (algumTermo(texto, tokens, TERMOS_SOLICITACAO_FRACA)) return "ambigua";
  return "ambigua";
}

/**
 * Uma regra casa quando a ENTIDADE aparece e — se a regra tiver ações —
 * ao menos uma AÇÃO também aparece. É a leitura literal da tabela.
 */
function ruleMatches(rule, texto, tokens) {
  if (!algumTermo(texto, tokens, rule.entity)) return false;
  if (!rule.actions || !rule.actions.length) return true;
  return algumTermo(texto, tokens, rule.actions);
}

/**
 * Analisa o chamado e devolve as regras aplicáveis.
 *
 *   requiresApproval  há regra obrigatória (bloqueia abertura direta)
 *   suggested         caso ambíguo ou regra "quando aplicável"
 *   intent            incidente | solicitacao | ambigua
 */
function detectApprovalNeed({ subject, description, requestTypeName }) {
  const texto = normalize([subject, description, requestTypeName].filter(Boolean).join(" "));
  const tokens = tokenizar(texto);
  const intent = classificarIntencao(texto, tokens);

  // Relato de problema não exige aprovação.
  if (intent === "incidente") {
    return { requiresApproval: false, suggested: false, intent, matches: [], roles: [] };
  }

  const matches = APPROVAL_RULES.filter((rule) => ruleMatches(rule, texto, tokens)).map((rule) => {
    // Regras "quando aplicável" nunca obrigam. Regras sem ação própria
    // (WhatsApp, USB) só obrigam quando a intenção é claramente um pedido.
    // Regras sem ação própria (WhatsApp, USB) só obrigam quando a intenção
    // é claramente um pedido — a menos que a entidade JÁ seja o pedido
    // (ex: "enviar em nome da chave"), sinalizado por entityIsRequest.
    const semAcaoPropria = !rule.actions || !rule.actions.length;
    const dependeDaIntencao = semAcaoPropria && !rule.entityIsRequest;
    const apenasSugestao =
      !!rule.conditional || (dependeDaIntencao && intent !== "solicitacao");

    return {
      id: rule.id,
      label: rule.label,
      roles: rule.roles,
      conditional: apenasSugestao,
    };
  });

  const obrigatorias = matches.filter((m) => !m.conditional);
  const roles = [...new Set(matches.flatMap((m) => m.roles))];

  return {
    requiresApproval: obrigatorias.length > 0,
    suggested: obrigatorias.length === 0 && matches.length > 0,
    intent,
    matches,
    roles,
  };
}

module.exports = { detectApprovalNeed, classificarIntencao, normalize, damerauLevenshtein };
