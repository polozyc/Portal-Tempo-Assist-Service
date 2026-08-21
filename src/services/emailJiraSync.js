const { pool } = require("../db");
const { getUnreadEmails, markAsRead } = require("./emailProvider");
const { createServiceDeskRequest } = require("./jiraClient");

async function isAlreadyProcessed(messageId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM processed_emails WHERE message_id = $1",
    [messageId]
  );
  return rows.length > 0;
}

async function insertProcessed({ messageId, subject, senderEmail, jiraIssueKey, status, errorMessage }) {
  await pool.query(
    `INSERT INTO processed_emails (message_id, subject, sender_email, jira_issue_key, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [messageId, subject, senderEmail, jiraIssueKey || null, status, errorMessage || null]
  );
}

async function syncEmails() {
  console.log("[sync] Iniciando... buscando e-mails não lidos");
  const emails = await getUnreadEmails();
  console.log(`[sync] getUnreadEmails() retornou ${emails.length} e-mail(s)`);
  const results = [];

  for (const email of emails) {
    console.log(`[sync] Processando e-mail id=${email.id} assunto="${email.subject}"`);

    const alreadyDone = await isAlreadyProcessed(email.id);
    if (alreadyDone) {
      console.log(`[sync] id=${email.id} já processado antes, pulando`);
      continue;
    }

    const { subject, senderEmail, bodyText } = email;

    try {
      if (!senderEmail) {
        throw new Error("E-mail sem remetente identificável.");
      }

      console.log(`[sync] id=${email.id} chamando o Jira (remetente: ${senderEmail})...`);
      const jiraResponse = await createServiceDeskRequest({
        subject,
        body: bodyText,
        requesterEmail: senderEmail,
      });
      console.log(`[sync] id=${email.id} Jira respondeu OK`);

      const issueKey = jiraResponse.issueKey || jiraResponse.issueId;

      await insertProcessed({
        messageId: email.id,
        subject,
        senderEmail,
        jiraIssueKey: issueKey,
        status: "OK",
      });

      console.log(`[sync] id=${email.id} marcando como lido no e-mail de origem...`);
      await markAsRead(email.id);
      console.log(`[sync] id=${email.id} marcado como lido. Concluído: ${issueKey}`);

      results.push({ messageId: email.id, subject, senderEmail, issueKey, status: "OK" });
    } catch (err) {
      console.log(`[sync] id=${email.id} ERRO:`, err.message);
      const errorMessage = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;

      await insertProcessed({
        messageId: email.id,
        subject,
        senderEmail,
        jiraIssueKey: null,
        status: "ERROR",
        errorMessage,
      });

      // não marca como lido -> tentaremos de novo no próximo ciclo
      results.push({ messageId: email.id, subject, senderEmail, status: "ERROR", errorMessage });
    }
  }

  console.log(`[sync] Finalizado. ${results.length} e-mail(s) processado(s).`);
  return results;
}

module.exports = { syncEmails };
