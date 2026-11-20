// Página do app: formulário, progresso e resultados. A busca roda no documento offscreen;
// esta página só manda comandos e desenha o estado gravado em chrome.storage.local.

const $ = (id) => document.getElementById(id);
const CAMPOS = ["jogo", "lista", "qualidadeMin", "excluir", "freteReal",
  "cep", "padrao", "uf", "mesmoUf", "maxPaginas", "token"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const lista = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const etiquetas = (p) => lista(p); // "Ultra Rare, 1st" -> ["Ultra Rare", "1st"]
const chave = (s) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// filtros de múltipla escolha: opções = sugestões + o que apareceu nas ofertas da última busca
const MULTI = {
  idiomas: { sugestoes: ["Português", "Inglês", "Japonês"], // as mesmas do app antes da primeira busca
    vistos: (r) => r.itens.flatMap((it) => it.ofertas.map((o) => o.idioma)) },
  printingsExcluir: { sugestoes: [],
    vistos: (r) => r.itens.flatMap((it) => it.ofertas.flatMap((o) => etiquetas(o.printing))) },
};
const selecionados = { idiomas: new Set(), printingsExcluir: new Set() };
const enviar = (msg) => chrome.runtime.sendMessage({ para: "bg", ...msg });

let estado = { fase: "parado" };
try { $("versao").textContent = `Versão ${chrome.runtime.getManifest().version}.`; } catch { /* prévia fora do Chrome */ }

// ------------------------------------------------------------------ configuração salva
async function carregarConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  for (const c of CAMPOS) {
    if (!(c in config)) continue;
    if ($(c).type === "checkbox") $(c).checked = config[c];
    else $(c).value = config[c];
  }
  for (const c of Object.keys(MULTI)) { // versões antigas guardavam texto separado por vírgula
    const v = config[c];
    selecionados[c] = new Set(Array.isArray(v) ? v : lista(v));
  }
  return config;
}

function lerConfig() {
  return {
    ...Object.fromEntries(CAMPOS.map((c) => [c, $(c).type === "checkbox" ? $(c).checked : $(c).value])),
    ...Object.fromEntries(Object.keys(MULTI).map((c) => [c, [...selecionados[c]]])),
  };
}

// ------------------------------------------------------------------ seleção múltipla (igual ao st.multiselect do app)
// Caixa com as escolhidas (× tira uma; o × da direita tira todas) e ▾ que abre a lista;
// a lista começa com "Selecionar todos" e as escolhidas saem dela.
const opcoesMulti = { idiomas: [], printingsExcluir: [] };
const PLACEHOLDER = { idiomas: "Todos", printingsExcluir: "Nenhuma" };

async function salvarMulti(c) {
  desenharMulti(c);
  await chrome.storage.local.set({ config: lerConfig() });
}

function adicionar(c, vs) {
  for (let v of vs) {
    v = v.trim();
    if (v && ![...selecionados[c]].some((x) => chave(x) === chave(v))) selecionados[c].add(v);
  }
  salvarMulti(c);
}

function remover(c, v) {
  if (v == null) selecionados[c].clear();
  else selecionados[c].delete(v);
  salvarMulti(c);
}

