const express = require("express");
const { body, param, query } = require("express-validator");

const { pool } = require("../db");
const { validate } = require("../middleware/validate");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// ---------- GET /api/inventory/items ----------
router.get(
  "/items",
  [
    query("status").optional({ values: "falsy" }).isIn(["IN_STOCK", "CHECKED_OUT"]),
    query("q").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { status, q } = req.query;
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conditions.push(`(name ILIKE $${i} OR barcode ILIKE $${i} OR serial_number ILIKE $${i})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(`SELECT * FROM items ${where} ORDER BY name ASC`, params);
    res.json(rows);
  })
);

// ---------- POST /api/inventory/items ----------
router.post(
  "/items",
  [
    body("barcode").isString().trim().notEmpty().withMessage("Informe o código de barras.").isLength({ max: 100 }),
    body("name").isString().trim().notEmpty().withMessage("Informe o nome do equipamento.").isLength({ max: 200 }),
    body("category").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
    body("serial_number").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
    body("location").optional({ values: "falsy" }).isString().trim().isLength({ max: 150 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { barcode, name, category, serial_number, location } = req.body;

    // Violação de unicidade (código 23505) é tratada no errorHandler central,
    // mas damos aqui uma mensagem mais específica para este caso.
    const existing = await pool.query("SELECT 1 FROM items WHERE barcode = $1", [barcode]);
    if (existing.rowCount) {
      throw new AppError("Já existe um item cadastrado com esse código de barras.", 409);
    }

    const { rows } = await pool.query(
      `INSERT INTO items (barcode, name, category, serial_number, location, status)
       VALUES ($1, $2, $3, $4, $5, 'IN_STOCK')
       RETURNING *`,
      [barcode, name, category || null, serial_number || null, location || null]
    );

    console.log(`[inventário] item "${name}" (${barcode}) cadastrado por ${req.session.user}`);
    res.status(201).json(rows[0]);
  })
);

// ---------- GET /api/inventory/items/:barcode ----------
router.get(
  "/items/:barcode",
  [param("barcode").isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM items WHERE barcode = $1", [
      req.params.barcode,
    ]);
    if (!rows[0]) throw new AppError("Item não encontrado.", 404);
    res.json(rows[0]);
  })
);

// ---------- POST /api/inventory/scan ----------
// Registra entrada/saída. A leitura + atualização + inserção do histórico
// acontecem numa transação com FOR UPDATE, evitando que dois scanners
// simultâneos gerem estado inconsistente no mesmo item.
router.post(
  "/scan",
  [
    body("barcode").isString().trim().notEmpty().withMessage("Informe o código de barras."),
    body("action").isIn(["IN", "OUT"]).withMessage("Ação deve ser IN (entrada) ou OUT (saída)."),
    body("person").optional({ values: "falsy" }).isString().trim().isLength({ max: 150 }),
    body("ticket_number").optional({ values: "falsy" }).isString().trim().isLength({ max: 50 }),
    body("department").optional({ values: "falsy" }).isString().trim().isLength({ max: 100 }),
    body("requester").optional({ values: "falsy" }).isString().trim().isLength({ max: 150 }),
    body("notes").optional({ values: "falsy" }).isString().trim().isLength({ max: 1000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { barcode, action, person, notes, ticket_number, department, requester } = req.body;

    if (action === "OUT" && !requester) {
      throw new AppError("Informe quem solicitou o equipamento.", 400);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // FOR UPDATE trava a linha até o fim da transação.
      const { rows: itemRows } = await client.query(
        "SELECT * FROM items WHERE barcode = $1 FOR UPDATE",
        [barcode]
      );
      const item = itemRows[0];

      if (!item) {
        throw new AppError("Item não cadastrado. Cadastre-o antes de movimentar.", 404);
      }
      if (action === "OUT" && item.status === "CHECKED_OUT") {
        throw new AppError(
          `"${item.name}" já está com saída registrada${item.current_requester ? ` para ${item.current_requester}` : ""}.`,
          409
        );
      }
      if (action === "IN" && item.status === "IN_STOCK") {
        throw new AppError(`"${item.name}" já consta em estoque.`, 409);
      }

      const isOut = action === "OUT";

      const { rows: updated } = await client.query(
        `UPDATE items
         SET status = $1, current_ticket = $2, current_department = $3, current_requester = $4
         WHERE id = $5
         RETURNING *`,
        [
          isOut ? "CHECKED_OUT" : "IN_STOCK",
          isOut ? ticket_number || null : null,
          isOut ? department || null : null,
          isOut ? requester || null : null,
          item.id,
        ]
      );

      await client.query(
        `INSERT INTO movements
           (item_id, action, person, ticket_number, department, requester, notes, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          item.id,
          action,
          person || null,
          ticket_number || null,
          department || null,
          requester || null,
          notes || null,
          req.session.user,
        ]
      );

      await client.query("COMMIT");

      console.log(`[inventário] ${action} de "${item.name}" registrado por ${req.session.user}`);

      res.json({
        item: updated[0],
        message: `${isOut ? "Saída" : "Entrada"} registrada com sucesso.`,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

// ---------- GET /api/inventory/movements ----------
router.get(
  "/movements",
  [
    query("limit").optional().isInt({ min: 1, max: 500 }).toInt(),
    query("offset").optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;

    const { rows } = await pool.query(
      `SELECT m.*, i.name AS item_name, i.barcode
       FROM movements m
       JOIN items i ON i.id = m.item_id
       ORDER BY m.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS total FROM movements");

    res.json({ movements: rows, total: countRows[0].total, limit, offset });
  })
);

module.exports = router;
