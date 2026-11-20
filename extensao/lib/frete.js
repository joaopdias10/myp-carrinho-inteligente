// Frete real pelo carrinho da MYP, no carrinho do próprio usuário.
//
// Para cada vendedor ainda sem cotação:
//   - se o vendedor já está no carrinho do usuário, lê o frete dele sem mexer nos itens;
//   - senão, adiciona 1 unidade de uma oferta dele, lê o frete e remove depois.
// Só remove o que a extensão colocou. Informar o CEP pode trocar o CEP selecionado no
// carrinho do usuário. Nada é comprado.
import { BloqueioMyp, Cancelado, ErroMyp, parseBrl, texto } from "./myp.js";

const LOTE = 8; // vendedores por rodada (o site limita o tamanho do carrinho)

export function cepValido(cep) {
  const d = (cep || "").replace(/\D/g, "");
  if (d.length !== 8) throw new Error("CEP precisa ter 8 dígitos");
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

/** Opções 'Nome (R$ X) prazo' do HTML de formas de envio de uma loja. */
export function opcoesDoHtml(raiz) {
  const out = [];
  for (const label of raiz.querySelectorAll("label")) {
    const txt = texto(label);
    const re = /([^()]+?)\s*\(R\$\s*([\d.]+,\d{2})\)\s*((?:até\s+)?\d+\s+dias(?:\s+úteis)?)?/g;
    for (const m of txt.matchAll(re)) {
      let nome = m[1].replace(/^(Correios|Valores estimados.*?\.)\s+/, "$1 ").trim();
      nome = nome.replace(/^.*?(até \d+ dias(?: úteis)?)\s+/, "");
      const preco = parseBrl("R$ " + m[2]);
      if (preco != null) out.push({ nome, preco, prazo: (m[3] || "").trim() });
    }
  }
  const vistos = new Set();
  return out.filter((o) => {
    const k = `${o.nome}|${o.preco}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

export function melhorOpcao(fr) {
  return fr?.opcoes?.length ? fr.opcoes.reduce((a, b) => (b.preco < a.preco ? b : a)) : null;
}

/** Lojas do carrinho: [{idVendedor, nick, el, idsEstoque}] e o token CSRF. */
export function lerCarrinho(doc) {
  const lojas = [];
  for (const el of doc.querySelectorAll("[id^=carrinho-da-loja-]")) {
    const idVendedor = el.getAttribute("data-idvendedor") || el.id.split("-").pop();
    const a = el.querySelector("a.carrinho-vendedor-nome")
      || [...el.querySelectorAll("a[href]")].find((x) => /^\/[^/?#]+$/.test(x.getAttribute("href")));
    const nick = a ? a.getAttribute("href").slice(1) : null;
    const idsEstoque = [...el.querySelectorAll(".carrinho-item-card[data-idestoque]")]
      .map((x) => parseInt(x.getAttribute("data-idestoque"), 10));
    lojas.push({ idVendedor, nick, el, idsEstoque });
  }
  const csrf = doc.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
  return { lojas, csrf };
}

export class CotadorFrete {
  constructor(cli, cep) {
    this.cli = cli;
    this.cep = cep ? cepValido(cep) : null;
    this.cache = new Map(); // nick -> {vendedor, opcoes, erro}
  }

  async _carrinho() {
    return lerCarrinho(await this.cli.doc("/carrinho", { usaCache: false }));
  }

  /** amostras: {nick: idEstoque}. Devolve {nick: cotação} (usa o que já foi cotado). */
  async cotar(amostras, progresso = () => {}) {
    const faltam = Object.keys(amostras).filter((v) => !this.cache.has(v));
    for (let i = 0; i < faltam.length; i += LOTE) {
      const lote = Object.fromEntries(faltam.slice(i, i + LOTE).map((v) => [v, amostras[v]]));
      progresso(i / Math.max(faltam.length, 1),
        `Cotando o frete de ${Object.keys(lote).length} vendedor(es)${this.cep ? ` para o CEP ${this.cep}` : ""}`);
      try {
        await this._cotarLote(lote);
      } catch (e) {
        if (e instanceof BloqueioMyp || e instanceof Cancelado) throw e;
        for (const v of Object.keys(lote)) {
          if (!this.cache.has(v)) this.cache.set(v, { vendedor: v, opcoes: [], erro: e.message });
        }
      }
    }
    return Object.fromEntries(Object.keys(amostras).filter((v) => this.cache.has(v))
      .map((v) => [v, this.cache.get(v)]));
  }

  async _cotarLote(lote) {
    const adicionados = [];
    try {
      const antes = await this._carrinho();
      const noCarrinho = new Set(antes.lojas.map((l) => l.nick));
      for (const [v, idEstoque] of Object.entries(lote)) {
        if (noCarrinho.has(v)) continue; // já tem itens desse vendedor: só lê o frete
        const txt = await this.cli.http(`/carrinho/adicionar?idestoque=${idEstoque}&qtd=1&override=0`,
          { ajax: true, usaCache: false });
        let cod = null;
        let msg = "";
        try { ({ errCode: cod, errmessage: msg = "" } = JSON.parse(txt)); } catch { msg = txt.slice(0, 120); }
        if (cod === 1 || cod === 5) adicionados.push(idEstoque);
        else this.cache.set(v, { vendedor: v, opcoes: [], erro: `não consegui pôr no carrinho (código ${cod}${msg ? `: ${msg}` : ""})` });
      }
      let { csrf } = await this._carrinho();
      if (this.cep) {
        await this.cli.http("/carrinho/selecionar-endereco",
          { metodo: "POST", dados: { cep: this.cep }, ajax: true, csrf, usaCache: false });
      }
      const depois = await this._carrinho();
      csrf = depois.csrf;
      for (const loja of depois.lojas) {
        if (!(loja.nick in lote) || this.cache.has(loja.nick)) continue;
        let raiz = loja.el;
        const provedores = new Set([...loja.el.querySelectorAll("input[data-provedor-frete]")]
          .map((i) => i.getAttribute("data-provedor-frete")).filter(Boolean));
        if (!provedores.size) provedores.add("Correios"); // sem opções no HTML: pede o cálculo mesmo assim
        for (const prov of provedores) {
          const txt = await this.cli.http(`/carrinho/atualizar-frete?t=${Date.now()}`, {
            metodo: "POST", ajax: true, csrf, usaCache: false,
            dados: { idvendedor: loja.idVendedor, recalcularFreteProvedor: "true", provedorFrete: prov },
          });
          try {
            const html = JSON.parse(txt).formasDeEnvioHtml;
            if (html) raiz = this.cli.parse(`<div>${html}</div>`);
          } catch { /* mantém o HTML do carrinho */ }
        }
        const opcoes = opcoesDoHtml(raiz);
        const trecho = opcoes.length ? "" : (raiz.textContent || "").replace(/\s+/g, " ").match(/Formas de envio.{0,160}/)?.[0] || "";
        this.cache.set(loja.nick, { vendedor: loja.nick, opcoes,
          erro: opcoes.length ? null : `vendedor sem frete com preço${trecho ? ` (${trecho})` : ""}` });
      }
      const nicks = depois.lojas.map((l) => l.nick).join(", ");
      for (const v of Object.keys(lote)) {
        if (!this.cache.has(v)) this.cache.set(v, { vendedor: v, opcoes: [], erro: `vendedor não apareceu no carrinho (lojas lidas: ${nicks || "nenhuma"})` });
      }
    } finally {
      if (adicionados.length) {
        try {
          const { csrf } = await this._carrinho();
          for (const id of adicionados) {
            await this.cli.http(`/carrinho/remover?idestoque=${id}`,
              { metodo: "POST", dados: {}, ajax: true, csrf, usaCache: false });
          }
        } catch (e) {
          this.cli.log(`não consegui tirar do carrinho os itens de teste (${e.message}); confira o carrinho na MYP`);
        }
      }
    }
  }
}

/** Coloca a alocação escolhida no carrinho do usuário. [{idEstoque, qtd}] -> relatório. */
export async function colocarNoCarrinho(cli, itens, progresso = () => {}) {
  const ok = [];
  const falhas = [];
  for (const [k, { idEstoque, qtd, nome }] of itens.entries()) {
    progresso(k / itens.length, `Colocando no carrinho: ${nome}`);
    try {
      const txt = await cli.http(`/carrinho/adicionar?idestoque=${idEstoque}&qtd=${qtd}&override=0`,
        { ajax: true, usaCache: false });
      let cod = null;
      try { cod = JSON.parse(txt).errCode; } catch { /* */ }
      if (cod === 1) ok.push(nome);
      else if (cod === 5) falhas.push(`${nome}: quantidade ajustada pela MYP`);
      else if (cod === 9) { falhas.push(`${nome}: carrinho cheio`); break; }
      else falhas.push(`${nome}: código ${cod}`);
    } catch (e) {
      if (e instanceof BloqueioMyp || e instanceof Cancelado) throw e;
      falhas.push(`${nome}: ${e.message}`);
    }
  }
  return { ok, falhas };
}

export { ErroMyp };
