async function loadApprovals() {
  const res = await fetch(`${API}/approvals`);
  const items = await res.json();
  const container = document.getElementById("approvals-list");

  if (!items.length) {
    container.innerHTML = `<p class="empty-state">Nenhum chamado pendente de aprovação no momento.</p>`;
    return;
  }

  container.innerHTML = items
    .map(
      (t) => `
    <div class="approval-card" data-id="${t.id}">
      <h3>${escapeHtml(t.subject)}</h3>
      <div class="meta">
        Solicitante: ${escapeHtml(t.requester_name || "-")} (${escapeHtml(t.requester_email)}) ·
        Setor: ${escapeHtml(t.department)} ·
        ${t.request_type_name ? escapeHtml(t.request_type_name) + " ·" : ""}
        Aberto em: ${new Date(t.created_at).toLocaleString("pt-BR")}
      </div>
      <div class="desc">${escapeHtml(t.description || "(sem descrição)")}</div>
      <div class="approval-actions">
        <textarea placeholder="Justificativa (obrigatória) — explique por que está autorizando ou recusando" data-notes required></textarea>
        <button class="btn-approve" data-action="approve">Aprovar</button>
        <button class="btn-reject" data-action="reject">Rejeitar</button>
      </div>
      <div class="feedback" data-feedback></div>
    </div>
  `
    )
    .join("");

  container.querySelectorAll(".approval-card").forEach((card) => {
    const id = card.dataset.id;
    const notesEl = card.querySelector("[data-notes]");
    const feedbackEl = card.querySelector("[data-feedback]");

    card.querySelector('[data-action="approve"]').addEventListener("click", async () => {
      const notes = notesEl.value.trim();
      // Justificativa obrigatoria: ela vai para o chamado no Jira e serve
      // como registro de auditoria de quem autorizou e por que.
      if (notes.length < 5) {
        showFeedback(
          feedbackEl,
          "Escreva a justificativa da autorizacao (minimo 5 caracteres).",
          "error"
        );
        notesEl.focus();
        return;
      }
      await decide(id, "approve", { notes }, feedbackEl, card);
    });

    card.querySelector('[data-action="reject"]').addEventListener("click", async () => {
      const reason = notesEl.value.trim();
      if (reason.length < 5) {
        showFeedback(
          feedbackEl,
          "Informe o motivo da recusa (minimo 5 caracteres).",
          "error"
        );
        notesEl.focus();
        return;
      }
      await decide(id, "reject", { reason }, feedbackEl, card);
    });
  });
}

async function decide(id, action, body, feedbackEl, card) {
  try {
    const res = await fetch(`${API}/approvals/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao processar decisão.");

    showFeedback(feedbackEl, data.message || "Feito.", "ok");
    setTimeout(() => card.remove(), 1200);
  } catch (err) {
    showFeedback(feedbackEl, err.message, "error");
  }
}

async function loadHistory() {
  const res = await fetch(`${API}/approvals/history`);
  const items = await res.json();
  const container = document.getElementById("history-list");

  if (!items.length) {
    container.innerHTML = `<p class="empty-state">Nenhuma decisão registrada ainda.</p>`;
    return;
  }

  container.innerHTML = items
    .map((t) => {
      const isApproved = t.status === "APPROVED";
      const statusLabel = isApproved ? "Aprovado" : "Rejeitado";
      const statusColor = isApproved ? "#1e7d34" : "#c5221f";

      return `
      <div class="approval-card">
        <h3>${escapeHtml(t.subject)}
          <span style="font-size:12px; font-weight:600; color:${statusColor};">— ${statusLabel}</span>
        </h3>
        <div class="meta">
          Solicitante: ${escapeHtml(t.requester_name || "-")} (${escapeHtml(t.requester_email)}) ·
          Setor: ${escapeHtml(t.department)} ·
        ${t.request_type_name ? escapeHtml(t.request_type_name) + " ·" : ""}
          Decidido em: ${t.decided_at ? new Date(t.decided_at).toLocaleString("pt-BR") : "-"}
        </div>
        ${t.decision_notes ? `<div class="desc">Observação: ${escapeHtml(t.decision_notes)}</div>` : ""}
        ${
          isApproved && t.jira_link
            ? `<a class="ticket-link" href="${safeUrl(t.jira_link)}" target="_blank" rel="noopener">Ver chamado no Jira (${escapeHtml(t.jira_issue_key || "")}) →</a>`
            : ""
        }
      </div>
    `;
    })
    .join("");
}


loadApprovals();
