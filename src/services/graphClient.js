const axios = require("axios");

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Autentica via client credentials flow (app-only) no Azure AD.
 * Requer permissão de aplicativo "Mail.Read" (ou "Mail.ReadWrite" p/ marcar como lido)
 * com consentimento de administrador no Azure AD.
 */
async function getGraphToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error("Variáveis MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET não configuradas.");
  }

  const url = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const { data } = await axios.post(url, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Busca e-mails não lidos na caixa do service desk (MS_MAILBOX).
 * Retorna os campos mínimos necessários: assunto, remetente, corpo e id.
 */
async function getUnreadEmails() {
  const token = await getGraphToken();
  const mailbox = process.env.MS_MAILBOX;

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}` +
    `/mailFolders/Inbox/messages` +
    `?$filter=isRead eq false` +
    `&$select=id,subject,from,body,bodyPreview,receivedDateTime` +
    `&$top=25` +
    `&$orderby=receivedDateTime asc`;

  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return data.value || [];
}

/** Marca o e-mail como lido para não ser processado de novo. */
async function markAsRead(messageId) {
  const token = await getGraphToken();
  const mailbox = process.env.MS_MAILBOX;
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}`;

  await axios.patch(
    url,
    { isRead: true },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/** Converte o corpo do e-mail (HTML) em texto simples para o Jira. */
function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { getUnreadEmails, markAsRead, htmlToPlainText };
