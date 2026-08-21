const { isProduction } = require("../config/env");

/**
 * Erro de aplicação com status HTTP e mensagem segura para exibir ao usuário.
 * Use isto para erros esperados (validação, permissão, "não encontrado").
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.isSafeToExpose = true;
  }
}

/**
 * Envolve handlers async para que exceções caiam no errorHandler
 * em vez de derrubar o processo com "unhandled rejection".
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Extrai uma mensagem útil de erros vindos do Jira (axios), sem
 * despejar o corpo inteiro da resposta no cliente.
 */
function describeJiraError(err) {
  const status = err.response?.status;
  const data = err.response?.data;

  if (status === 401 || status === 403) {
    return "Falha de autenticação com o Jira. Verifique as credenciais configuradas.";
  }
  if (status === 404) {
    return "Recurso não encontrado no Jira. Verifique o service desk e o tipo de solicitação configurados.";
  }
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return "O Jira demorou demais para responder. Tente novamente.";
  }

  const jiraMessage =
    data?.errorMessage ||
    (Array.isArray(data?.errorMessages) ? data.errorMessages[0] : null);

  return jiraMessage || "Não foi possível concluir a operação no Jira.";
}

function errorHandler(err, req, res, _next) {
  // Log completo do lado do servidor (com stack), sempre.
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err.message);
  if (!err.isSafeToExpose) {
    console.error(err.stack);
  }

  // Tipo de solicitação exige campos que o formulário não coleta.
  // A mensagem já explica o que fazer, então vai direto para o usuário.
  if (err.isFieldMismatch) {
    return res.status(400).json({ error: err.message });
  }

  // Erros do axios (Jira) recebem tradução amigável.
  if (err.isAxiosError) {
    return res.status(502).json({ error: describeJiraError(err) });
  }

  // Erros de aplicação já têm mensagem segura.
  if (err.isSafeToExpose) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  // Violação de unicidade no Postgres.
  if (err.code === "23505") {
    return res.status(409).json({ error: "Já existe um registro com esse valor único." });
  }

  // Qualquer outra coisa: mensagem genérica em produção para não vazar
  // detalhes de infraestrutura (nome de tabela, connection string, etc).
  return res.status(500).json({
    error: isProduction
      ? "Erro interno no servidor. Tente novamente ou contate o suporte."
      : `Erro interno: ${err.message}`,
  });
}

function notFoundHandler(req, res) {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Endpoint não encontrado." });
  }
  return res.status(404).send("Página não encontrada.");
}

module.exports = { AppError, asyncHandler, errorHandler, notFoundHandler };
