const axios = require("axios");

const JIRA_TIMEOUT_MS = 20000;

// Os tipos de solicitação mudam raramente, mas a tela de abertura de chamado
// é carregada a toda hora. Sem cache, cada acesso dispararia 2 chamadas ao
// Jira e a página ficaria refém da latência deles.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
let requestTypeCache = { data: null, fetchedAt: 0 };

function jiraAuthHeader() {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

function jiraHeaders() {
  return {
    Authorization: jiraAuthHeader(),
    "Content-Type": "application/json",
    // Necessário em algumas contas para raiseOnBehalfOf e para os endpoints
    // de request type group.
    "X-ExperimentalApi": "opt-in",
  };
}

/**
 * Busca os tipos de solicitação do service desk, já organizados pelos
 * grupos do portal (Hardware, Sistemas, Software, Telecom...).
 *
 * Retorna:
 *   [{ group: "Hardware", types: [{ id, name, description }] }, ...]
 *
 * Tipos que não pertencem a nenhum grupo (caso do "Emailed request")
 * são agrupados em "Outros", para não sumirem da lista.
 */
async function getRequestTypeGroups({ force = false } = {}) {
  const agora = Date.now();
  if (!force && requestTypeCache.data && agora - requestTypeCache.fetchedAt < CACHE_TTL_MS) {
    return requestTypeCache.data;
  }

  const { JIRA_BASE_URL, JIRA_SERVICE_DESK_ID } = process.env;
  const base = `${JIRA_BASE_URL}/rest/servicedeskapi/servicedesk/${JIRA_SERVICE_DESK_ID}`;

  const [gruposRes, tiposRes] = await Promise.all([
    axios.get(`${base}/requesttypegroup`, { headers: jiraHeaders(), timeout: JIRA_TIMEOUT_MS }),
    axios.get(`${base}/requesttype`, { headers: jiraHeaders(), timeout: JIRA_TIMEOUT_MS }),
  ]);

  const grupos = gruposRes.data.values || [];
  const tipos = (tiposRes.data.values || []).filter((t) => t.canCreateRequest !== false);

  const resultado = grupos
    .map((grupo) => ({
      groupId: String(grupo.id),
      group: grupo.name,
      types: tipos
        .filter((t) => (t.groupIds || []).map(String).includes(String(grupo.id)))
        .map((t) => ({ id: String(t.id), name: t.name, description: t.description || "" })),
    }))
    .filter((g) => g.types.length > 0);

  const semGrupo = tipos
    .filter((t) => !t.groupIds || t.groupIds.length === 0)
    .map((t) => ({ id: String(t.id), name: t.name, description: t.description || "" }));

  if (semGrupo.length) {
    resultado.push({ groupId: "sem-grupo", group: "Outros", types: semGrupo });
  }

  requestTypeCache = { data: resultado, fetchedAt: agora };
  return resultado;
}

/** Confere se um requestTypeId realmente existe no service desk configurado. */
async function isValidRequestType(requestTypeId) {
  if (!requestTypeId) return false;
  const grupos = await getRequestTypeGroups();
  return grupos.some((g) => g.types.some((t) => t.id === String(requestTypeId)));
}

/** Nome legível do tipo, para guardar junto do chamado no banco. */
async function getRequestTypeName(requestTypeId) {
  const grupos = await getRequestTypeGroups();
  for (const g of grupos) {
    const achado = g.types.find((t) => t.id === String(requestTypeId));
    if (achado) return `${g.group} › ${achado.name}`;
  }
  return null;
}

// Cache dos campos por tipo: a tela de abertura e a aprovação consultam
// isso a cada chamado, e a configuração de campos muda raramente.
const fieldCache = new Map(); // requestTypeId -> { data, fetchedAt }

/**
 * Descobre quais campos um tipo de solicitação aceita.
 *
 * Isso é necessário porque cada tipo criado no Jira tem seu próprio
 * formulário: um pode ter "description", outro pode ter só "summary" mais
 * campos personalizados. Enviar um campo que o tipo não aceita faz o Jira
 * recusar a criação inteira.
 */
async function getRequestTypeFields(requestTypeId) {
  const agora = Date.now();
  const cached = fieldCache.get(String(requestTypeId));
  if (cached && agora - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const { JIRA_BASE_URL, JIRA_SERVICE_DESK_ID } = process.env;
  const url =
    `${JIRA_BASE_URL}/rest/servicedeskapi/servicedesk/${JIRA_SERVICE_DESK_ID}` +
    `/requesttype/${requestTypeId}/field`;

  const { data } = await axios.get(url, { headers: jiraHeaders(), timeout: JIRA_TIMEOUT_MS });

  const campos = (data.requestTypeFields || []).map((f) => ({
    fieldId: f.fieldId,
    name: f.name,
    required: !!f.required,
    // "any" costuma ser texto livre; select/option exigem valores válidos
    type: f.jiraSchema?.type || "string",
    system: f.jiraSchema?.system || null,
    validValues: (f.validValues || []).map((v) => ({ value: v.value, label: v.label })),
  }));

  // Log de diagnóstico: mostra exatamente o formulário que o Jira espera
  // para este tipo. Facilita entender recusas do tipo "campo X não é válido".
  console.log(
    `[jira] campos do tipo ${requestTypeId}: ` +
      (campos.length
        ? campos
            .map((c) => `${c.fieldId}(${c.type}${c.required ? ", obrigatório" : ""})`)
            .join(", ")
        : "(nenhum campo retornado)")
  );

  // Quando o tipo devolve pouquíssimos campos, mostramos a resposta crua:
  // costuma indicar formulário Proforma ou permissão faltando, e sem isso
  // não dá para saber o que o Jira realmente espera.
  if (campos.length <= 1) {
    console.log("[jira] resposta crua de campos:", JSON.stringify(data));
  }

  fieldCache.set(String(requestTypeId), { data: campos, fetchedAt: agora });
  return campos;
}

/** Campos de texto livre que aceitam receber o corpo do chamado. */
function isTextField(campo) {
  return (
    ["string", "text"].includes(campo.type) &&
    (!campo.validValues || campo.validValues.length === 0)
  );
}

/**
 * O campo "summary" do Jira e de uma linha so: quebras de linha fazem a
 * criacao ser recusada com "informe um valor valido para o campo 'Summary'".
 * Tambem respeitamos o limite de 255 caracteres.
 */
function sanitizeSummary(texto) {
  const limpo = String(texto || "(sem assunto)")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const LIMITE = 255;
  return limpo.length > LIMITE ? `${limpo.slice(0, LIMITE - 3)}...` : limpo;
}

/**
 * Monta o requestFieldValues respeitando o formulario do tipo escolhido.
 *
 * O corpo do chamado nunca e descartado. Ordem de preferencia:
 *   1. campo "description" (caso normal)
 *   2. primeiro campo de texto obrigatorio
 *   3. primeiro campo de texto opcional
 *   4. nenhum campo disponivel -> o corpo vira um comentario no chamado
 *      (veja createServiceDeskRequest). Nao da para usar o summary:
 *      ele nao aceita quebras de linha e tem limite curto.
 */
function buildFieldValues({ campos, subject, body }) {
  const valores = { summary: sanitizeSummary(subject) };
  const porId = new Map(campos.map((c) => [c.fieldId, c]));
  const textoCorpo = body || "(sem descricao)";

  let corpoSemCampo = false;

  if (porId.has("description")) {
    valores.description = textoCorpo;
  } else {
    const candidatos = campos.filter((c) => c.fieldId !== "summary" && isTextField(c));
    const alvo = candidatos.find((c) => c.required) || candidatos[0];

    if (alvo) {
      valores[alvo.fieldId] = textoCorpo;
    } else {
      corpoSemCampo = true;
    }
  }

  const pendentes = campos.filter((c) => c.required && valores[c.fieldId] === undefined);

  return { valores, pendentes, corpoSemCampo };
}

/**
 * Preenche a descricao do chamado usando a API padrao do Jira.
 *
 * Necessario quando o tipo de solicitacao nao expoe "description" no
 * formulario do portal: a API de service desk recusa o campo, mas a issue
 * em si continua tendo descricao. Usamos a API v2 porque ela aceita texto
 * simples (a v3 exigiria o formato ADF).
 *
 * Se a edicao falhar (campo fora da tela de edicao, por exemplo), caimos
 * para um comentario, para nao perder o conteudo.
 */
async function preencherDescricao(issueKey, body) {
  const { JIRA_BASE_URL } = process.env;

  try {
    await axios.put(
      `${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}`,
      { fields: { description: body } },
      { headers: jiraHeaders(), timeout: JIRA_TIMEOUT_MS }
    );
    console.log(`[jira] ${issueKey}: descricao preenchida via API padrao.`);
    return;
  } catch (err) {
    console.warn(
      `[jira] ${issueKey}: nao foi possivel preencher a descricao (` +
        (err.response?.data ? JSON.stringify(err.response.data) : err.message) +
        "). Publicando como comentario."
    );
  }

  try {
    await axios.post(
      `${JIRA_BASE_URL}/rest/servicedeskapi/request/${issueKey}/comment`,
      { body, public: true },
      { headers: jiraHeaders(), timeout: JIRA_TIMEOUT_MS }
    );
    console.log(`[jira] ${issueKey}: corpo publicado como comentario.`);
  } catch (err) {
    console.error(
      `[jira] ${issueKey}: falha tambem no comentario:`,
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    );
  }
}

/**
 * Cria uma solicitação no Jira Service Management "em nome" do e-mail
 * informado. O campo raiseOnBehalfOf cria o cliente automaticamente no
 * JSM caso ele ainda não exista.
 *
 * requestTypeId é opcional: se não vier, usa JIRA_REQUEST_TYPE_ID do .env
 * (comportamento usado pela sincronização de e-mail).
 *
 * Os campos enviados são montados a partir do formulário do próprio tipo —
 * tipos personalizados podem não ter "description", por exemplo.
 *
 * Docs: POST /rest/servicedeskapi/request
 */
async function createServiceDeskRequest({ subject, body, requesterEmail, requestTypeId }) {
  const { JIRA_BASE_URL, JIRA_SERVICE_DESK_ID, JIRA_REQUEST_TYPE_ID } = process.env;

  const tipoFinal = requestTypeId || JIRA_REQUEST_TYPE_ID;
  const url = `${JIRA_BASE_URL}/rest/servicedeskapi/request`;

  // Padrao usado caso nao consigamos descobrir os campos do tipo.
  let requestFieldValues = {
    summary: sanitizeSummary(subject),
    description: body || "(sem corpo)",
  };
  let corpoPrecisaDeApiPadrao = false;

  try {
    const campos = await getRequestTypeFields(tipoFinal);
    const { valores, pendentes, corpoSemCampo } = buildFieldValues({ campos, subject, body });

    if (pendentes.length) {
      const nomes = pendentes.map((c) => `"${c.name}"`).join(", ");
      const erro = new Error(
        `Este tipo de solicitacao exige campos que o formulario do sistema nao coleta: ${nomes}. ` +
          `Peca ao administrador do Jira para tornar esses campos opcionais neste tipo, ou escolha outro tipo.`
      );
      erro.isFieldMismatch = true;
      throw erro;
    }

    requestFieldValues = valores;
    corpoPrecisaDeApiPadrao = corpoSemCampo;

    console.log(
      `[jira] tipo ${tipoFinal}: enviando campos [${Object.keys(valores).join(", ")}]` +
        (corpoSemCampo ? " (corpo sera preenchido pela API padrao)" : "")
    );
  } catch (err) {
    if (err.isFieldMismatch) throw err;
    console.warn(`[jira] nao foi possivel ler os campos do tipo ${tipoFinal}: ${err.message}`);
  }

  const payload = {
    serviceDeskId: JIRA_SERVICE_DESK_ID,
    requestTypeId: tipoFinal,
    raiseOnBehalfOf: requesterEmail,
    requestFieldValues,
  };

  let data;
  try {
    ({ data } = await axios.post(url, payload, {
      headers: jiraHeaders(),
      timeout: JIRA_TIMEOUT_MS,
    }));
  } catch (err) {
    // Diagnostico: sem isso, so sabemos "status 400" e nao o motivo.
    console.error("[jira] payload enviado:", JSON.stringify(payload));
    if (err.response?.data) {
      console.error("[jira] resposta de erro:", JSON.stringify(err.response.data));
    }
    throw err;
  }

  // Tipos que so tem o campo "summary" no formulario do portal nao aceitam
  // "description" na API de service desk. Nesse caso preenchemos a descricao
  // pela API padrao do Jira, que nao depende do formulario do portal — assim
  // o corpo fica no lugar natural dele, e nao num comentario.
  if (corpoPrecisaDeApiPadrao && body) {
    const issueKey = data.issueKey || data.issueId;
    await preencherDescricao(issueKey, body);
  }

  return data; // contem issueKey, issueId, _links.web, etc.
}

module.exports = {
  createServiceDeskRequest,
  getRequestTypeGroups,
  isValidRequestType,
  getRequestTypeName,
};
