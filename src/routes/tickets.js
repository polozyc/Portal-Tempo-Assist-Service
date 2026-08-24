const express = require("express");
const { body } = require("express-validator");

const { pool } = require("../db");
const {
  createServiceDeskRequest,
  getRequestTypeGroups,
  isValidRequestType,
  getRequestTypeName,
} = require("../services/jiraClient");
const { getApproverForDepartment, listDepartments, usersForRole, listAllApprovers } = require("../config/approvers");
const { detectApprovalNeed } = require("../services/approvalDetector");
const { validate } = require("../middleware/validate");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// ---------- POST /api/tickets/check-approval ----------
// Analisa o texto do chamado e informa se ele exige "de acordo".
// O formulário chama isso ANTES de enviar, para exibir o aviso.
router.post("/check-approval", (req, res) => {
  const { subject, description, requestTypeName } = req.body;

  const deteccao = detectApprovalNeed({ subject, description, requestTypeName });

  // Para cada papel exigido, quem pode aprovar.
  const aprovadoresPorPapel = deteccao.roles.map((role) => ({
    role,
    usuarios: usersForRole(role),
  }));

  res.json({
    ...deteccao,
    aprovadoresPorPapel,
    // Fallback: se algum papel não tem ninguém configurado, o formulário
    // oferece a lista completa para não travar o usuário.
    todosAprovadores: listAllApprovers(),
  });
});

// ---------- GET /api/tickets/approvers ----------
router.get("/approvers", (req, res) => {
  res.json({ approvers: listAllApprovers() });
});

// ---------- GET /api/tickets/departments ----------
// Setores que têm gestor aprovador configurado. O formulário usa isso para
// oferecer um select em vez de texto livre — assim o usuário não descobre
// que o setor é inválido só depois de enviar o chamado.
router.get("/departments", (req, res) => {
  res.json({ departments: listDepartments() });
});

// ---------- GET /api/tickets/request-types ----------
// Tipos de solicitação do Jira, agrupados pelas categorias do portal
// (Hardware, Sistemas, Software, Telecom...). Vem direto da API do Jira,
// então criar/renomear tipos lá reflete aqui sem mexer em código.
router.get(
  "/request-types",
  asyncHandler(async (req, res) => {
    try {
      const groups = await getRequestTypeGroups();
      res.json({ groups });
    } catch (err) {
      // Não derruba a tela de abertura de chamado: o formulário cai no
      // tipo padrão do .env quando a lista não carrega.
      console.error("[jira] falha ao buscar tipos de solicitação:", err.message);
      res.json({ groups: [], error: "Não foi possível carregar os tipos de solicitação." });
    }
  })
);

