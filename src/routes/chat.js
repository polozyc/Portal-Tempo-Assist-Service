const express = require("express");
const { body } = require("express-validator");

const { pool } = require("../db");
const { conversar, isAiEnabled } = require("../services/aiAgent");
const { createServiceDeskRequest, getRequestTypeGroups, anexarArquivos } = require("../services/jiraClient");
const { APPROVAL_RULES } = require("../config/approvalRules");
const { usersForRole, listAllApprovers, listApproversDetailed } = require("../config/approvers");
const { validate } = require("../middleware/validate");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

const multer = require("multer");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

// Arquivos ficam em disco temporário até o chamado ser criado. Guardá-los
// em memória arriscaria estourar a RAM do servidor com poucos uploads.
const LIMITE_ARQUIVOS = 5;
const LIMITE_BYTES = 10 * 1024 * 1024; // 10 MB por arquivo

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const seguro = crypto.randomBytes(8).toString("hex");
      cb(null, `tino-${seguro}${path.extname(file.originalname).slice(0, 10)}`);
    },
  }),
  limits: { fileSize: LIMITE_BYTES, files: LIMITE_ARQUIVOS },
  fileFilter: (req, file, cb) => {
    // Executáveis e scripts não têm por que virar anexo de chamado, e
    // aceitar esses formatos transformaria o service desk num vetor de
    // distribuição de arquivo malicioso.
    const proibidos = /\.(exe|bat|cmd|com|scr|msi|ps1|vbs|js|jar|sh)$/i;
    if (proibidos.test(file.originalname)) {
      return cb(new Error(`Arquivos do tipo "${path.extname(file.originalname)}" não são aceitos.`));
    }
    cb(null, true);
  },
});

/** Remove do disco os arquivos de uma conversa. */
function limparArquivos(lista) {
  for (const arq of lista || []) {
    fs.unlink(arq.path, () => {});
  }
}

const MAX_TURNOS = 40; // limite de segurança para conversas muito longas

const regrasAprovacao = APPROVAL_RULES.map((r) => ({ label: r.label, roles: r.roles }));

/** Contexto do Jira, com cache de 10 min feito pelo próprio jiraClient. */
async function carregarTipos() {
  try {
    return await getRequestTypeGroups();
  } catch (err) {
    console.warn(`[chat] tipos do Jira indisponíveis: ${err.message}`);
    return [];
  }
}

/**
 * Escolhe o aprovador para o papel decidido pelo agente.
 * Cai para qualquer aprovador cadastrado se o papel não tiver ninguém —
 * melhor chegar a um humano do que abrir sem o "de acordo".
 */
function escolherAprovador(papel) {
  if (papel) {
    const candidatos = usersForRole(papel);
    if (candidatos.length) return candidatos[0];
  }
  const qualquer = listAllApprovers();
  return qualquer.length ? qualquer[0] : null;
}

// ---------- GET /api/chat ----------
// Estado atual da conversa (para restaurar ao recarregar a página).
router.get("/", (req, res) => {
  res.json({
    disponivel: isAiEnabled(),
    historico: req.session.chatHistorico || [],
    arquivos: (req.session.chatAnexos || []).map((a) => ({
      nome: a.originalname,
      tamanho: a.size,
    })),
  });
});

// ---------- DELETE /api/chat ----------
// Recomeça a conversa do zero.
router.delete("/", (req, res) => {
  limparArquivos(req.session.chatAnexos);
  req.session.chatAnexos = [];
  req.session.chatHistorico = [];
  res.json({ ok: true });
});

// ---------- POST /api/chat/anexo ----------
// Guarda os arquivos junto da conversa; eles só sobem para o Jira quando
// o chamado é criado.
router.post("/anexo", (req, res) => {
  upload.array("arquivos", LIMITE_ARQUIVOS)(req, res, (err) => {
    if (err) {
      const mensagem =
        err.code === "LIMIT_FILE_SIZE"
          ? "Cada arquivo pode ter no máximo 10 MB."
          : err.code === "LIMIT_FILE_COUNT"
          ? `No máximo ${LIMITE_ARQUIVOS} arquivos por chamado.`
          : err.message;
      return res.status(400).json({ error: mensagem });
    }

    const atuais = req.session.chatAnexos || [];
    const novos = (req.files || []).map((f) => ({
      path: f.path,
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
    }));

    if (atuais.length + novos.length > LIMITE_ARQUIVOS) {
      limparArquivos(novos);
      return res
        .status(400)
        .json({ error: `No máximo ${LIMITE_ARQUIVOS} arquivos por chamado.` });
    }

    req.session.chatAnexos = [...atuais, ...novos];

    res.json({
      arquivos: req.session.chatAnexos.map((a) => ({
        nome: a.originalname,
        tamanho: a.size,
      })),
    });
  });
});

