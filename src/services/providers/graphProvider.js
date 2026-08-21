const {
  getUnreadEmails: graphGetUnread,
  markAsRead: graphMarkAsRead,
  htmlToPlainText,
} = require("../graphClient");

/**
 * Normaliza a resposta do Microsoft Graph para o formato padrão usado
 * pelo restante do sistema: { id, subject, senderEmail, bodyText }.
 */
async function getUnreadEmails() {
  const emails = await graphGetUnread();
  return emails.map((email) => ({
    id: email.id,
    subject: email.subject || "(sem assunto)",
    senderEmail: email.from?.emailAddress?.address || null,
    bodyText:
      email.body?.contentType === "html"
        ? htmlToPlainText(email.body.content)
        : email.body?.content || email.bodyPreview || "",
  }));
}

async function markAsRead(id) {
  return graphMarkAsRead(id);
}

module.exports = { getUnreadEmails, markAsRead };
