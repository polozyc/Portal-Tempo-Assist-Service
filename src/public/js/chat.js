const janela = document.getElementById("chat-janela");
const input = document.getElementById("chat-input");
const btnEnviar = document.getElementById("chat-enviar");
const btnReiniciar = document.getElementById("chat-reiniciar");

const SAUDACAO =
  "Olá! Sou o Tino, assistente do service desk. Me conta o que você " +
  "precisa e eu abro o chamado para você.";

function rolarParaFim() {
  janela.scrollTop = janela.scrollHeight;
}

function adicionarBalao(texto, tipo, html = false) {
  const div = document.createElement("div");
  div.className = `balao ${tipo}`;
  if (html) {
    div.innerHTML = texto;
  } else {
    div.textContent = texto;
  }
  janela.appendChild(div);
  rolarParaFim();
  return div;
}

function mostrarDigitando() {
  const div = document.createElement("div");
  div.className = "balao agente digitando";
  div.innerHTML = "<span></span><span></span><span></span>";
  janela.appendChild(div);
  rolarParaFim();
  return div;
}

// ---------- Carrega a conversa em andamento ----------
(async function iniciar() {
  try {
    const res = await fetch(`${API}/chat`);
    const data = await res.json();

    if (!data.disponivel) {
      adicionarBalao(
        "O assistente está indisponível no momento. Você pode abrir o chamado pelo formulário.",
        "erro"
      );
      input.disabled = true;
      btnEnviar.disabled = true;
      return;
    }

    desenharAnexos(data.arquivos);

    if (data.historico?.length) {
      // Restaura a conversa (o usuário pode ter recarregado a página)
      data.historico.forEach((m) =>
        adicionarBalao(m.texto, m.autor === "usuario" ? "usuario" : "agente")
      );
    } else {
      adicionarBalao(SAUDACAO, "agente");
    }
  } catch {
    adicionarBalao("Não foi possível carregar o assistente.", "erro");
  }
})();

// ---------- Ficha que se preenche durante a conversa ----------
const OPCIONAIS = ["maquina", "anydesk", "observacao"];
const ROTULOS = {
  incidente: "Incidente",
  solicitacao: "Solicitação",
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

function escreverCampo(nome, valor, ehHtml = false) {
  const campo = document.querySelector(`[data-campo="${nome}"] span`);
  if (!campo) return;

  const texto = String(valor ?? "");
  if (!texto) {
    campo.className = "vazio";
    campo.textContent = OPCIONAIS.includes(nome) ? "—" : "aguardando";
    campo.dataset.valor = "";
    return;
  }
  if (campo.dataset.valor === texto) return; // sem mudança: não reanima

  campo.className = "novo";
  campo.dataset.valor = texto;
  if (ehHtml) campo.innerHTML = valor;
  else campo.textContent = texto;

  setTimeout(() => campo.classList.remove("novo"), 600);
}

function atualizarFicha(f) {
  if (!f) return;
  escreverCampo("solicitanteNome", f.solicitanteNome);
  escreverCampo("solicitanteEmail", f.solicitanteEmail);
  escreverCampo("setor", f.setor);
  escreverCampo("horarioTrabalho", f.horarioTrabalho);
  escreverCampo("maquina", f.maquina);
  escreverCampo("anydesk", f.anydesk);
  escreverCampo("observacao", f.observacao);
  escreverCampo("titulo", f.titulo);
  escreverCampo("categoria", f.categoria ? ROTULOS[f.categoria] : "");
  escreverCampo("urgencia", f.urgencia ? ROTULOS[f.urgencia] : "");

  // A aprovação só é conclusiva depois que o agente classifica a natureza.
  if (f.precisaAprovacao) {
    escreverCampo("aprovacao", "necessário" + (f.papelAprovador ? ` · ${escapeHtml(f.papelAprovador)}` : ""), true);
  } else if (f.categoria) {
    escreverCampo("aprovacao", "dispensado");
  }
}

function mostrarRaciocinio(texto) {
  if (!texto) return;
  document.getElementById("raciocinio-texto").textContent = texto;
  document.getElementById("raciocinio").hidden = false;
}

function limparFicha() {
  document.querySelectorAll("[data-campo] span").forEach((sp) => {
    const nome = sp.parentElement.dataset.campo;
    sp.className = "vazio";
    sp.textContent = OPCIONAIS.includes(nome) ? "—" : "aguardando";
    sp.dataset.valor = "";
  });
  document.getElementById("raciocinio").hidden = true;
}

// ---------- Anexos ----------
const inputArquivo = document.getElementById("input-arquivo");
const btnAnexar = document.getElementById("btn-anexar");
const listaAnexos = document.getElementById("lista-anexos");

function formatarTamanho(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function desenharAnexos(arquivos) {
  listaAnexos.innerHTML = (arquivos || [])
    .map(
      (a, i) => `
      <span class="anexo">
        <span class="nome" title="${escapeHtml(a.nome)}">${escapeHtml(a.nome)}</span>
        <span class="peso">${formatarTamanho(a.tamanho)}</span>
        <button type="button" data-indice="${i}" aria-label="Remover ${escapeHtml(a.nome)}">&times;</button>
      </span>`
    )
    .join("");

  listaAnexos.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      const res = await fetch(`${API}/chat/anexo/${b.dataset.indice}`, { method: "DELETE" });
      const data = await res.json();
      desenharAnexos(data.arquivos);
    });
  });
}

