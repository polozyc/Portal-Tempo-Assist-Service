// EMAIL_PROVIDER=graph  -> Microsoft Graph / Outlook (produção)
// EMAIL_PROVIDER=imap   -> IMAP genérico (ex: Gmail com senha de app, para testes)
const provider = (process.env.EMAIL_PROVIDER || "graph").toLowerCase();

const providers = {
  graph: () => require("./providers/graphProvider"),
  imap: () => require("./providers/imapProvider"),
};

if (!providers[provider]) {
  throw new Error(
    `EMAIL_PROVIDER inválido: "${provider}". Use "graph" ou "imap".`
  );
}

module.exports = providers[provider]();
