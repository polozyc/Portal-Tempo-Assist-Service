/**
 * Login geral: exige apenas estar autenticado (qualquer usuário do
 * diretório em src/config/users.js). Usado pela área de Chamados.
 */
function requireAuthApi(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: "Não autenticado. Faça login." });
}

function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect("/login.html");
}

/**
 * Acesso ao Inventário: exige login E a permissão específica
 * (inventoryAccess = true), que é definida por usuário no .env
 * (veja src/config/users.js). Usado pela área de Inventário.
 */
function requireInventoryAccessApi(req, res, next) {
  if (req.session && req.session.user && req.session.inventoryAccess) {
    return next();
  }
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Não autenticado. Faça login." });
  }
  return res.status(403).json({ error: "Seu usuário não tem acesso ao Inventário." });
}

function requireInventoryAccessPage(req, res, next) {
  if (req.session && req.session.user && req.session.inventoryAccess) {
    return next();
  }
  if (!req.session || !req.session.user) {
    return res.redirect("/login.html");
  }
  return res.redirect("/hub.html?semAcessoInventario=1");
}

/**
 * Acesso às Aprovações: exige login E ser um gestor mapeado como
 * aprovador de pelo menos um setor (veja src/config/approvers.js).
 */
function requireApproverAccessApi(req, res, next) {
  if (req.session && req.session.user && req.session.isApprover) {
    return next();
  }
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Não autenticado. Faça login." });
  }
  return res.status(403).json({ error: "Seu usuário não é aprovador de nenhum setor." });
}

function requireApproverAccessPage(req, res, next) {
  if (req.session && req.session.user && req.session.isApprover) {
    return next();
  }
  if (!req.session || !req.session.user) {
    return res.redirect("/login.html");
  }
  return res.redirect("/hub.html?semAcessoAprovacoes=1");
}

module.exports = {
  requireAuthApi,
  requireAuthPage,
  requireInventoryAccessApi,
  requireInventoryAccessPage,
  requireApproverAccessApi,
  requireApproverAccessPage,
};