const SETA = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function montarMulti(c) {
  const raiz = $(c);
  raiz.innerHTML = `<div class="multi-caixa"><span class="multi-tags"></span>
    <input class="multi-entrada" autocomplete="off" role="combobox" aria-expanded="false">
    <span class="multi-icones"><button type="button" class="multi-limpar" aria-label="Tirar todos" hidden>×</button>
    <span class="multi-seta">${SETA}</span></span></div>
    <ul class="multi-lista" role="listbox" hidden></ul>`;
  const entrada = raiz.querySelector(".multi-entrada");
  const listaEl = raiz.querySelector(".multi-lista");
  let ativo = 0;
  const aberta = () => !listaEl.hidden;
  const visiveis = () => {
    const f = chave(entrada.value.trim());
    const ja = new Set([...selecionados[c]].map(chave));
    return opcoesMulti[c].filter((v) => !ja.has(chave(v)) && (!f || chave(v).includes(f)));
  };
  const abrir = () => {
    const vs = visiveis();
    const digitado = entrada.value.trim();
    // impressões: antes da primeira busca não há opções, então aceita o que for digitado
    const extra = c === "printingsExcluir" && digitado && !vs.some((v) => chave(v) === chave(digitado))
      && ![...selecionados[c]].some((x) => chave(x) === chave(digitado));
    const ops = [
      ...(vs.length > 1 ? [{ todos: true, rotulo: "Selecionar todos" }] : []),
      ...vs.map((v) => ({ v, rotulo: v })),
      ...(extra ? [{ v: digitado, rotulo: `Adicionar “${digitado}”` }] : []),
    ];
    ativo = Math.min(ativo, Math.max(ops.length - 1, 0));
    listaEl.innerHTML = ops.length
      ? ops.map((o, k) => `<li role="option" class="op${k === ativo ? " ativo" : ""}"${o.todos ? " data-todos" : ` data-v="${esc(o.v)}"`}>${esc(o.rotulo)}</li>`).join("")
      : `<li class="vazio">${opcoesMulti[c].length ? "Sem mais opções" : c === "printingsExcluir" ? "Sem opções ainda: digite e tecle Enter" : "Sem resultados"}</li>`;
    listaEl.hidden = false;
    raiz.classList.add("aberta");
    entrada.setAttribute("aria-expanded", "true");
  };
  const fechar = () => {
    listaEl.hidden = true;
    raiz.classList.remove("aberta");
    entrada.setAttribute("aria-expanded", "false");
  };
  const escolher = (li) => {
    if (!li) return;
    adicionar(c, li.hasAttribute("data-todos") ? visiveis() : [li.dataset.v]);
    entrada.value = "";
    ativo = 0;
    if (aberta()) abrir();
  };
  raiz._abrir = () => { if (aberta()) abrir(); };

  raiz.querySelector(".multi-caixa").addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const x = ev.target.closest(".multi-tag button");
    if (x) { remover(c, x.dataset.v); entrada.focus(); return; }
    if (ev.target.closest(".multi-limpar")) { remover(c, null); entrada.focus(); return; }
    if (ev.target.closest(".multi-seta") && aberta()) { fechar(); return; }
    entrada.focus();
    abrir();
  });
  entrada.addEventListener("focus", abrir);
  entrada.addEventListener("blur", fechar);
  entrada.addEventListener("input", () => { ativo = 0; abrir(); });
  listaEl.addEventListener("mousedown", (ev) => { ev.preventDefault(); escolher(ev.target.closest("li.op")); });
  listaEl.addEventListener("mousemove", (ev) => {
    const li = ev.target.closest("li.op");
    if (!li) return;
    ativo = [...listaEl.querySelectorAll("li.op")].indexOf(li);
    listaEl.querySelectorAll("li.op").forEach((x) => x.classList.toggle("ativo", x === li));
  });
  entrada.addEventListener("keydown", (ev) => {
    const itens = [...listaEl.querySelectorAll("li.op")];
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!aberta()) return abrir();
      ativo = (ativo + (ev.key === "ArrowDown" ? 1 : -1) + itens.length) % Math.max(itens.length, 1);
      itens.forEach((li, k) => li.classList.toggle("ativo", k === ativo));
      itens[ativo]?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault(); // não envia o formulário
      if (aberta()) escolher(listaEl.querySelector("li.op.ativo") || itens[0]);
    } else if (ev.key === "Escape") {
      fechar();
    } else if (ev.key === "Backspace" && !entrada.value && selecionados[c].size) {
      remover(c, [...selecionados[c]].at(-1));
    }
  });
}

/** Atualiza as escolhidas e as opções: o que apareceu nas ofertas da última busca (ou as sugestões). */
function desenharMulti(c) {
  const vistos = estado.resultado ? MULTI[c].vistos(estado.resultado) : [];
  const porChave = new Map();
  for (const v of vistos) if (v && !porChave.has(chave(v))) porChave.set(chave(v), v);
  opcoesMulti[c] = porChave.size ? [...porChave.values()].sort((a, b) => a.localeCompare(b, "pt-BR")) : [...MULTI[c].sugestoes];
  const raiz = $(c);
  raiz.querySelector(".multi-tags").innerHTML = [...selecionados[c]].map((v) =>
    `<span class="multi-tag">${esc(v)}<button type="button" data-v="${esc(v)}" aria-label="Tirar ${esc(v)}">×</button></span>`).join("");
  raiz.querySelector(".multi-entrada").placeholder = selecionados[c].size ? "" : PLACEHOLDER[c];
  raiz.querySelector(".multi-limpar").hidden = !selecionados[c].size;
  raiz._abrir();
  if (c === "printingsExcluir") $("dicaImpressoes").hidden = opcoesMulti[c].length > 0;
}

