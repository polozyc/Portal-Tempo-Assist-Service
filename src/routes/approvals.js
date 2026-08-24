const express = require("express");
const { body, param, query } = require("express-validator");

const { pool } = require("../db");
const { createServiceDeskRequest } = require("../services/jiraClient");
const { validate } = require("../middleware/validate");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

/**
 * Acrescenta o registro do "de acordo" ao chamado.
 *
 * A descrição que chega aqui já traz solicitante e setor — repeti-los
 * neste cabeçalho deixava a mesma informação duas vezes no chamado.
 */
function buildDescription({ description, approver, decisionNotes }) {
  return [
    `De acordo: ${approver} em ${new Date().toLocaleString("pt-BR")}`,
    decisionNotes ? `Observação do gestor: ${decisionNotes}` : null,
    "",
    description || "(sem descrição)",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Busca um chamado pendente garantindo que ele pertence ao gestor logado.
 * Centralizado aqui para que aprovar e rejeitar apliquem exatamente a
 * mesma checagem de permissão.
 */
async function findPendingTicketForApprover(client, id, approverUsername) {
  const { rows } = await client.query(
    `SELECT * FROM tickets WHERE id = $1 FOR UPDATE`,
    [id]
  );
  const ticket = rows[0];

  if (!ticket) throw new AppError("Chamado não encontrado.", 404);
  if (ticket.approver_username !== approverUsername) {
    throw new AppError("Você não é o gestor responsável por este chamado.", 403);
  }
  if (ticket.status !== "PENDING") {
    throw new AppError(
      `Este chamado já foi ${ticket.status === "APPROVED" ? "aprovado" : "decidido"} anteriormente.`,
      409
    );
  }
  return ticket;
}

// ---------- GET /api/approvals — pendentes deste gestor ----------
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM tickets
       WHERE approver_username = $1 AND status = 'PENDING'
       ORDER BY created_at ASC`,
      [req.session.user]
    );
    res.json(rows);
  })
);

// ---------- GET /api/approvals/history — decisões já tomadas ----------
router.get(
  "/history",
  [query("limit").optional().isInt({ min: 1, max: 200 }).toInt()],
  validate,
  asyncHandler(async (req, res) => {
    const limit = req.query.limit || 100;
    const { rows } = await pool.query(
      `SELECT * FROM tickets
       WHERE approver_username = $1 AND status IN ('APPROVED', 'REJECTED')
       ORDER BY decided_at DESC
       LIMIT $2`,
      [req.session.user, limit]
    );
    res.json(rows);
  })
);

// ---------- POST /api/approvals/:id/approve ----------
router.post(
  "/:id/approve",
  [
    param("id").isInt({ min: 1 }).withMessage("ID inválido.").toInt(),
    // A observacao do gestor e OBRIGATORIA na aprovacao: ela registra a
    // justificativa do "de acordo" e vai junto para o chamado no Jira,
    // servindo de trilha de auditoria.
    body("notes")
      .trim()
      .notEmpty()
      .withMessage("Descreva a justificativa para autorizar este chamado.")
      .bail()
      .isLength({ min: 5, max: 2000 })
      .withMessage("A justificativa precisa ter entre 5 e 2000 caracteres."),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { notes } = req.body;
    const client = await pool.connect();

    let ticket;
    try {
      await client.query("BEGIN");
      ticket = await findPendingTicketForApprover(client, req.params.id, req.session.user);

      // Marca como aprovado ANTES de chamar o Jira e faz commit, para que
      // dois cliques simultâneos no botão não gerem dois chamados no Jira
      // (o segundo encontra status != PENDING e é recusado).
      await client.query(
        `UPDATE tickets
         SET status = 'APPROVED', decision_notes = $1, decided_at = now()
         WHERE id = $2`,
        [notes, ticket.id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw err;
    }
    client.release();

    // Agora cria no Jira. Se falhar, o chamado fica APPROVED sem issue —
    // registramos o erro no próprio chamado para não ficar invisível.
    try {
      const jiraResponse = await createServiceDeskRequest({
        subject: ticket.subject,
        body: buildDescription({
          description: ticket.description,
          approver: req.session.user,
          decisionNotes: notes,
        }),
        requesterEmail: ticket.requester_email,
        // Respeita a categoria escolhida por quem abriu o chamado.
        // Sem isso, todo chamado aprovado cairia no tipo padrão do .env.
        requestTypeId: ticket.request_type_id || null,
      });

      const issueKey = jiraResponse.issueKey || jiraResponse.issueId;
      const link = jiraResponse._links?.web || null;

      await pool.query(
        `UPDATE tickets SET jira_issue_key = $1, jira_link = $2, sync_error = NULL WHERE id = $3`,
        [issueKey || null, link, ticket.id]
      );

      console.log(`[aprovação] #${ticket.id} aprovado por ${req.session.user} -> ${issueKey}`);

      res.json({ ok: true, issueKey, link, message: "Chamado aprovado e enviado ao Jira." });
    } catch (err) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).slice(0, 500)
        : err.message;

      await pool.query(`UPDATE tickets SET sync_error = $1 WHERE id = $2`, [detail, ticket.id]);

      console.error(`[aprovação] #${ticket.id} aprovado mas FALHOU no Jira:`, detail);
      throw err; // errorHandler traduz o erro do Jira para o usuário
    }
  })
);

// ---------- POST /api/approvals/:id/reject ----------
router.post(
  "/:id/reject",
  [
    param("id").isInt({ min: 1 }).withMessage("ID inválido.").toInt(),
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("Informe o motivo da rejeição.")
      .bail()
      .isLength({ min: 5, max: 2000 })
      .withMessage("O motivo precisa ter entre 5 e 2000 caracteres."),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ticket = await findPendingTicketForApprover(client, req.params.id, req.session.user);

      await client.query(
        `UPDATE tickets
         SET status = 'REJECTED', decision_notes = $1, decided_at = now()
         WHERE id = $2`,
        [req.body.reason, ticket.id]
      );

      await client.query("COMMIT");

      console.log(`[aprovação] #${ticket.id} rejeitado por ${req.session.user}`);
      res.json({ ok: true, message: "Chamado rejeitado." });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

module.exports = router;
