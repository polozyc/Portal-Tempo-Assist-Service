const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

/**
 * Provedor genérico via IMAP. Serve para testar a automação usando o Gmail
 * (com "senha de app") sem depender de registro de aplicativo no Azure AD.
 * Também funciona com qualquer outro provedor que exponha IMAP.
 */
function buildClient() {
  const host = process.env.IMAP_HOST;
  const port = Number(process.env.IMAP_PORT || 993);
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;

  if (!host || !user || !pass) {
    throw new Error(
      "Variáveis IMAP_HOST / IMAP_USER / IMAP_PASSWORD não configuradas no .env."
    );
  }

  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15000, // 15s para conectar, senão desiste com erro claro
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

async function withConnection(fn) {
  const client = buildClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function getUnreadEmails() {
  const maxEmails = Number(process.env.MAX_EMAILS_PER_SYNC || 25);

  return withConnection(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    const results = [];
    try {
      const allUids = await client.search({ seen: false });

      // Pega só os mais recentes (UIDs mais altos = e-mails mais novos),
      // pra não tentar processar uma caixa com milhares de não lidos de uma vez.
      const uids = allUids.slice(-maxEmails);

      for (const uid of uids) {
        const message = await client.fetchOne(uid, { source: true });
        if (!message) continue;

        const parsed = await simpleParser(message.source);

        results.push({
          id: String(uid), // usamos o UID como identificador único da mensagem
          subject: parsed.subject || "(sem assunto)",
          senderEmail: parsed.from?.value?.[0]?.address || null,
          bodyText: (parsed.text || "").trim() || (parsed.html || ""),
        });
      }
    } finally {
      lock.release();
    }
    return results;
  });
}

async function markAsRead(uid) {
  return withConnection(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(Number(uid), ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  });
}

module.exports = { getUnreadEmails, markAsRead };
