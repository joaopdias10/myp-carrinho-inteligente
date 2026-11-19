// Acesso à MYP Cards a partir do navegador do usuário.
// Mesma lógica do myp_carrinho/cliente.py: API oficial para achar as cartas e as páginas do
// site para ofertas e vendedores. As requisições saem com os cookies do usuário na MYP.

export const BASE = "https://mypcards.com";
export const QUALIDADES = ["NM", "SP", "MP", "HP", "DM"]; // melhor -> pior

export class ErroMyp extends Error {}
export class BloqueioMyp extends ErroMyp {}
export class Cancelado extends Error {}

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseBrl(txt) {
  if (!txt) return null;
  const m = txt.replace(/ /g, " ").match(/R\$\s*([\d.]+,\d{2})/);
  return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : null;
}

export function norm(s) {
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/** Texto do elemento com espaço entre os nós (como get_text(" ") do BeautifulSoup). */
export function texto(el) {
  if (!el) return "";
  const partes = [];
  const anda = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) partes.push(c.nodeValue);
      else if (c.nodeType === 1 && c.nodeName !== "SCRIPT" && c.nodeName !== "STYLE") anda(c);
    }
  };
  anda(el);
  return partes.map((p) => p.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const IDIOMAS_API = {
  portuguese: "Português", english: "Inglês", japanese: "Japonês", korean: "Coreano",
  chinese: "Chinês", spanish: "Espanhol", french: "Francês", german: "Alemão",
  italian: "Italiano", russian: "Russo",
};

// ------------------------------------------------------------------ parsers (puros)
export function produtoDeJson(j) {
  const precosNm = [];
  for (const p of j.prices || []) {
    const v = parseFloat(p.min_price);
    if (!Number.isNaN(v)) {
      const lang = (p.language || "").trim();
      precosNm.push([IDIOMAS_API[lang.toLowerCase()] || lang, v]);
    }
  }
  const codigo = j.card_code || "";
  return {
    id: j.internal_code,
    nome: j.name_pt || j.name_en || "",
    edicao: (j.edition_code || "").toUpperCase(),
    codigo,
    numero: codigo.includes("_") ? codigo.slice(codigo.lastIndexOf("_") + 1) : "",
    link: j.link || `${BASE}/produto/${j.internal_code}`,
    img: j.img_pt || j.img_en || null,
    temOferta: Boolean((j.prices || []).length) || j.min_price != null,
    precosNm,
  };
}

export function lerLinhaOferta(tr, idProduto) {
  if (!tr.querySelector(".addToCart[data-idestoque]")) return null; // não adicionável
  const vend = tr.querySelector("a.nome-vendedor-apelido");
  const precoTd = tr.querySelector("td.estoque-lista-precoestoque");
  const qtdTd = tr.querySelector("td.estoque-lista-quantidadeestoque");
  if (!vend || !precoTd || !qtdTd) return null;
  const valores = texto(precoTd).match(/R\$\s*[\d.]+,\d{2}/g) || [];
  const preco = valores.length ? parseBrl(valores[valores.length - 1]) : null; // último = preço atual
  const qtd = parseInt(texto(qtdTd).replace(/\D/g, "") || "0", 10);
  if (preco == null || !qtd) return null;
  const chip = tr.querySelector("td.estoque-lista-qualidadenome .qualidade-texto span[title]");
  const bandeira = tr.querySelector("td.estoque-lista-qualidadenome .flag-icon[title]");
  const extra = tr.querySelector("td.estoque-lista-nomeenfoil");
  const o = {
    idEstoque: parseInt(tr.getAttribute("data-key"), 10),
    idProduto,
    vendedor: vend.textContent.trim(),
    preco,
    quantidade: qtd,
    qualidade: chip ? chip.textContent.trim().toUpperCase() : "?",
    idioma: bandeira ? bandeira.getAttribute("title") : "?",
    printing: extra ? (texto(extra) || null) : null,
    versao: null,
    obs: null,
  };
  const res = tr.querySelector("[data-resumo]");
  if (res) {
    try {
      const r = JSON.parse(res.getAttribute("data-resumo"));
      o.versao = r.versao ?? null;
      o.obs = r.obs ?? null;
      o.printing = r.printing || o.printing;
    } catch { /* só complemento */ }
  }
  return o;
}

/** Ofertas de uma página das duas tabelas e o menor preço possível nas páginas seguintes. */
export function lerOfertas(doc, idProduto, pag) {
  const ofertas = [];
  const pisos = [];
  for (const tabela of doc.querySelectorAll("table")) {
    const linhas = tabela.querySelectorAll("tr[data-key]");
    if (!linhas.length) continue;
    const precos = [];
    for (const tr of linhas) {
      const o = lerLinhaOferta(tr, idProduto);
      if (o) { ofertas.push(o); precos.push(o.preco); }
    }
    const grade = tabela.closest(".grid-view") || tabela.parentElement;
    const temMais = [...grade.querySelectorAll(".pagination a")]
      .some((a) => a.textContent.trim() === String(pag + 1));
    if (temMais) pisos.push(precos.length ? Math.max(...precos) : 0);
  }
  return { ofertas, piso: pisos.length ? Math.min(...pisos) : null };
}

export function lerVendedor(doc, nick) {
  const v = { nick, cidade: null, freteGratisAPartir: null, freteEstimado: null };
  const c = doc.querySelector("span.cidade");
  if (c) v.cidade = texto(c);
  const fg = doc.querySelector(".frete-gratis .valor-frete") || doc.querySelector(".frete-gratis");
  if (fg) v.freteGratisAPartir = parseBrl(texto(fg));
  const fe = doc.querySelector(".loja-frete-estimado");
  if (fe && !fe.querySelector('a[href="/login"]')) {
    const t = texto(fe);
    v.freteEstimado = /gr[aá]tis/i.test(t) ? 0 : parseBrl(t);
  }
  return v;
}

export function lerBusca(doc, jogo) {
  const out = [];
  for (const li of doc.querySelectorAll("li.stream-item")) {
    const a = li.querySelector(`a[href^="/${jogo}/produto/"]`);
    const nomeEl = li.querySelector(".card-name h3") || li.querySelector("h3");
    if (!a || !nomeEl) continue;
    const m = a.getAttribute("href").match(new RegExp(`^/${jogo}/produto/(\\d+)/`));
    if (!m) continue;
    const titulo = (nomeEl.getAttribute("title") || texto(nomeEl)).replace(/\s+/g, " ").trim();
    const num = titulo.match(/\(([^)]+)\)\s*$/);
    const ed = li.querySelector(".card-edicao");
    const qtd = (li.querySelector(".quantidade-num")?.textContent || "").trim();
    out.push({
      id: parseInt(m[1], 10),
      nome: titulo.replace(/\s*\([^)]*\)\s*$/, ""),
      edicao: (ed ? ed.textContent.trim() : "").toUpperCase(),
      codigo: num ? "_" + num[1] : "",
      numero: num ? num[1] : "",
      link: BASE + a.getAttribute("href"),
      img: null,
      temOferta: /^\d+$/.test(qtd) && parseInt(qtd, 10) > 0,
      precosNm: [],
    });
  }
  return out;
}

