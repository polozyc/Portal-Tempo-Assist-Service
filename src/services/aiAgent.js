const axios = require("axios");

/**
 * Agente de IA para triagem de chamados recebidos por e-mail.
 *
 * ----- Por que um agente, e não regras -----
 * E-mail é texto livre: a pessoa escreve "o sistema tá fora do ar de novo,
 * já é a terceira vez essa semana, preciso que resolvam urgente" — sem
 * dizer qual sistema, sem categoria, sem prioridade explícita.
 *
 * Regras de palavra-chave não dão conta disso. O agente lê a mensagem,
 * interpreta o contexto, DECIDE (categoria, urgência, necessidade de
 * aprovação) e EXECUTA a ação correspondente: abrir o chamado, encaminhar
 * para aprovação ou pedir mais informações.
 *
 * ----- Provedores -----
 * Configurável via AI_PROVIDER: gemini (padrão), openai ou anthropic.
 * A escolha do provedor não muda o resto do sistema.
 */

// Modelos maiores levam mais tempo, e rede corporativa soma latência.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 90000);

// Limite por tentativa: se um modelo estiver lento, sobra tempo para
// tentar o próximo antes de estourar o limite total.
const TIMEOUT_TENTATIVA_MS = Math.min(TIMEOUT_MS, 45000);

function aiConfig() {
  return {
    provider: (process.env.AI_PROVIDER || "gemini").toLowerCase(),
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || null,
  };
}

function isAiEnabled() {
  return !!process.env.AI_API_KEY;
}

/**
 * Instruções do agente.
 *
 * Recebe o catálogo de regras da empresa e os tipos do Jira como contexto,
 * em vez de ter isso fixo no código: assim, quando a empresa muda a tabela
 * de aprovações ou cria um tipo no Jira, o agente se adapta sozinho.
 */
function montarPrompt({ email, tiposDisponiveis, regrasAprovacao }) {
  const tipos = tiposDisponiveis
    .map((g) => `  ${g.group}:\n` + g.types.map((t) => `    - id=${t.id} | ${t.name}`).join("\n"))
    .join("\n");

  const regras = regrasAprovacao
    .map((r) => `  - ${r.label} -> aprovação de: ${r.roles.join(" e ")}`)
    .join("\n");

  return `Você é o agente de triagem do service desk da Tempo Assist.

Analise o e-mail abaixo e decida como tratá-lo.

TIPOS DE SOLICITAÇÃO DISPONÍVEIS NO JIRA:
${tipos || "  (nenhum tipo carregado — use null)"}

CHAMADOS QUE EXIGEM "DE ACORDO" DO GESTOR:
${regras}

REGRAS DE DECISÃO:
1. Distinga INCIDENTE (algo que funcionava e parou) de SOLICITAÇÃO (pedido
   de algo novo, acesso, criação, liberação). Só SOLICITAÇÕES entram na
   tabela de "de acordo" acima — relatar que o SAP caiu não exige aprovação;
   pedir acesso ao SAP exige.
2. Escolha o tipo de solicitação mais adequado entre os listados.
3. Defina a urgência considerando impacto e quantidade de pessoas afetadas.
4. Se faltar informação essencial para atender (ex: qual sistema, qual
   equipamento, para qual pessoa), marque precisaMaisInfo=true e escreva o
   que perguntar.
5. Escreva um resumo objetivo para o título e uma descrição organizada,
   preservando os detalhes técnicos que o solicitante forneceu.

E-MAIL RECEBIDO:
De: ${email.senderEmail}
Assunto: ${email.subject}
Corpo:
"""
${email.bodyText}
"""

Responda APENAS com um JSON válido, sem texto antes ou depois, neste formato:
{
  "categoria": "incidente" | "solicitacao",
  "tipoSolicitacaoId": "id do tipo escolhido, ou null",
  "tipoSolicitacaoNome": "nome do tipo escolhido, ou null",
  "titulo": "resumo em uma linha, sem quebras",
  "descricao": "descrição organizada do que foi pedido",
  "urgencia": "baixa" | "media" | "alta",
  "precisaAprovacao": true | false,
  "regraAprovacao": "nome da regra da tabela, ou null",
  "papelAprovador": "Gestor" | "Diretor TI" | "Superior" | "Gestão TI" | "Gestor/Responsável" | null,
  "precisaMaisInfo": true | false,
  "perguntaAoSolicitante": "o que perguntar, ou null",
  "raciocinio": "explique em 1-2 frases por que decidiu assim"
}`;
}