for (const c of Object.keys(MULTI)) montarMulti(c);

async function carregarJogos(atual) {
  try {
    let { jogos } = await chrome.storage.local.get("jogos");
    if (!jogos || Date.now() - jogos.quando > 86400e3) {
      const r = await fetch("https://mypcards.com/api/v1/jogos", { headers: { Accept: "application/json" } });
      const j = await r.json();
      jogos = { quando: Date.now(), lista: j.games.map((g) => ({ slug: g.slug, nome: g.name })) };
      await chrome.storage.local.set({ jogos });
    }
    $("jogo").innerHTML = jogos.lista.map((g) => `<option value="${esc(g.slug)}">${esc(g.nome)}</option>`).join("");
  } catch { /* fica só com Yu-Gi-Oh! */ }
  $("jogo").value = atual || "yugioh";
  if (!$("jogo").value) $("jogo").value = "yugioh";
  if (!$("jogo").value) $("jogo").selectedIndex = 0;
}

// ------------------------------------------------------------------ ações
$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const cfg = lerConfig();
  await chrome.storage.local.set({ config: cfg });
  if (cfg.freteReal && cfg.cep && cfg.cep.replace(/\D/g, "").length !== 8) {
    alert("O CEP precisa ter 8 dígitos (ou deixe vazio para usar o do carrinho).");
    return;
  }
  const num = (v) => (v === "" || v == null ? null : Number(v));
  await enviar({
    tipo: "iniciar",
    params: {
      jogo: cfg.jogo,
      lista: cfg.lista,
      filtros: {
        qualidadeMin: cfg.qualidadeMin, idiomas: cfg.idiomas,
        excluir: lista(cfg.excluir), printingsExcluir: cfg.printingsExcluir,
      },
      frete: { padrao: num(cfg.padrao) ?? 20, mesmoUf: num(cfg.mesmoUf), uf: cfg.uf.trim().toUpperCase() || null },
      freteReal: cfg.freteReal,
      cep: cfg.cep.trim() || null,
      maxPaginas: Math.max(1, Math.min(20, num(cfg.maxPaginas) || 10)),
      token: cfg.token.trim() || null,
    },
  });
});

$("cancelar").addEventListener("click", () => enviar({ tipo: "cancelar" }));

$("limparCache").addEventListener("click", async () => {
  await caches.delete("myp-v1");
  alert("Cache limpo. A próxima busca baixa as páginas de novo.");
});

for (const b of document.querySelectorAll(".abas button")) {
  b.addEventListener("click", () => mostrarAba(b.dataset.aba));
}

function mostrarAba(nome) {
  for (const b of document.querySelectorAll(".abas button")) b.classList.toggle("ativa", b.dataset.aba === nome);
  for (const a of document.querySelectorAll(".aba")) a.hidden = a.id !== `aba-${nome}`;
}

// ------------------------------------------------------------------ desenho
function desenhar() {
  const rodando = estado.fase === "rodando";
  $("buscar").disabled = rodando;
  $("cancelar").hidden = !rodando;
  $("status").hidden = estado.fase === "parado" && !estado.log?.length;
  $("barra").style.width = `${Math.round((estado.progresso || 0) * 100)}%`;
  $("mensagem").textContent = rodando ? `${estado.mensagem || ""}…`
    : estado.fase === "fim" ? `Pronto${estado.duracao != null ? ` em ${estado.duracao} s, ${estado.requisicoes} requisições` : ""}.`
    : estado.fase === "erro" ? "Deu erro." : (estado.mensagem || "");
  $("log").textContent = (estado.log || []).join("\n");
  for (const c of Object.keys(MULTI)) desenharMulti(c);

  const avisos = [];
  if (estado.erro) avisos.push(estado.erro);
  if (estado.bloqueio) avisos.push(`Resultado parcial: ${estado.bloqueio}. Busque de novo mais tarde; o que já foi lido fica guardado.`);
  if (estado.carrinhoMyp) {
    const { ok, falhas } = estado.carrinhoMyp;
    avisos.push({ html: esc(`${ok.length} item(ns) colocado(s) no seu carrinho da MYP.` + (falhas.length ? ` Problemas: ${falhas.join("; ")}.` : ""))
      + ' <a href="https://mypcards.com/carrinho" target="_blank" rel="noopener">Abrir o carrinho</a>' });
  }
  $("avisos").innerHTML = avisos.map((a) => `<div class="aviso">${a.html ?? esc(a)}</div>`).join("");

  const r = estado.resultado;
  $("resultado").hidden = !r;
  if (!r) return;
  desenharCarrinho(r);
  desenharOfertas(r);
  desenharCartas(r);
}