// ------------------------------------------------------------------ cliente HTTP
export class Cliente {
  /**
   * token: X-Api-Token da API oficial (opcional, sobe o limite de 10 para 60 req/min).
   * intervalo: ritmo entre páginas do site; rajadas fazem o Cloudflare bloquear.
   */
  constructor({ token = null, intervalo = 4000, cacheHoras = 6, log = () => {}, parseHTML } = {}) {
    this.token = token?.trim() || null;
    this.intervalo = intervalo;
    this.intervaloApi = this.token ? 1100 : 6500;
    this.cacheMs = cacheHoras * 3600e3;
    this.log = log;
    this.parse = parseHTML || ((h) => new DOMParser().parseFromString(h, "text/html"));
    this.ultimo = 0;
    this.ultimoApi = 0;
    this.bloqueadoAte = 0;
    this.cancelado = false;
    this.vendedores = new Map();
    this.requisicoes = 0;
  }

  checar() {
    if (this.cancelado) throw new Cancelado("busca cancelada");
    const falta = this.bloqueadoAte - Date.now();
    if (falta > 0) {
      throw new BloqueioMyp(`a MYP limitou o acesso temporariamente; tente de novo em ~${Math.ceil(falta / 60000)} min`);
    }
  }

  async _cacheLer(url) {
    if (typeof caches === "undefined") return null;
    const c = await caches.open("myp-v1");
    const r = await c.match(url);
    if (!r || Date.now() - Number(r.headers.get("x-quando") || 0) > this.cacheMs) return null;
    return r.text();
  }

  async _cacheGravar(url, txt) {
    if (typeof caches === "undefined") return;
    const c = await caches.open("myp-v1");
    await c.put(url, new Response(txt, { headers: { "x-quando": String(Date.now()) } }));
  }

