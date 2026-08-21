const STATUS_LABELS = {
  PENDING: "Aguardando aprovação",
  APPROVED: "Aprovado e enviado",
  REJECTED: "Rejeitado",
  SENT: "Enviado ao Jira",
};


async function loadMyTickets() {
  const res = await fetch(`${API}/my-tickets`);
  const tickets = await res.json();
  const container = document.getElementById("tickets-list");

  if (!tickets.length) {
    container.innerHTML = `<p class="empty-state">Você ainda não abriu nenhum chamado.</p>`;
    return;
  }

  container.innerHTML = tickets
    .map((t) => {
      const statusLabel = STATUS_LABELS[t.status] || t.status;
      let extra = "";

      if (t.status === "REJECTED" && t.decision_notes) {
        extra = `<div class="rejection-note">Motivo da rejeição: ${escapeHtml(t.decision_notes)}</div>`;
      }
      if ((t.status === "APPROVED" || t.status === "SENT") && t.jira_link) {
        extra = `<a class="ticket-link" href="${safeUrl(t.jira_link)}" target="_blank" rel="noopener">Acompanhar no Jira (${escapeHtml(t.jira_issue_key || "")}) →</a>`;
      }
      if (t.status === "PENDING") {
        extra = `<div class="meta">Esperando aprovação de: ${escapeHtml(t.approver_username)}</div>`;
      }

      return `
        <div class="ticket-card">
          <h3>${escapeHtml(t.subject)}</h3>
          <div class="meta">
            Aberto em ${new Date(t.created_at).toLocaleString("pt-BR")}
            ${t.department ? `· Setor: ${escapeHtml(t.department)}` : ""}
            ${t.request_type_name ? `· ${escapeHtml(t.request_type_name)}` : ""}
          </div>
          <span class="status-badge status-${t.status}">${statusLabel}</span>
          ${extra}
        </div>
      `;
    })
    .join("");
}

loadMyTickets();