// ---------- Chamadas por provedor ----------

// O Google aposenta modelos com frequência (o 2.0 Flash saiu do ar em
// junho/2026) e cada um tem cota gratuita diferente. Em vez de fixar um
// nome, perguntamos à API o que a conta tem e tentamos em ordem.
let candidatosGemini = null;

async function listarCandidatosGemini(chave) {
  if (candidatosGemini) return candidatosGemini;

  const { data } = await axios.get(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${chave}`,
    { timeout: TIMEOUT_TENTATIVA_MS }
  );

  const disponiveis = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""));

  const indesejados = /(image|vision|audio|tts|embedding|aqa|learnlm|thinking)/i;
  const uteis = disponiveis.filter((m) => !indesejados.test(m));

  // Ordem pensada para o plano gratuito: "lite" tem a cota mais generosa.
  const lite = uteis.filter((m) => /flash-lite/i.test(m)).sort().reverse();
  const flash = uteis.filter((m) => /flash/i.test(m) && !/lite/i.test(m)).sort().reverse();
  const pro = uteis.filter((m) => /pro/i.test(m)).sort().reverse();
  const resto = uteis.filter((m) => !/(flash|pro)/i.test(m));

  candidatosGemini = [...lite, ...flash, ...pro, ...resto];

  if (!candidatosGemini.length) {
    throw new Error(
      `Esta chave não tem modelos que gerem texto (${disponiveis.join(", ") || "nenhum"}).`
    );
  }

  console.log(`[agente] modelos Gemini, em ordem de tentativa: ${candidatosGemini.join(", ")}`);
  return candidatosGemini;
}

async function chamarGemini({ apiKey, model, prompt }) {
  const tentativas = model ? [model] : await listarCandidatosGemini(apiKey);

  const corpo = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };

  let ultimoErro;

  for (const m of tentativas) {
    try {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
        corpo,
        { timeout: TIMEOUT_TENTATIVA_MS }
      );

      // Modelo que respondeu vira o primeiro da fila nas próximas chamadas.
      if (candidatosGemini && candidatosGemini[0] !== m) {
        candidatosGemini = [m, ...candidatosGemini.filter((x) => x !== m)];
      }

      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch (err) {
      const status = err.response?.status;
      const expirou = err.code === "ECONNABORTED";

      // 404 = aposentado | 429 = cota esgotada | timeout = lento demais.
      if (status === 404 || status === 429 || expirou) {
        console.warn(`[agente] "${m}" ${expirou ? "demorou demais" : `indisponível (${status})`}.`);
        ultimoErro = err;
        continue;
      }
      throw err;
    }
  }

  if (ultimoErro?.response?.status === 429) {
    throw new Error("A cota gratuita do Gemini se esgotou. Aguarde alguns minutos.");
  }
  if (ultimoErro?.code === "ECONNABORTED") {
    throw new Error("Os modelos demoraram demais para responder. Tente de novo.");
  }
  throw new Error("Nenhum modelo do Gemini respondeu. Verifique a chave em aistudio.google.com/apikey.");
}

async function chamarOpenAI({ apiKey, model, prompt }) {
  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: model || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TIMEOUT_MS }
  );

  return data.choices?.[0]?.message?.content || "";
}

async function chamarAnthropic({ apiKey, model, prompt }) {
  const { data } = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: model || "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: TIMEOUT_MS,
    }
  );

  return data.content?.map((c) => c.text || "").join("") || "";
}

/**
 * Extrai o JSON da resposta.
 *
 * Modelos às vezes envolvem o JSON em ```json ... ``` ou adicionam uma
 * frase antes. Tratamos isso em vez de deixar o parse quebrar.
 */
function extrairJson(texto) {
  const limpo = String(texto || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(limpo);
  } catch {
    const inicio = limpo.indexOf("{");
    const fim = limpo.lastIndexOf("}");
    if (inicio !== -1 && fim > inicio) {
      return JSON.parse(limpo.slice(inicio, fim + 1));
    }
    throw new Error("A resposta do modelo não continha um JSON válido.");
  }
}

/** Garante que a decisão do modelo tem o formato esperado. */
function validarDecisao(d) {
  const categorias = ["incidente", "solicitacao"];
  const urgencias = ["baixa", "media", "alta"];

  if (!d || typeof d !== "object") throw new Error("Decisão vazia.");
  if (!categorias.includes(d.categoria)) d.categoria = "solicitacao";
  if (!urgencias.includes(d.urgencia)) d.urgencia = "media";
  if (!d.titulo || typeof d.titulo !== "string") {
    throw new Error("A decisão veio sem título.");
  }

  // Um incidente nunca exige "de acordo": mesmo que o modelo diga que sim,
  // a tabela da empresa só se aplica a solicitações.
  if (d.categoria === "incidente") {
    d.precisaAprovacao = false;
    d.regraAprovacao = null;
    d.papelAprovador = null;
  }

  d.precisaAprovacao = !!d.precisaAprovacao;
  d.precisaMaisInfo = !!d.precisaMaisInfo;
  d.titulo = d.titulo.replace(/[\r\n\t]+/g, " ").trim().slice(0, 250);

  return d;
}

/**
 * Analisa um e-mail e devolve a decisão do agente.
 *
 * Lança erro se a IA não estiver configurada ou falhar — quem chama decide
 * se cai no caminho antigo (regras) ou interrompe.
 */
async function analisarEmail({ email, tiposDisponiveis = [], regrasAprovacao = [] }) {
  const cfg = aiConfig();
  if (!cfg.apiKey) {
    throw new Error("AI_API_KEY não configurada.");
  }

  const prompt = montarPrompt({ email, tiposDisponiveis, regrasAprovacao });
  const inicio = Date.now();

  let resposta;
  switch (cfg.provider) {
    case "openai":
      resposta = await chamarOpenAI({ ...cfg, prompt });
      break;
    case "anthropic":
      resposta = await chamarAnthropic({ ...cfg, prompt });
      break;
    case "gemini":
      resposta = await chamarGemini({ ...cfg, prompt });
      break;
    default:
      throw new Error(`AI_PROVIDER inválido: "${cfg.provider}". Use gemini, openai ou anthropic.`);
  }

  const decisao = validarDecisao(extrairJson(resposta));
  decisao.tempoMs = Date.now() - inicio;
  decisao.provedor = cfg.provider;

  console.log(
    `[agente] ${decisao.categoria} | urgência ${decisao.urgencia} | ` +
      `aprovação: ${decisao.precisaAprovacao ? decisao.papelAprovador : "não"} | ` +
      `${decisao.tempoMs}ms`
  );
  console.log(`[agente] raciocínio: ${decisao.raciocinio}`);

  return decisao;
}


// =====================================================================
// MODO CONVERSACIONAL
// =====================================================================

/**
 * Instruções do agente quando ele conversa com o solicitante.
 *
 * A diferença para a triagem de e-mail: aqui o agente pode PERGUNTAR.
 * Em vez de recusar um pedido vago, ele conduz a conversa até ter o que
 * precisa — como um atendente de suporte faria.
 */
function montarPromptConversa({ historico, tiposDisponiveis, regrasAprovacao, usuario, dadosConhecidos, anexos = [] }) {
  const tipos = tiposDisponiveis
    .map((g) => `  ${g.group}:\n` + g.types.map((t) => `    - id=${t.id} | ${t.name}`).join("\n"))
    .join("\n");

  const regras = regrasAprovacao
    .map((r) => `  - ${r.label} -> aprovação de: ${r.roles.join(" e ")}`)
    .join("\n");

  const conversa = historico
    .map((m) => `${m.autor === "usuario" ? "SOLICITANTE" : "VOCÊ"}: ${m.texto}`)
    .join("\n");

  const conhecidos = [
    dadosConhecidos?.nome ? `  Nome: ${dadosConhecidos.nome}` : null,
    dadosConhecidos?.email ? `  E-mail: ${dadosConhecidos.email}` : null,
    dadosConhecidos?.setor ? `  Setor: ${dadosConhecidos.setor}` : null,
  ].filter(Boolean);

  return `Você é o Tino, assistente do service desk da Tempo Assist. Converse
com o colaborador para entender o que ele precisa e abrir o chamado certo.
Se perguntarem seu nome, você é o Tino.

QUEM ESTÁ FALANDO COM VOCÊ: ${usuario}

QUEM ESTÁ LOGADO NO SISTEMA (é quem abre o chamado):
${conhecidos.length ? conhecidos.join("\n") : "  (não identificado)"}

ATENÇÃO: o chamado nem sempre é para quem está logado. Analistas do
service desk abrem chamados para colegas com frequência. Pergunte SEMPRE
para quem é o chamado antes de coletar os dados — e só reaproveite os
dados acima se a pessoa confirmar que é para ela mesma.

TIPOS DE SOLICITAÇÃO DISPONÍVEIS NO JIRA:
${tipos || "  (nenhum tipo carregado)"}

CHAMADOS QUE EXIGEM "DE ACORDO" DO GESTOR:
${regras}

COMO CONDUZIR A CONVERSA:
1. Seja breve e natural, como um atendente de chat. Uma pergunta por vez.
2. Distinga INCIDENTE (algo parou de funcionar) de SOLICITAÇÃO (pedido de
   algo novo, acesso, criação, liberação). Isso muda o tratamento: só
   solicitações entram na tabela de "de acordo".
3. Entenda o caso: o que aconteceu ou é necessário, qual sistema ou
   equipamento, desde quando ou para quando, e quem é afetado.
4. Descubra PARA QUEM é o chamado. Pergunte cedo, algo como "esse
   chamado é para você ou para outra pessoa?". Se for para outra pessoa,
   colete os dados DELA — não os de quem está logado.
5. Complete os DADOS DE CADASTRO da pessoa que vai ser atendida.
   Obrigatórios: nome, e-mail, setor e horário de trabalho.
   Opcionais: se a máquina é da Tempo ou pessoal, ID do AnyDesk e alguma
   observação. Ofereça os opcionais uma vez e siga em frente se a pessoa
   não quiser informar.
   Pode agrupar duas perguntas numa só para encurtar a conversa.
6. Não repita perguntas já respondidas nem peça informação irrelevante.
7. Quando tiver o caso entendido E os dados obrigatórios, RESUMA e pergunte
   se pode abrir. Só marque prontoParaAbrir=true depois da CONFIRMAÇÃO.
8. Se o pedido cair na tabela de "de acordo", avise que vai precisar da
   aprovação de um gestor antes de ir para a fila.
9. Se for algo simples e conhecido (senha do Windows expirada, impressora
   sem papel), sugira a solução antes de abrir o chamado.

ARQUIVOS QUE A PESSOA JÁ ANEXOU:
${anexos.length ? anexos.map((a) => `  - ${a}`).join("\n") : "  (nenhum)"}
Se já houver anexo, não peça print nem documento de novo. Se o caso for
visual (erro na tela, equipamento danificado) e não houver anexo, você
pode sugerir que a pessoa anexe pelo clipe ao lado do campo de texto.

CONVERSA ATÉ AGORA:
${conversa}

Responda APENAS com um JSON válido, sem texto antes ou depois:
{
  "mensagem": "sua próxima fala para o colaborador",
  "prontoParaAbrir": true | false,
  "chamado": {
    "titulo": "resumo em uma linha, sem quebras",
    "descricao": "descrição objetiva do caso, em 1-3 frases",
    "paraOutraPessoa": true | false,
    "solicitanteNome": "nome completo de QUEM SERÁ ATENDIDO, ou null",
    "solicitanteEmail": "e-mail corporativo, ou null",
    "setor": "setor/departamento, ou null",
    "horarioTrabalho": "horário de trabalho, ou null",
    "maquina": "Tempo" | "Pessoal" | null,
    "anydesk": "ID do AnyDesk, ou null",
    "observacao": "observação extra, ou null",
    "categoria": "incidente" | "solicitacao",
    "tipoSolicitacaoId": "id do tipo, ou null",
    "tipoSolicitacaoNome": "nome do tipo, ou null",
    "urgencia": "baixa" | "media" | "alta",
    "precisaAprovacao": true | false,
    "regraAprovacao": "nome da regra da tabela, ou null",
    "papelAprovador": "Gestor" | "Diretor TI" | "Superior" | "Gestão TI" | "Gestor/Responsável" | null
  },
  "raciocinio": "por que você decidiu assim, em 1 frase"
}

Enquanto prontoParaAbrir for false, o objeto "chamado" pode vir com o que
você já conseguiu apurar (ou null nos campos que ainda faltam).`;
}

/**
 * Conduz um turno da conversa.
 *
 * Recebe todo o histórico porque o modelo não guarda estado entre
 * chamadas — cada requisição precisa levar o contexto completo.
 */
async function conversar({ historico, tiposDisponiveis = [], regrasAprovacao = [], usuario = "colaborador", dadosConhecidos = null, anexos = [] }) {
  const cfg = aiConfig();
  if (!cfg.apiKey) {
    throw new Error("AI_API_KEY não configurada.");
  }

  const prompt = montarPromptConversa({ historico, tiposDisponiveis, regrasAprovacao, usuario, dadosConhecidos, anexos });
  const inicio = Date.now();

  let resposta;
  switch (cfg.provider) {
    case "openai":
      resposta = await chamarOpenAI({ ...cfg, prompt });
      break;
    case "anthropic":
      resposta = await chamarAnthropic({ ...cfg, prompt });
      break;
    case "gemini":
      resposta = await chamarGemini({ ...cfg, prompt });
      break;
    default:
      throw new Error(`AI_PROVIDER inválido: "${cfg.provider}".`);
  }

  const turno = extrairJson(resposta);

  if (!turno.mensagem || typeof turno.mensagem !== "string") {
    throw new Error("O agente não retornou uma mensagem.");
  }

  turno.prontoParaAbrir = !!turno.prontoParaAbrir;

  // Só validamos o chamado quando o agente diz que está pronto: antes
  // disso é normal que venha incompleto.
  // Limpa os campos de cadastro: string útil ou null, nunca "null" em
  // texto nem espaços soltos (o modelo devolve os dois com frequência).
  const c = turno.chamado || {};
  for (const campo of [
    "solicitanteNome", "solicitanteEmail", "setor",
    "horarioTrabalho", "anydesk", "maquina", "observacao",
  ]) {
    const v = c[campo];
    c[campo] =
      v && String(v).trim() && String(v).trim().toLowerCase() !== "null"
        ? String(v).trim()
        : null;
  }

  // "maquina" só aceita dois valores; qualquer outra resposta não diz de
  // quem é o equipamento.
  if (c.maquina) {
    const v = c.maquina.toLowerCase();
    if (/tempo|corporat|empresa/.test(v)) c.maquina = "Tempo";
    else if (/pessoal|propri|particular/.test(v)) c.maquina = "Pessoal";
    else c.maquina = null;
  }

  // Só reaproveitamos os dados da sessão quando o chamado é para quem
  // está logado. Se for para outra pessoa, preencher aqui gravaria o
  // nome errado no chamado.
  c.paraOutraPessoa = !!c.paraOutraPessoa;
  if (dadosConhecidos && !c.paraOutraPessoa) {
    c.solicitanteNome = c.solicitanteNome || dadosConhecidos.nome || null;
    c.solicitanteEmail = c.solicitanteEmail || dadosConhecidos.email || null;
    c.setor = c.setor || dadosConhecidos.setor || null;
  }

  turno.chamado = c;

  if (turno.prontoParaAbrir) {
    turno.chamado = validarDecisao({ ...c, precisaMaisInfo: false });

    // Barreira: o chamado não pode ir para a fila sem identificação,
    // mesmo que o modelo se precipite.
    const faltando = [];
    if (!turno.chamado.solicitanteNome) faltando.push("nome");
    if (!turno.chamado.solicitanteEmail) faltando.push("e-mail");
    if (!turno.chamado.setor) faltando.push("setor");
    if (!turno.chamado.horarioTrabalho) faltando.push("horário de trabalho");

    if (faltando.length) {
      throw new Error(`FALTAM_DADOS:${faltando.join(", ")}`);
    }
  }

  turno.tempoMs = Date.now() - inicio;

  console.log(
    `[chat] turno em ${turno.tempoMs}ms | pronto: ${turno.prontoParaAbrir}` +
      (turno.raciocinio ? ` | ${turno.raciocinio}` : "")
  );

  return turno;
}

module.exports = {
  analisarEmail,
  conversar,
  isAiEnabled,
  extrairJson,
  validarDecisao,
  montarPrompt,
  montarPromptConversa,
};
