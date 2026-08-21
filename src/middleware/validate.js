const { validationResult } = require("express-validator");

/**
 * Converte os erros do express-validator em uma resposta 400 padronizada.
 * Colocado depois das regras de validação em cada rota.
 */
function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array();
  return res.status(400).json({
    error: errors[0].msg,
    details: errors.map((e) => ({ campo: e.path, mensagem: e.msg })),
  });
}

module.exports = { validate };