  /** GET/POST com ritmo constante, cache (só GET de páginas e API) e tratamento de bloqueio. */
  async http(caminho, { metodo = "GET", dados = null, ajax = false, csrf = null, usaCache = true } = {}) {
    const url = caminho.startsWith("http") ? caminho : BASE + caminho;
    const api = url.includes("/api/v1/");
    const cacheavel = usaCache && metodo === "GET" && !ajax;
    if (cacheavel) {
      const c = await this._cacheLer(url);
      if (c != null) return c;
    }
    const headers = {};
    if (api) {
      headers.Accept = "application/json";
      if (this.token) headers["X-Api-Token"] = this.token;
    }
    if (ajax) { headers["X-Requested-With"] = "XMLHttpRequest"; headers.Accept = "*/*"; }
    let corpo;
    if (dados || csrf) {
      corpo = new URLSearchParams({ ...(dados || {}), ...(csrf ? { _csrf: csrf } : {}) });
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }

    let r = null;
    let txt = "";
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      this.checar();
      const ult = api ? this.ultimoApi : this.ultimo;
      const intervalo = api ? this.intervaloApi : this.intervalo;
      const espera = intervalo * (0.9 + Math.random() * 0.35) - (Date.now() - ult);
      if (espera > 0) await dormir(espera);
      this.checar();
      try {
        this.requisicoes++;
        r = await fetch(url, { method: metodo, headers, body: corpo, credentials: "include", cache: "no-store" });
        txt = await r.text();
      } catch (e) {
        this.log(`erro de rede (${e.message}); tentando de novo`);
        r = null;
        await dormir(5000 * (tentativa + 1));
        continue;
      } finally {
        if (api) this.ultimoApi = Date.now(); else this.ultimo = Date.now();
      }
      if (r.status === 403 && txt.slice(0, 600).includes("Just a moment")) {
        this.intervalo = Math.min(this.intervalo * 1.5, 10000);
        if (tentativa === 0) {
          this.log("verificação do Cloudflare; aguardando 45 s");
          await dormir(45000);
          continue;
        }
        this.bloqueadoAte = Date.now() + 240e3;
        this.checar();
      }
      if (r.status === 429 || r.status >= 500) {
        const pausa = Number(r.headers.get("Retry-After")) || (api ? 61 : 20 * (tentativa + 1));
        this.log(`HTTP ${r.status}; aguardando ${pausa} s`);
        await dormir(pausa * 1000);
        continue;
      }
      break;
    }
    if (!r || !r.ok) throw new ErroMyp(`falha ao abrir ${url} (HTTP ${r ? r.status : "?"})`);
    if (cacheavel) await this._cacheGravar(url, txt);
    return txt;
  }

  async doc(caminho, opcoes) {
    return this.parse(await this.http(caminho, opcoes));
  }

  // --------------- API oficial
  async jogos() {
    const j = JSON.parse(await this.http("/api/v1/jogos"));
    return (j.games || []).map((g) => ({ slug: g.slug, nome: g.name }));
  }

  async produto(id) {
    return produtoDeJson(JSON.parse(await this.http(`/api/v1/produto/${id}`)));
  }

  async buscarApi(jogo, nome) {
    const j = JSON.parse(await this.http(`/api/v1/${jogo}/carta/${encodeURIComponent(nome)}`));
    return (j.cards || []).map(produtoDeJson);
  }

  // --------------- site
  async buscarSite(jogo, consulta) {
    const q = encodeURIComponent(consulta).replace(/%20/g, "+");
    return lerBusca(await this.doc(`/${jogo}?ProdutoSearch%5Bquery%5D=${q}`), jogo);
  }

  async paginaOfertas(produto, pag) {
    const url = pag === 1 ? produto.link
      : `${produto.link}?estoque-cert-page=${pag}&estoque-outros-page=${pag}`;
    return lerOfertas(await this.doc(url), produto.id, pag);
  }

  async vendedor(nick) {
    if (this.vendedores.has(nick)) return this.vendedores.get(nick);
    let v = { nick, cidade: null, freteGratisAPartir: null, freteEstimado: null };
    try {
      v = lerVendedor(await this.doc(`/${encodeURIComponent(nick)}`), nick);
    } catch (e) {
      if (e instanceof BloqueioMyp || e instanceof Cancelado) throw e;
      this.log(`não consegui ler o vendedor ${nick}: ${e.message}`);
    }
    this.vendedores.set(nick, v);
    return v;
  }
}

export function ufDe(v) {
  const m = (v.cidade || "").match(/ - ([A-Z]{2})$/);
  return m ? m[1] : null;
}
