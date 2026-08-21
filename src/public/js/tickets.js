const form = document.getElementById("ticket-form");
const submitBtn = form.querySelector('button[type="submit"]');
const departmentSelect = document.getElementById("ticket-department");
const approvalCheckbox = document.getElementById("ticket-requires-approval");
const requestTypeSelect = document.getElementById("ticket-request-type");

// ---------- Carrega os tipos de solicitação do Jira ----------
// Usa <optgroup> para reproduzir as categorias do portal
// (Hardware, Sistemas, Software, Telecom...).
(async function loadRequestTypes() {
  try {
    const res = await fetch(`${API}/tickets/request-types`);
    const { groups } = await res.json();

    requestTypeSelect.innerHTML = "";

    if (!groups || !groups.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Tipo padrão do sistema";
      requestTypeSelect.appendChild(opt);
      return;
    }

    const vazio = document.createElement("option");
    vazio.value = "";
    vazio.textContent = "Selecione o tipo...";
    requestTypeSelect.appendChild(vazio);

    groups.forEach((grupo) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = grupo.group;

      grupo.types.forEach((tipo) => {
        const opt = document.createElement("option");
        opt.value = tipo.id;
        opt.textContent = tipo.name;
        if (tipo.description) opt.title = tipo.description;
        optgroup.appendChild(opt);
      });

      requestTypeSelect.appendChild(optgroup);
    });
  } catch {
    requestTypeSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Tipo padrão do sistema";
    requestTypeSelect.appendChild(opt);
  }
})();

// ---------- Carrega os setores que têm gestor configurado ----------
(async function loadDepartments() {
  try {
    const res = await fetch(`${API}/tickets/departments`);
    if (!res.ok) throw new Error();

    const { departments } = await res.json();
    departments.forEach((dep) => {
      const opt = document.createElement("option");
      opt.value = dep;
      opt.textContent = dep;
      departmentSelect.appendChild(opt);
    });

    if (!departments.length) {
      approvalCheckbox.disabled = true;
      approvalCheckbox.parentElement.title =
        "Nenhum setor com gestor configurado pelo administrador.";
    }
  } catch {
    // Se a lista não carregar, deixa o campo utilizável mesmo assim.
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(não foi possível carregar os setores)";
    departmentSelect.appendChild(opt);
  }
})();

// ---------- Modal de "de acordo" obrigatorio ----------
const modal = document.getElementById("approval-modal");
const modalTitle = document.getElementById("approval-modal-title");
const modalMatches = document.getElementById("approval-matches");
const modalApprover = document.getElementById("approval-approver");
const modalRoleHint = document.getElementById("approval-role-hint");
const btnCancelar = document.getElementById("approval-cancel");
const btnConfirmar = document.getElementById("approval-confirm");
const btnSemAprovacao = document.getElementById("approval-proceed-anyway");

function abrirModal(deteccao) {
  // Lista as regras que dispararam
  modalMatches.innerHTML = deteccao.matches
    .map(
      (m) =>
        `<li><strong>${escapeHtml(m.label)}</strong> — de acordo de ${escapeHtml(
          m.roles.join(" e ")
        )}${m.conditional ? " <em>(quando aplicavel)</em>" : ""}</li>`
    )
    .join("");

  // Monta a lista de aprovadores, agrupada por papel quando possivel
  modalApprover.innerHTML = "";
  const jaAdicionados = new Set();
  let algumPapelSemAprovador = false;

  (deteccao.aprovadoresPorPapel || []).forEach(({ role, usuarios }) => {
    if (!usuarios.length) {
      algumPapelSemAprovador = true;
      return;
    }
    const grupo = document.createElement("optgroup");
    grupo.label = role;
    usuarios.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      grupo.appendChild(opt);
      jaAdicionados.add(u);
    });
    modalApprover.appendChild(grupo);
  });

  // Fallback: papeis sem ninguem configurado -> oferece os demais aprovadores
  const restantes = (deteccao.todosAprovadores || []).filter((u) => !jaAdicionados.has(u));
  if (restantes.length) {
    const grupo = document.createElement("optgroup");
    grupo.label = "Outros aprovadores";
    restantes.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      grupo.appendChild(opt);
    });
    modalApprover.appendChild(grupo);
  }

  const semNenhum = modalApprover.options.length === 0;
  btnConfirmar.disabled = semNenhum;

  modalRoleHint.textContent = semNenhum
    ? "Nenhum aprovador configurado. Fale com o administrador do sistema."
    : algumPapelSemAprovador
    ? "Alguns papeis nao tem aprovador configurado; escolha entre os disponiveis."
    : "";

  // Regras "quando aplicavel" sao sugestao: permitimos seguir sem aprovacao.
  const apenasSugestao = !deteccao.requiresApproval && deteccao.suggested;
  modalTitle.textContent = apenasSugestao
    ? 'Este chamado pode precisar de "de acordo"'
    : 'Este chamado precisa de "de acordo"';
  btnSemAprovacao.classList.toggle("hidden", !apenasSugestao);

  modal.classList.remove("hidden");
}

