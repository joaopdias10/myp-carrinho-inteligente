// Página do app: formulário, progresso e resultados. A busca roda no documento offscreen;
// esta página só manda comandos e desenha o estado gravado em chrome.storage.local.

const $ = (id) => document.getElementById(id);
const CAMPOS = ["jogo", "lista", "qualidadeMin", "idiomas", "printingsExcluir", "excluir", "freteReal",
  "cep", "padrao", "uf", "mesmoUf", "maxPaginas", "token"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const lista = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const enviar = (msg) => chrome.runtime.sendMessage({ para: "bg", ...msg });

let estado = { fase: "parado" };

// ------------------------------------------------------------------ configuração salva
async function carregarConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  for (const c of CAMPOS) {
    if (!(c in config)) continue;
    if ($(c).type === "checkbox") $(c).checked = config[c];
    else $(c).value = config[c];
  }
  return config;
}

function lerConfig() {
  return Object.fromEntries(CAMPOS.map((c) => [c, $(c).type === "checkbox" ? $(c).checked : $(c).value]));
}

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
  } catch { /* fica só com Pokémon */ }
  $("jogo").value = atual || "pokemon";
  if (!$("jogo").value) $("jogo").value = "pokemon";
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
        qualidadeMin: cfg.qualidadeMin, idiomas: lista(cfg.idiomas),
        excluir: lista(cfg.excluir), printingsExcluir: lista(cfg.printingsExcluir),
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