// ---------- DELETE /api/chat/anexo/:indice ----------
router.delete("/anexo/:indice", (req, res) => {
  const lista = req.session.chatAnexos || [];
  const i = Number(req.params.indice);

  if (Number.isInteger(i) && lista[i]) {
    limparArquivos([lista[i]]);
    lista.splice(i, 1);
    req.session.chatAnexos = lista;
  }

  res.json({ arquivos: lista.map((a) => ({ nome: a.originalname, tamanho: a.size })) });
});

// ---------- POST /api/chat ----------
router.post(
  "/",
  [body("mensagem").trim().notEmpty().withMessage("Escreva sua mensagem.").isLength({ max: 2000 })],
  validate,
  asyncHandler(async (req, res) => {
    if (!isAiEnabled()) {
      throw new AppError(
        "O assistente não está disponível no momento. Use o formulário de abertura de chamado.",
        503
      );
    }

    const historico = req.session.chatHistorico || [];

    if (historico.length >= MAX_TURNOS) {
      throw new AppError(
        "Esta conversa ficou muito longa. Comece uma nova para continuar.",
        400
      );
    }

    historico.push({ autor: "usuario", texto: req.body.mensagem });

    const tiposDisponiveis = await carregarTipos();

    let turno;
    try {
      turno = await conversar({
        historico,
        tiposDisponiveis,
        regrasAprovacao,
        usuario: req.session.displayName || req.session.user,
        // O portal já sabe quem está logado: o agente não precisa
        // perguntar nome e e-mail de novo. Com o AD, o setor também vem.
        dadosConhecidos: {
          nome: req.session.displayName || req.session.user,
          email: req.session.email || null,
          setor: req.session.setor || null,
        },
        // Sem isso o agente pediria "manda um print" para algo que a
        // pessoa já anexou.
        anexos: (req.session.chatAnexos || []).map((a) => a.originalname),
      });
    } catch (err) {
      // O agente tentou abrir sem os dados obrigatórios. Para a pessoa,
      // isso vira apenas mais uma pergunta na conversa.
      if (String(err.message).startsWith("FALTAM_DADOS:")) {
        const faltando = err.message.replace("FALTAM_DADOS:", "");
        const pedido = `Antes de abrir, preciso confirmar: ${faltando}. Pode me passar?`;

        historico.push({ autor: "agente", texto: pedido });
        req.session.chatHistorico = historico;
        console.warn(`[chat] abertura barrada — faltavam: ${faltando}`);
        return res.json({ mensagem: pedido, chamadoAberto: false });
      }

      // Remove a mensagem do usuário para ele poder tentar de novo sem
      // que a conversa fique com um turno "órfão".
      historico.pop();
      req.session.chatHistorico = historico;
      console.error("[chat] falha no agente:", err.message);
      throw new AppError(
        "Não consegui processar sua mensagem agora. Tente de novo em instantes.",
        502
      );
    }

    historico.push({ autor: "agente", texto: turno.mensagem });
    req.session.chatHistorico = historico;

    // ---------- Ainda coletando informações ----------
    if (!turno.prontoParaAbrir) {
      // A ficha vai a cada turno: é ela que se preenche na tela conforme
      // o agente vai apurando os dados.
      return res.json({
        mensagem: turno.mensagem,
        ficha: turno.chamado,
        raciocinio: turno.raciocinio || null,
        chamadoAberto: false,
      });
    }

    // ---------- O agente decidiu abrir o chamado ----------
    const c = turno.chamado;
    // Descrição no formato padrão do service desk. A conversa não entra:
    // o atendente precisa dos dados organizados, não do diálogo inteiro.
    const descricaoCompleta = [
      "DADOS DO SOLICITANTE",
      `Nome: ${c.solicitanteNome}`,
      `E-mail: ${c.solicitanteEmail}`,
      `Setor: ${c.setor}`,
      `Horário de trabalho: ${c.horarioTrabalho}`,
      c.maquina ? `Máquina: ${c.maquina}` : null,
      c.anydesk ? `AnyDesk: ${c.anydesk}` : null,
      "",
      "SOLICITAÇÃO",
      c.descricao,
      c.observacao ? `\nObservação: ${c.observacao}` : null,
      "",
      `Aberto pelo assistente de IA, a pedido de ${req.session.user}.`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    // Precisa de "de acordo": em vez de escolher o gestor por conta
    // própria, devolvemos os candidatos para o solicitante decidir.
    // Só ele sabe a qual gestor responde — o sistema, no máximo, sugere.
    if (c.precisaAprovacao) {
      req.session.chatPendente = {
        chamado: c,
        descricao: descricaoCompleta,
        raciocinio: turno.raciocinio || null,
        anexos: req.session.chatAnexos || [],
      };

      return res.json({
        mensagem: turno.mensagem,
        ficha: c,
        raciocinio: turno.raciocinio || null,
        chamadoAberto: false,
        escolherAprovador: true,
        papelNecessario: c.papelAprovador || null,
        regra: c.regraAprovacao || null,
        aprovadores: listApproversDetailed(c.papelAprovador),
      });
    }

    // Sem aprovação: vai direto para o Jira.
    const jiraResponse = await createServiceDeskRequest({
      subject: c.titulo,
      body: descricaoCompleta,
      requesterEmail: c.solicitanteEmail,
      requestTypeId: c.tipoSolicitacaoId || null,
    });

    const issueKey = jiraResponse.issueKey || jiraResponse.issueId;
    const link = jiraResponse._links?.web || null;

    // Anexos vão depois da criação: o Jira não aceita arquivo no mesmo
    // pedido que cria o chamado.
    const anexos = req.session.chatAnexos || [];
    let anexados = 0;
    if (anexos.length) {
      const r = await anexarArquivos(issueKey, anexos);
      anexados = r.anexados;
      limparArquivos(anexos);
      req.session.chatAnexos = [];
    }

    await pool.query(
      `INSERT INTO tickets
         (requester_username, requester_name, requester_email, department, subject,
          description, requires_approval, status, jira_issue_key, jira_link,
          request_type_id, request_type_name)
       VALUES ($1, $2, $3, $4, $5, $6, false, 'SENT', $7, $8, $9, $10)`,
      [
        req.session.user,
        c.solicitanteNome,
        c.solicitanteEmail,
        c.setor,
        c.titulo,
        descricaoCompleta,
        issueKey || null,
        link,
        c.tipoSolicitacaoId,
        c.tipoSolicitacaoNome,
      ]
    );

    req.session.chatHistorico = [];

    res.json({
      mensagem: turno.mensagem,
      chamadoAberto: true,
      pendenteAprovacao: false,
      issueKey,
      link,
      anexados,
    });
  })
);

// ---------- POST /api/chat/aprovador ----------
// Registra o chamado pendente com o gestor escolhido na tela.
router.post(
  "/aprovador",
  [body("aprovador").trim().notEmpty().withMessage("Escolha um aprovador.")],
  validate,
  asyncHandler(async (req, res) => {
    const pendente = req.session.chatPendente;
    if (!pendente) {
      throw new AppError("Não há chamado aguardando escolha de aprovador.", 400);
    }

    const escolhido = req.body.aprovador;
    if (!listAllApprovers().includes(escolhido)) {
      throw new AppError("Este usuário não é um aprovador válido.", 400);
    }

    const c = pendente.chamado;

    const { rows } = await pool.query(
      `INSERT INTO tickets
         (requester_username, requester_name, requester_email, department, subject,
          description, requires_approval, status, approver_username,
          request_type_id, request_type_name, approval_reason)
       VALUES ($1, $2, $3, $4, $5, $6, true, 'PENDING', $7, $8, $9, $10)
       RETURNING id`,
      [
        req.session.user,
        c.solicitanteNome,
        c.solicitanteEmail,
        c.setor,
        c.titulo,
        pendente.descricao,
        escolhido,
        c.tipoSolicitacaoId,
        c.tipoSolicitacaoNome,
        c.regraAprovacao,
      ]
    );

    console.log(`[chat] pendente #${rows[0].id} encaminhado para "${escolhido}"`);

    delete req.session.chatPendente;
    req.session.chatHistorico = [];

    res.json({
      ok: true,
      id: rows[0].id,
      aprovador: escolhido,
      regra: c.regraAprovacao,
    });
  })
);

module.exports = router;