btnAnexar.addEventListener("click", () => inputArquivo.click());

inputArquivo.addEventListener("change", async () => {
  if (!inputArquivo.files.length) return;

  const form = new FormData();
  for (const f of inputArquivo.files) form.append("arquivos", f);

  btnAnexar.disabled = true;
  try {
    const res = await fetch(`${API}/chat/anexo`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok) {
      adicionarBalao(data.error || "Não consegui anexar o arquivo.", "erro");
      return;
    }
    desenharAnexos(data.arquivos);
  } catch {
    adicionarBalao("Falha ao enviar o arquivo.", "erro");
  } finally {
    btnAnexar.disabled = false;
    inputArquivo.value = ""; // permite reenviar o mesmo arquivo
  }
});

// ---------- Escolha do gestor que vai aprovar ----------
function montarEscolhaAprovador(data) {
  const caixa = document.createElement("div");
  caixa.className = "escolha";

  const papel = data.papelNecessario
    ? ` Pela política, quem aprova é: <strong>${escapeHtml(data.papelNecessario)}</strong>.`
    : "";

  caixa.innerHTML = `
    <h4>Para qual gestor devo encaminhar?</h4>
    <p class="dica">
      Este chamado precisa de "de acordo" antes de ir para a fila.${papel}
      Escolha o gestor responsável pela sua área.
    </p>
    <input type="search" placeholder="Buscar gestor pelo nome..." aria-label="Buscar gestor" />
    <div class="lista-aprovadores"></div>
  `;

  const busca = caixa.querySelector("input");
  const lista = caixa.querySelector(".lista-aprovadores");

  function desenhar(filtro = "") {
    const termo = filtro.trim().toLowerCase();
    const visiveis = (data.aprovadores || []).filter((a) => {
      if (!termo) return true;
      const alvo = [a.username, ...(a.papeis || []), ...(a.setores || [])].join(" ").toLowerCase();
      return alvo.includes(termo);
    });

    if (!visiveis.length) {
      lista.innerHTML = `<p class="sem-resultado">Nenhum gestor encontrado para "${escapeHtml(filtro)}".</p>`;
      return;
    }

    lista.innerHTML = visiveis
      .map((a) => {
        const detalhes = [
          a.papeis?.length ? a.papeis.join(", ") : null,
          a.setores?.length ? `setor: ${a.setores.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        return `
          <button class="aprovador" data-usuario="${escapeHtml(a.username)}">
            <span>
              <span class="nome">${escapeHtml(a.username)}</span>
              ${detalhes ? `<span class="detalhe">${escapeHtml(detalhes)}</span>` : ""}
            </span>
            ${a.recomendado ? `<span class="recomendado">recomendado</span>` : ""}
          </button>`;
      })
      .join("");

    lista.querySelectorAll(".aprovador").forEach((botao) => {
      botao.addEventListener("click", () => confirmarAprovador(botao.dataset.usuario, caixa));
    });
  }

  busca.addEventListener("input", () => desenhar(busca.value));
  desenhar();

  janela.appendChild(caixa);
  janela.scrollTop = janela.scrollHeight;
  busca.focus();
}

async function confirmarAprovador(usuario, caixa) {
  caixa.querySelectorAll("button").forEach((b) => (b.disabled = true));

  try {
    const res = await fetch(`${API}/chat/aprovador`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aprovador: usuario }),
    });
    const data = await res.json();

    if (!res.ok) {
      adicionarBalao(data.error || "Não consegui encaminhar.", "erro");
      caixa.querySelectorAll("button").forEach((b) => (b.disabled = false));
      return;
    }

    caixa.remove();
    adicionarBalao(
      `Encaminhado para o "de acordo" de <strong>${escapeHtml(data.aprovador)}</strong>.` +
        (data.regra ? `<br>Motivo: ${escapeHtml(data.regra)}` : "") +
        `<br><a href="/my-tickets.html">Acompanhar em Meus Chamados</a>`,
      "sistema",
      true
    );
    limparFicha();
    adicionarBalao("Precisa de mais alguma coisa?", "agente");
  } catch {
    adicionarBalao("Falha ao encaminhar. Tente de novo.", "erro");
    caixa.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// ---------- Envio ----------
async function enviar() {
  const texto = input.value.trim();
  if (!texto) return;

  adicionarBalao(texto, "usuario");
  input.value = "";
  input.style.height = "auto";

  input.disabled = true;
  btnEnviar.disabled = true;
  const digitando = mostrarDigitando();

  try {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensagem: texto }),
    });
    const data = await res.json();

    digitando.remove();

    if (!res.ok) {
      adicionarBalao(data.error || "Erro ao falar com o assistente.", "erro");
      return;
    }

    adicionarBalao(data.mensagem, "agente");
    atualizarFicha(data.ficha);
    mostrarRaciocinio(data.raciocinio);

    // ---------- O chamado foi aberto ----------
    if (data.escolherAprovador) {
      montarEscolhaAprovador(data);
      return;
    }

    if (data.chamadoAberto) {
      if (data.pendenteAprovacao) {
        adicionarBalao(
          `Chamado registrado e enviado para o "de acordo" de <strong>${escapeHtml(
            data.aprovador
          )}</strong>.` +
            (data.regra ? `<br>Motivo: ${escapeHtml(data.regra)}` : "") +
            `<br><a href="/my-tickets.html">Acompanhar em Meus Chamados</a>`,
          "sistema",
          true
        );
      } else {
        const link = safeUrl(data.link);
        const anexos = data.anexados
          ? `<br>${data.anexados} arquivo(s) anexado(s).`
          : "";
        adicionarBalao(
          `Chamado <strong>${escapeHtml(data.issueKey || "")}</strong> aberto com sucesso.${anexos}` +
            (link
              ? `<br><a href="${link}" target="_blank" rel="noopener">Acompanhar no Jira</a>`
              : "") +
            `<br><a href="/my-tickets.html">Ver em Meus Chamados</a>`,
          "sistema",
          true
        );
      }

      limparFicha();
      desenharAnexos([]);
      adicionarBalao("Precisa de mais alguma coisa? É só me contar.", "agente");
    }
  } catch {
    digitando.remove();
    adicionarBalao("Falha de conexão. Tente novamente.", "erro");
  } finally {
    input.disabled = false;
    btnEnviar.disabled = false;
    input.focus();
  }
}

btnEnviar.addEventListener("click", enviar);

// Enter envia; Shift+Enter quebra linha (padrão de mensageiros)
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviar();
  }
});

// Cresce conforme o texto, até o limite do CSS
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

// ---------- Recomeçar ----------
btnReiniciar.addEventListener("click", async () => {
  await fetch(`${API}/chat`, { method: "DELETE" });
  janela.innerHTML = "";
  limparFicha();
  desenharAnexos([]);
  adicionarBalao(SAUDACAO, "agente");
  input.focus();
});
