const API = "/api";

document.getElementById("logout-btn")?.addEventListener("click", async () => {
  await fetch(`${API}/logout`, { method: "POST" });
  window.location.href = "/login.html";
});

function showFeedback(el, message, type) {
  el.textContent = message;
  el.className = `feedback show ${type}`;
  setTimeout(() => el.classList.remove("show"), 4000);
}

/**
 * Escapa texto antes de inserir em innerHTML.
 *
 * Obrigatório para QUALQUER dado vindo do banco ou digitado por usuário:
 * sem isso, um item cadastrado com nome `<img src=x onerror=...>` executaria
 * script na tela de todo mundo que abrisse a lista (XSS armazenado).
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/** Escapa valores usados dentro de atributos href/src. */
function safeUrl(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "";
}
