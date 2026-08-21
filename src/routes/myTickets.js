const express = require("express");
const { query } = require("express-validator");

const { pool } = require("../db");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// ---------- GET /api/my-tickets ----------
// Chamados abertos pelo próprio usuário logado. O filtro por
// requester_username é o que garante que ninguém veja chamado de outra
// pessoa — não existe parâmetro que permita consultar outro usuário.
router.get(
  "/",
  [
    query("status").optional({ values: "falsy" }).isIn(["PENDING", "APPROVED", "REJECTED", "SENT"]),
    query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const params = [req.session.user];
    let where = "requester_username = $1";

    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND status = $${params.length}`;
    }

    params.push(req.query.limit || 100);

    const { rows } = await pool.query(
      `SELECT id, subject, department, status, requires_approval, approver_username,
              decision_notes, jira_issue_key, jira_link, decided_at, created_at
       FROM tickets
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(rows);
  })
);

module.exports = router;
