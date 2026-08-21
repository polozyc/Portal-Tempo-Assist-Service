const express = require("express");
const { body } = require("express-validator");

const { findUser } = require("../config/users");
const { isApproverUsername, departmentsForApprover } = require("../config/approvers");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// POST /api/login
router.post(
  "/login",
  [
    body("username").isString().trim().notEmpty().withMessage("Informe o usuário.").isLength({ max: 100 }),
    body("password").isString().notEmpty().withMessage("Informe a senha.").isLength({ max: 200 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    let user;
    try {
      user = await findUser(username, password);
    } catch (err) {
      // Falha de infraestrutura (AD fora do ar, conta de serviço inválida)
      // é diferente de senha errada: o usuário precisa saber que o problema
      // não é a credencial dele.
      console.error("[auth] falha ao validar credenciais:", err.message);
      return res.status(503).json({
        error: "Não foi possível validar suas credenciais no momento. Tente novamente em instantes.",
      });
    }

    if (!user) {
      // Mensagem genérica de propósito: não revela se o usuário existe.
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    // No modo LDAP, ser aprovador pode vir dos grupos do AD (ldapRoles);
    // no modo local, vem do mapeamento do .env.
    const isApprover =
      (Array.isArray(user.ldapRoles) && user.ldapRoles.length > 0) ||
      isApproverUsername(user.username);

    // Regenera a sessão no login para evitar session fixation: se um
    // atacante conseguiu fixar um ID de sessão antes do login, esse ID
    // deixa de valer no momento em que o usuário se autentica.
    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );

    req.session.user = user.username;
    req.session.displayName = user.displayName || user.username;
    req.session.email = user.email || null;
    req.session.inventoryAccess = user.inventoryAccess;
    req.session.isApprover = isApprover;
    req.session.ldapRoles = user.ldapRoles || [];
    req.session.loginAt = new Date().toISOString();

    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );

    console.log(`[auth] login: ${user.username}`);

    res.json({
      ok: true,
      username: user.username,
      displayName: user.displayName || user.username,
      email: user.email || null,
      inventoryAccess: user.inventoryAccess,
      isApprover,
    });
  })
);

// POST /api/logout
router.post("/logout", (req, res) => {
  const username = req.session?.user;
  req.session.destroy(() => {
    res.clearCookie("tempoassist.sid");
    if (username) console.log(`[auth] logout: ${username}`);
    res.json({ ok: true });
  });
});

// GET /api/me — o frontend usa para saber quem está logado e o que pode acessar
router.get("/me", (req, res) => {
  if (req.session?.user) {
    return res.json({
      authenticated: true,
      username: req.session.user,
      displayName: req.session.displayName || req.session.user,
      email: req.session.email || null,
      inventoryAccess: !!req.session.inventoryAccess,
      isApprover: !!req.session.isApprover,
      approverDepartments: req.session.isApprover
        ? departmentsForApprover(req.session.user)
        : [],
    });
  }
  return res.json({ authenticated: false });
});

module.exports = router;
