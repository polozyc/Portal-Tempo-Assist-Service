// ---------- Navegação por abas ----------
document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");

    if (btn.dataset.tab === "itens") loadItems();
    if (btn.dataset.tab === "historico") loadHistory();
    if (btn.dataset.tab === "scan") document.getElementById("scan-barcode").focus();
  });
});

// ---------- Scanner (entrada/saída) ----------
const scanBarcode = document.getElementById("scan-barcode");
const scanFeedback = document.getElementById("scan-feedback");
const scanLog = document.getElementById("scan-log");

// mostra os campos de chamado/setor/solicitante só quando a ação é Saída
const scanActionSelect = document.getElementById("scan-action");
function toggleOutOnlyFields() {
  const isOut = scanActionSelect.value === "OUT";
  document.querySelectorAll(".out-only").forEach((el) => el.classList.toggle("hidden-field", !isOut));
}
scanActionSelect.addEventListener("change", toggleOutOnlyFields);
toggleOutOnlyFields();

scanBarcode.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();

  const barcode = scanBarcode.value.trim();
  if (!barcode) return;

  const action = scanActionSelect.value;
  const person = document.getElementById("scan-person").value.trim();
  const notes = document.getElementById("scan-notes").value.trim();
  const ticket_number = document.getElementById("scan-ticket").value.trim();
  const department = document.getElementById("scan-department").value.trim();
  const requester = document.getElementById("scan-requester").value.trim();

  try {
    const res = await fetch(`${API}/inventory/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode, action, person, notes, ticket_number, department, requester }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Erro ao registrar movimentação.");

    showFeedback(scanFeedback, `${data.item.name}: ${data.message}`, "ok");

    const row = document.createElement("tr");
    row.innerHTML = `<td>${new Date().toLocaleTimeString("pt-BR")}</td><td>${escapeHtml(data.item.name)}</td><td>${action === "OUT" ? "Saída" : "Entrada"}</td><td>${escapeHtml(ticket_number || "-")}</td><td>${escapeHtml(department || "-")}</td><td>${escapeHtml(requester || "-")}</td>`;
    scanLog.prepend(row);
  } catch (err) {
    showFeedback(scanFeedback, err.message, "error");
  } finally {
    scanBarcode.value = "";
    // não limpa chamado/setor/solicitante: útil quando várias peças saem pro mesmo chamado
    scanBarcode.focus();
  }
});

// mantém o foco no campo do scanner sempre que possível
document.getElementById("tab-scan").addEventListener("click", () => scanBarcode.focus());

// ---------- Cadastro de item ----------
document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("create-feedback");

  const payload = {
    barcode: document.getElementById("new-barcode").value.trim(),
    name: document.getElementById("new-name").value.trim(),
    category: document.getElementById("new-category").value.trim(),
    serial_number: document.getElementById("new-serial").value.trim(),
    location: document.getElementById("new-location").value.trim(),
  };

  try {
    const res = await fetch(`${API}/inventory/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao cadastrar item.");

    showFeedback(feedback, `Item "${data.name}" cadastrado com sucesso.`, "ok");
    e.target.reset();
  } catch (err) {
    showFeedback(feedback, err.message, "error");
  }
});

// ---------- Lista de itens ----------
async function loadItems(query = "") {
  const tbody = document.getElementById("items-table");
  try {
    const res = await fetch(
      `${API}/inventory/items${query ? `?q=${encodeURIComponent(query)}` : ""}`
    );
    if (!res.ok) throw new Error("Não foi possível carregar os itens.");

    const items = await res.json();

    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#666;">Nenhum item encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map(
        (i) => `<tr>
        <td>${escapeHtml(i.barcode)}</td>
        <td>${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.category || "-")}</td>
        <td>${i.status === "IN_STOCK" ? "Em estoque" : "Retirado"}</td>
        <td>${escapeHtml(i.location || "-")}</td>
        <td>${escapeHtml(i.current_ticket || "-")}</td>
        <td>${escapeHtml(i.current_department || "-")}</td>
        <td>${escapeHtml(i.current_requester || "-")}</td>
      </tr>`
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#c5221f;">${escapeHtml(err.message)}</td></tr>`;
  }
}

// Debounce: evita disparar uma requisição por tecla digitada na busca.
let searchTimer;
document.getElementById("items-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const value = e.target.value;
  searchTimer = setTimeout(() => loadItems(value), 300);
});

// ---------- Histórico ----------
async function loadHistory() {
  const tbody = document.getElementById("history-table");
  try {
    const res = await fetch(`${API}/inventory/movements`);
    if (!res.ok) throw new Error("Não foi possível carregar o histórico.");

    // A API retorna { movements, total, limit, offset } — não um array direto.
    const data = await res.json();
    const rows = Array.isArray(data) ? data : data.movements || [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#666;">Nenhuma movimentação registrada.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map(
        (m) => `<tr>
        <td>${new Date(m.created_at).toLocaleString("pt-BR")}</td>
        <td>${escapeHtml(m.item_name)}</td>
        <td>${escapeHtml(m.barcode)}</td>
        <td>${m.action === "OUT" ? "Saída" : "Entrada"}</td>
        <td>${escapeHtml(m.person || "-")}</td>
        <td>${escapeHtml(m.ticket_number || "-")}</td>
        <td>${escapeHtml(m.department || "-")}</td>
        <td>${escapeHtml(m.requester || "-")}</td>
        <td>${escapeHtml(m.notes || "-")}</td>
      </tr>`
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#c5221f;">${escapeHtml(err.message)}</td></tr>`;
  }
}