function buildDescription({ requesterName, department, description }) {
  return [
    requesterName ? `Solicitante: ${requesterName}` : null,
    department ? `Setor: ${department}` : null,
    "",
    description || "(sem descrição)",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const ticketValidation = [
  body("requesterEmail").isEmail().withMessage("Informe um e-mail válido.").normalizeEmail(),
  body("subject").isString().trim().notEmpty().withMessage("Informe o assunto.").isLength({ max: 250 }),
  body("requesterName").optional({ values: "falsy" }).isString().trim().isLength({ max: 150 }),
  body("department").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
  body("description").optional({ values: "falsy" }).isString().trim().isLength({ max: 5000 }),
  body("requiresApproval").optional().isBoolean().toBoolean(),
  body("requestTypeId").optional({ values: "falsy" }).isString().trim().isLength({ max: 20 }),
  body("approverUsername").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
];

// POST /api/tickets — abre um chamado.
// Com requiresApproval=true, fica pendente até o gestor do setor aprovar.
router.post(
  "/",
  ticketValidation,
  validate,
  asyncHandler(async (req, res) => {
    const {
      requesterEmail,
      requesterName,
      subject,
      description,
      department,
      requiresApproval,
      requestTypeId,
    } = req.body;

    // Valida o tipo contra o Jira: sem isso, um id inválido só estouraria
    // na hora de criar o chamado — e, no fluxo com aprovação, só depois
    // que o gestor já tivesse aprovado.
    //
    // Se o Jira estiver indisponível, seguimos em frente: um chamado
    // pendente nem chega a usar o Jira agora, e não faz sentido travar a
    // abertura por causa de uma validação que é apenas preventiva.
    let tipoId = requestTypeId || null;
    let tipoNome = null;

    if (tipoId) {
      try {
        if (!(await isValidRequestType(tipoId))) {
          throw new AppError(
            "Tipo de solicitação inválido. Recarregue a página e tente de novo.",
            400
          );
        }
        tipoNome = await getRequestTypeName(tipoId);
      } catch (err) {
        if (err instanceof AppError) throw err;
        console.warn(
          `[jira] não foi possível validar o tipo ${tipoId} (${err.message}). Seguindo sem validar.`
        );
      }
    }

    // ---------- Regras de "de acordo" obrigatorio ----------
    // A deteccao roda TAMBEM aqui, no servidor. O aviso no formulario e
    // apenas conveniencia: sem esta checagem, bastaria chamar a API
    // diretamente para furar a exigencia de aprovacao.
    const deteccao = detectApprovalNeed({
      subject,
      description,
      requestTypeName: tipoNome,
    });

    // Qualquer regra detectada torna o "de acordo" obrigatório — inclusive
    // as marcadas como "quando aplicável". A decisão é do algoritmo: não há
    // caminho para abrir o chamado sem aprovação depois que uma regra casa.
    if (deteccao.matches.length > 0 && !requiresApproval) {
      const assuntos = deteccao.matches.map((m) => m.label).join(", ");

      const erro = new AppError(
        `Este chamado exige "de acordo" antes de ir para a fila (${assuntos}). ` +
          `Selecione o aprovador para encaminhar a solicitação.`,
        400
      );
      erro.approvalRequired = deteccao;
      throw erro;
    }

    // ---------- Caminho COM aprovação ----------
    if (requiresApproval) {
      // O aprovador pode vir escolhido no formulario (regras por papel:
      // Gestor, Diretor TI, Superior...) ou ser deduzido do setor.
      let approver = null;

      if (req.body.approverUsername) {
        if (!listAllApprovers().includes(req.body.approverUsername)) {
          throw new AppError("O aprovador selecionado não é válido.", 400);
        }
        approver = req.body.approverUsername;
      } else {
        if (!department) {
          throw new AppError(
            "Informe o setor ou selecione um aprovador para solicitar o de acordo.",
            400
          );
        }
        approver = getApproverForDepartment(department);
      }

      if (!approver) {
        throw new AppError(
          `Não há gestor configurado para aprovar chamados do setor "${department}". Fale com o administrador do sistema.`,
          400
        );
      }

      const { rows } = await pool.query(
        `INSERT INTO tickets
           (requester_username, requester_name, requester_email, department, subject,
            description, requires_approval, status, approver_username,
            request_type_id, request_type_name, approval_reason)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'PENDING', $7, $8, $9, $10)
         RETURNING id`,
        [
          req.session.user,
          requesterName || null,
          requesterEmail,
          department || null,
          subject,
          description || null,
          approver,
          tipoId,
          tipoNome,
          deteccao.matches.map((m) => m.label).join(", ") || null,
        ]
      );

      console.log(`[ticket] pendente #${rows[0].id} criado por ${req.session.user} -> ${approver}`);

      const motivo = deteccao.matches.length
        ? ` Motivo: ${deteccao.matches.map((m) => m.label).join(", ")}.`
        : "";

      return res.status(201).json({
        pending: true,
        id: rows[0].id,
        approver,
        message: `Chamado enviado para o de acordo de "${approver}".${motivo} Só vai para a fila do Jira depois de aprovado.`,
      });
    }

    // ---------- Caminho SEM aprovação (direto pro Jira) ----------
    const jiraResponse = await createServiceDeskRequest({
      subject,
      body: buildDescription({ requesterName, department, description }),
      requesterEmail,
      requestTypeId: tipoId,
    });

    const issueKey = jiraResponse.issueKey || jiraResponse.issueId;
    const link = jiraResponse._links?.web || null;

    await pool.query(
      `INSERT INTO tickets
         (requester_username, requester_name, requester_email, department, subject,
          description, requires_approval, status, jira_issue_key, jira_link,
          request_type_id, request_type_name)
       VALUES ($1, $2, $3, $4, $5, $6, false, 'SENT', $7, $8, $9, $10)`,
      [
        req.session.user,
        requesterName || null,
        requesterEmail,
        department || null,
        subject,
        description || null,
        issueKey || null,
        link,
        tipoId,
        tipoNome,
      ]
    );

    console.log(`[ticket] ${issueKey} criado no Jira por ${req.session.user}`);

    res.status(201).json({
      pending: false,
      issueKey,
      link,
      message: "Chamado aberto com sucesso.",
    });
  })
);

module.exports = router;