function desenharCarrinho(r) {
  const c = r.carrinho;
  const semEstoque = r.itens.filter((it) => !it.atendivel);
  let h = semEstoque.length
    ? `<div class="aviso">Sem estoque suficiente com esses filtros: ${semEstoque.map((it) => esc(`${it.qtd}x ${it.linha}`)).join(", ")}</div>` : "";
  if (!c) {
    $("aba-carrinho").innerHTML = h + "<p>Não deu para montar um carrinho com essas cartas e filtros.</p>";
    return;
  }
  const economia = c.baseTotal != null ? c.baseTotal - c.total : null;
  h += `<div class="metricas">
    <div class="metrica"><span>Total</span><strong>${brl(c.total)}</strong></div>
    <div class="metrica"><span>Cartas</span><strong>${brl(c.cartas)}</strong></div>
    <div class="metrica"><span>Frete</span><strong>${brl(c.frete)}</strong></div>
    <div class="metrica"><span>Vendedores</span><strong>${c.vendedores.length}</strong></div>
    <div class="metrica"><span>Economia vs. mais barato por carta</span><strong class="ok">${brl(economia)}</strong></div>
  </div>
  <div class="acoes"><button type="button" id="colocar">Colocar tudo no meu carrinho da MYP</button></div>`;
  for (const v of c.vendedores) {
    const chips = [
      `<span class="chip">cartas ${brl(v.subtotal)}</span>`,
      v.frete ? `<span class="chip">frete ${brl(v.frete)} · ${esc(v.origem)}</span>` : '<span class="chip ok">frete grátis</span>',
      v.faltaGratis ? `<span class="chip alerta">faltam ${brl(v.faltaGratis)} p/ frete grátis</span>` : "",
      v.erroFrete ? `<span class="chip alerta">frete real indisponível: ${esc(v.erroFrete)}</span>` : "",
    ].join("");
    const opcoes = v.opcoes.length
      ? `<p class="dica">Opções de envio: ${v.opcoes.map((o) => esc(`${o.nome} ${brl(o.preco)}${o.prazo ? ` (${o.prazo})` : ""}`)).join(" · ")}</p>` : "";
    h += `<section class="cartao vendedor">
      <div class="topo"><h3><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.nick)}</a></h3>
        <span class="dica">${esc(v.cidade || "")}</span></div>
      <div class="chips">${chips}</div>${opcoes}
      <div class="tabela"><table><thead><tr><th class="num">Qtd</th><th>Carta</th><th>Qual.</th><th>Idioma</th><th>Extra</th><th class="num">Preço un.</th></tr></thead><tbody>
      ${v.linhas.map((l) => `<tr><td class="num">${l.qtd}</td><td><a href="${esc(l.link)}" target="_blank" rel="noopener">${esc(l.carta)}</a></td>
        <td>${esc(l.qualidade)}</td><td>${esc(l.idioma)}</td><td>${esc(l.printing || "")}</td><td class="num">${brl(l.preco)}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  }
  $("aba-carrinho").innerHTML = h;
  $("colocar").addEventListener("click", () => {
    const itens = c.vendedores.flatMap((v) => v.linhas.map((l) => ({ idEstoque: l.idEstoque, qtd: l.qtd, nome: `${l.carta} (${v.nick})` })));
    if (!confirm(`Colocar ${itens.length} oferta(s) no seu carrinho da MYP? Nada é comprado; você revisa e finaliza lá.`)) return;
    enviar({ tipo: "colocarNoCarrinho", itens });
  });
}

