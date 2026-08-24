const { pool } = require("../db");
const { getUnreadEmails, markAsRead } = require("./emailProvider");
const { createServiceDeskRequest, getRequestTypeGroups } = require("./jiraClient");
const { analisarEmail, isAiEnabled } = require("./aiAgent");
const { detectApprovalNeed } = require("./approvalDetector");
const { APPROVAL_RULES } = require("../config/approvalRules");
const { usersForRole, listAllApprovers } = require("../config/approvers");

async function isAlreadyProcessed(messageId) {
  const { rows } = await pool.query("SELECT 1 FROM processed_emails WHERE message_id = $1", [
    messageId,
  ]);
  return rows.length > 0;
}

async function insertProcessed({
  messageId,
  subject,
  senderEmail,
  jiraIssueKey,
  status,
  errorMessage,
  agentDecision,
}) {
  await pool.query(
    `INSERT INTO processed_emails
       (message_id, subject, sender_email, jira_issue_key, status, error_message, agent_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      messageId,
      subject,
      senderEmail,
      jiraIssueKey || null,
      status,
      errorMessage || null,
      agentDecision ? JSON.stringify(agentDecision) : null,
    ]
  );
}

/**
 * Triagem sem IA — usado quando AI_API_KEY não está configurada ou quando
 * o modelo falha. Mantém o sistema funcionando com as regras de sempre,
 * em vez de deixar o e-mail sem tratamento.
 */
function triagemPorRegras(email) {
  const deteccao = detectApprovalNeed({
    subject: email.subject,
    description: email.bodyText,
  });

  return {
    categoria: deteccao.intent === "incidente" ? "incidente" : "solicitacao",
    tipoSolicitacaoId: null,
    tipoSolicitacaoNome: null,
    titulo: email.subject,
    descricao: email.bodyText,
    urgencia: "media",
    precisaAprovacao: deteccao.matches.length > 0,
    regraAprovacao: deteccao.matches.map((m) => m.label).join(", ") || null,
    papelAprovador: deteccao.roles[0] || null,
    precisaMaisInfo: false,
    perguntaAoSolicitante: null,
    raciocinio: "Triagem por regras (agente de IA indisponível).",
    provedor: "regras",
  };
}

/**
 * Escolhe quem vai aprovar, a partir do papel decidido pelo agente.
 *
 * Tenta, em ordem: quem exerce o papel exato, depois qualquer aprovador
 * cadastrado. Nunca devolve null "desistindo" — se não houver ninguém,
 * quem chama trata como erro, porque abrir o chamado sem o de acordo
 * furaria a política da empresa justamente nos casos mais sensíveis
 * (criação de acesso, liberação de USB, reset de SAP).
 */
function escolherAprovador(decisao) {
  if (decisao.papelAprovador) {
    const candidatos = usersForRole(decisao.papelAprovador);
    if (candidatos.length) return candidatos[0];
  }

  // Papel sem ninguém mapeado: usa qualquer aprovador configurado, para
  // que a solicitação ao menos chegue a um humano.
  const qualquer = listAllApprovers();
  if (qualquer.length) {
    console.warn(
      `[sync] nenhum usuário mapeado para o papel "${decisao.papelAprovador}". ` +
        `Encaminhando para "${qualquer[0]}". Ajuste APPROVAL_ROLES no .env.`
    );
    return qualquer[0];
  }

  return null;
}

/** Monta o corpo do chamado incluindo o que o agente concluiu. */
function montarDescricao({ email, decisao }) {
  return [
    `Solicitante: ${email.senderEmail}`,
    `Recebido por e-mail e triado automaticamente pelo agente de IA.`,
    ``,
    decisao.descricao || email.bodyText,
    ``,
    `--- Análise do agente ---`,
    `Categoria: ${decisao.categoria}`,
    `Urgência: ${decisao.urgencia}`,
    decisao.tipoSolicitacaoNome ? `Tipo identificado: ${decisao.tipoSolicitacaoNome}` : null,
    decisao.regraAprovacao ? `Exige de acordo: ${decisao.regraAprovacao}` : null,
    `Raciocínio: ${decisao.raciocinio}`,
    ``,
    `--- Mensagem original ---`,
    email.bodyText,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function syncEmails() {
  console.log("[sync] Iniciando... buscando e-mails não lidos");
  const emails = await getUnreadEmails();
  console.log(`[sync] ${emails.length} e-mail(s) para processar`);

  const results = [];
  if (!emails.length) return results;

  // Contexto do agente: tipos reais do Jira e a tabela de aprovações.
  // Buscamos uma vez só, fora do laço.
  let tiposDisponiveis = [];
  if (isAiEnabled()) {
    try {
      tiposDisponiveis = await getRequestTypeGroups();
    } catch (err) {
      console.warn(`[sync] não foi possível carregar os tipos do Jira: ${err.message}`);
    }
  }

  const regrasAprovacao = APPROVAL_RULES.map((r) => ({ label: r.label, roles: r.roles }));

  for (const email of emails) {
    console.log(`[sync] e-mail id=${email.id} — "${email.subject}"`);

    if (await isAlreadyProcessed(email.id)) {
      console.log(`[sync] id=${email.id} já processado, pulando`);
      continue;
    }

    let decisao = null;

    try {
      if (!email.senderEmail) {
        throw new Error("E-mail sem remetente identificável.");
      }

      // ---------- 1. O agente analisa e decide ----------
      if (isAiEnabled()) {
        try {
          decisao = await analisarEmail({ email, tiposDisponiveis, regrasAprovacao });
        } catch (err) {
          console.warn(`[sync] agente de IA falhou (${err.message}). Usando regras.`);
          decisao = triagemPorRegras(email);
        }
      } else {
        decisao = triagemPorRegras(email);
      }

      // ---------- 2. Falta informação: não abre chamado incompleto ----------
      if (decisao.precisaMaisInfo) {
        console.log(`[sync] id=${email.id} sem informação suficiente — aguardando retorno.`);
        await insertProcessed({
          messageId: email.id,
          subject: email.subject,
          senderEmail: email.senderEmail,
          status: "NEEDS_INFO",
          errorMessage: decisao.perguntaAoSolicitante || "Informações insuficientes.",
          agentDecision: decisao,
        });
        await markAsRead(email.id);

        results.push({
          messageId: email.id,
          subject: email.subject,
          status: "NEEDS_INFO",
          pergunta: decisao.perguntaAoSolicitante,
          raciocinio: decisao.raciocinio,
        });
        continue;
      }

      // ---------- 3. Exige "de acordo": vai para a fila de aprovação ----------
      if (decisao.precisaAprovacao) {
        const aprovador = escolherAprovador(decisao);

        if (aprovador) {
          const { rows } = await pool.query(
            `INSERT INTO tickets
               (requester_username, requester_name, requester_email, department, subject,
                description, requires_approval, status, approver_username,
                request_type_id, request_type_name, approval_reason)
             VALUES ($1, $2, $3, $4, $5, $6, true, 'PENDING', $7, $8, $9, $10)
             RETURNING id`,
            [
              email.senderEmail,
              email.senderEmail,
              email.senderEmail,
              null,
              decisao.titulo,
              decisao.descricao || email.bodyText,
              aprovador,
              decisao.tipoSolicitacaoId,
              decisao.tipoSolicitacaoNome,
              decisao.regraAprovacao,
            ]
          );

          console.log(
            `[sync] id=${email.id} encaminhado para aprovação de "${aprovador}" (#${rows[0].id})`
          );

          await insertProcessed({
            messageId: email.id,
            subject: email.subject,
            senderEmail: email.senderEmail,
            status: "PENDING_APPROVAL",
            agentDecision: decisao,
          });
          await markAsRead(email.id);

          results.push({
            messageId: email.id,
            subject: email.subject,
            status: "PENDING_APPROVAL",
            aprovador,
            regra: decisao.regraAprovacao,
            raciocinio: decisao.raciocinio,
          });
          continue;
        }

        // Sem nenhum aprovador cadastrado no sistema: não abrimos o
        // chamado. Prosseguir aqui significaria colocar na fila do Jira uma
        // solicitação que a política exige que passe por aprovação.
        throw new Error(
          `Este chamado exige "de acordo" (${decisao.regraAprovacao || decisao.papelAprovador}), ` +
            `mas não há nenhum aprovador configurado. Configure APPROVAL_ROLES no .env.`
        );
      }

      // ---------- 4. Abre o chamado no Jira ----------
      const jiraResponse = await createServiceDeskRequest({
        subject: decisao.titulo,
        body: montarDescricao({ email, decisao }),
        requesterEmail: email.senderEmail,
        requestTypeId: decisao.tipoSolicitacaoId || null,
      });

      const issueKey = jiraResponse.issueKey || jiraResponse.issueId;

      await insertProcessed({
        messageId: email.id,
        subject: email.subject,
        senderEmail: email.senderEmail,
        jiraIssueKey: issueKey,
        status: "OK",
        agentDecision: decisao,
      });
      await markAsRead(email.id);

      console.log(`[sync] id=${email.id} -> ${issueKey}`);

      results.push({
        messageId: email.id,
        subject: email.subject,
        senderEmail: email.senderEmail,
        issueKey,
        status: "OK",
        categoria: decisao.categoria,
        urgencia: decisao.urgencia,
        raciocinio: decisao.raciocinio,
      });
    } catch (err) {
      const errorMessage = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[sync] id=${email.id} ERRO: ${errorMessage}`);

      await insertProcessed({
        messageId: email.id,
        subject: email.subject,
        senderEmail: email.senderEmail,
        status: "ERROR",
        errorMessage,
        agentDecision: decisao,
      });

      // Não marca como lido: tenta de novo no próximo ciclo.
      results.push({
        messageId: email.id,
        subject: email.subject,
        status: "ERROR",
        errorMessage,
      });
    }
  }

  console.log(`[sync] Finalizado. ${results.length} e-mail(s) processado(s).`);
  return results;
}

module.exports = { syncEmails, triagemPorRegras, montarDescricao };