function fecharModal() {
  modal.classList.add("hidden");
}

btnCancelar.addEventListener("click", fecharModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) fecharModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) fecharModal();
});

// ---------- Envio do chamado ----------
function coletarPayload() {
  return {
    requesterName: document.getElementById("ticket-name").value.trim(),
    requesterEmail: document.getElementById("ticket-email").value.trim(),
    department: departmentSelect.value.trim(),
    subject: document.getElementById("ticket-subject").value.trim(),
    description: document.getElementById("ticket-description").value.trim(),
    requiresApproval: approvalCheckbox.checked,
    requestTypeId: requestTypeSelect.value || undefined,
  };
}

async function enviarChamado(payload) {
  const feedback = document.getElementById("ticket-feedback");

  submitBtn.disabled = true;
  submitBtn.textContent = "Enviando...";
  btnConfirmar.disabled = true;

  try {
    const res = await fetch(`${API}/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao abrir chamado.");

    fecharModal();

    if (data.pending) {
      showFeedback(feedback, data.message, "ok");
    } else {
      const link = safeUrl(data.link);
      const linkHtml = link
        ? ` — <a href="${link}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline;">acompanhar no Jira</a>`
        : "";
      feedback.innerHTML = `Chamado ${escapeHtml(data.issueKey || "")} aberto com sucesso!${linkHtml}`;
      feedback.className = "feedback show ok";
      setTimeout(() => feedback.classList.remove("show"), 8000);
    }

    form.reset();
    toggleCamposAprovacao();
  } catch (err) {
    showFeedback(feedback, err.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Abrir chamado";
    btnConfirmar.disabled = false;
  }
}

btnConfirmar.addEventListener("click", () => {
  const payload = coletarPayload();
  payload.requiresApproval = true;
  payload.approverUsername = modalApprover.value;
  enviarChamado(payload);
});

btnSemAprovacao.addEventListener("click", () => {
  const payload = coletarPayload();
  payload.requiresApproval = false;
  enviarChamado(payload);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("ticket-feedback");
  const payload = coletarPayload();

  // Se o usuario ja marcou "precisa de de acordo", segue o fluxo por setor.
  if (payload.requiresApproval) {
    if (!payload.department) {
      showFeedback(feedback, "Selecione o setor para solicitar aprovacao do gestor.", "error");
      return;
    }
    return enviarChamado(payload);
  }

  // Caso contrario, verifica se o assunto cai numa regra de aprovacao.
  try {
    const res = await fetch(`${API}/tickets/check-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: payload.subject,
        description: payload.description,
        requestTypeName: requestTypeSelect.selectedOptions[0]?.textContent || "",
      }),
    });

    if (res.ok) {
      const deteccao = await res.json();
      if (deteccao.requiresApproval || deteccao.suggested) {
        abrirModal(deteccao);
        return;
      }
    }
  } catch {
    // Falha na verificacao nao bloqueia: o servidor checa de novo ao criar.
  }

  enviarChamado(payload);
});

// Esconde o seletor de setor quando ele nao e necessario
function toggleCamposAprovacao() {
  const marcado = approvalCheckbox.checked;
  departmentSelect.closest("label").style.opacity = marcado ? "1" : "";
}
approvalCheckbox.addEventListener("change", toggleCamposAprovacao);