let cartaSelecionada = 0;
let soValidas = true;
let filtroVendedor = "";

function desenharOfertas(r) {
  if (cartaSelecionada >= r.itens.length) cartaSelecionada = 0;
  const it = r.itens[cartaSelecionada];
  const ofertas = (it?.ofertas || []).filter((o) => (!soValidas || o.valida)
    && (!filtroVendedor || o.vendedor.toLowerCase().includes(filtroVendedor.toLowerCase())));
  const precos = ofertas.map((o) => o.preco);
  $("aba-ofertas").innerHTML = `
    <div class="filtros-ofertas">
      <label>Carta<select id="selCarta">${r.itens.map((x, i) => `<option value="${i}" ${i === cartaSelecionada ? "selected" : ""}>${esc(`${x.qtd}x ${x.linha}`)}</option>`).join("")}</select></label>
      <label>Vendedor<input id="filtroVendedor" value="${esc(filtroVendedor)}" placeholder="contém…"></label>
      <label class="linha"><input type="checkbox" id="soValidas" ${soValidas ? "checked" : ""}> Só as que passam nos filtros</label>
    </div>
    <p class="dica">${ofertas.length} oferta(s)${precos.length ? ` · menor ${brl(Math.min(...precos))} · mediana ${brl(precos[Math.floor(precos.length / 2)])}` : ""}.
      Só aparecem as páginas que a busca precisou ler (${it?.paginasLidas ?? 0}); ofertas mais caras que isso não mudariam o carrinho.</p>
    <div class="tabela"><table><thead><tr><th>🛒</th><th>Vendedor</th><th class="num">Preço</th><th class="num">Qtd</th><th>Qual.</th><th>Idioma</th><th>Extra</th><th>Edição</th></tr></thead><tbody>
    ${ofertas.map((o) => `<tr class="${o.valida ? "" : "invalida"}"><td>${o.noCarrinho ? "🛒" : ""}</td>
      <td><a href="https://mypcards.com/${encodeURIComponent(o.vendedor)}" target="_blank" rel="noopener">${esc(o.vendedor)}</a></td>
      <td class="num">${brl(o.preco)}</td><td class="num">${o.quantidade}</td><td>${esc(o.qualidade)}</td><td>${esc(o.idioma)}</td>
      <td>${esc(o.printing || "")}</td><td><a href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.carta)}</a></td></tr>`).join("")}
    </tbody></table></div>`;
  $("selCarta").addEventListener("change", (e) => { cartaSelecionada = Number(e.target.value); desenharOfertas(r); });
  $("soValidas").addEventListener("change", (e) => { soValidas = e.target.checked; desenharOfertas(r); });
  $("filtroVendedor").addEventListener("change", (e) => { filtroVendedor = e.target.value; desenharOfertas(r); });
}

function desenharCartas(r) {
  $("aba-cartas").innerHTML = `<div class="tabela"><table><thead><tr><th class="num">Qtd</th><th>Carta</th><th class="num">Edições c/ oferta</th>
    <th class="num">Páginas lidas</th><th class="num">Ofertas válidas</th><th class="num">Candidatas</th><th class="num">Disponível</th><th>Aviso</th></tr></thead><tbody>
    ${r.itens.map((it) => `<tr><td class="num">${it.qtd}</td><td>${esc(it.linha)}</td><td class="num">${it.edicoes}</td><td class="num">${it.paginasLidas}</td>
      <td class="num">${it.validas}</td><td class="num">${it.candidatas}</td><td class="num">${it.disponivel}</td><td>${esc(it.aviso || "")}</td></tr>`).join("")}
    </tbody></table></div>`;
}

// ------------------------------------------------------------------ início
chrome.storage.onChanged.addListener((mud, area) => {
  if (area === "local" && mud.estado) {
    estado = mud.estado.newValue || { fase: "parado" };
    desenhar();
  }
});

(async () => {
  const cfg = await carregarConfig();
  await carregarJogos(cfg.jogo);
  ({ estado = { fase: "parado" } } = await chrome.storage.local.get("estado"));
  desenhar();
})();
