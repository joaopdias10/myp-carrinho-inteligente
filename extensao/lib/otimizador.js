// Lista de cartas -> ofertas -> vendedores com menor (preço + frete).
// Porte de myp_carrinho/otimizacao.py. O ótimo exato usa o HiGHS em WebAssembly
// (vendor/highs); a busca local fica de reserva se o solver não carregar.
import { BloqueioMyp, Cancelado, ErroMyp, QUALIDADES, norm, ufDe } from "./myp.js";
import { melhorOpcao } from "./frete.js";

// ================================================================ lista
export function lerLista(textoLista) {
  const itens = [];
  for (const bruto of textoLista.split(/\r?\n/)) {
    const linha = bruto.split("#")[0].trim();
    if (!linha) continue;
    const m = linha.match(/^(\d+)\s*x?\s+(.+)$/i);
    itens.push(m ? [parseInt(m[1], 10), m[2].trim()] : [1, linha]);
  }
  return itens;
}

const bateNumero = (p, numero) => {
  const a = (p.numero.split("/")[0].replace(/^0+/, "") || "0").toLowerCase();
  const b = (numero.split("/")[0].replace(/^0+/, "") || "0").toLowerCase();
  return a === b;
};

/** URL, ID, 'nome | EDIÇÃO número', 'nome | EDIÇÃO' ou só 'nome' -> edições da carta. */
export async function resolver(cli, jogo, alvo) {
  const m = alvo.match(/\/produto\/(\d+)/) || alvo.match(/^(\d+)$/);
  if (m) return { produtos: [await cli.produto(parseInt(m[1], 10))], aviso: null };

  const [nomeBruto, filtro = ""] = alvo.split("|");
  const nome = nomeBruto.trim();
  const partes = filtro.trim().split(/\s+/).filter(Boolean);
  const edicao = partes[0]?.toUpperCase();
  const numero = partes[1];

  let aviso = null;
  let cands = await cli.buscarApi(jogo, nome);
  if (!cands.length) {
    aviso = "nome não encontrado na API; usei a busca do site";
    const metas = (await cli.buscarSite(jogo, nome)).slice(0, 25);
    const exatos = metas.filter((p) => norm(p.nome) === norm(nome));
    cands = exatos.length ? exatos : metas.filter((p) => norm(p.nome).includes(norm(nome)));
    if (!cands.length && edicao) cands = metas;
  }
  const antes = cands;
  if (edicao) cands = cands.filter((p) => p.edicao.toUpperCase() === edicao);
  if (numero) cands = cands.filter((p) => bateNumero(p, numero));
  if (!cands.length && antes.length) {
    const eds = [...new Set(antes.map((p) => `${p.edicao} ${p.numero}`))].sort();
    aviso = "nenhuma edição bateu com o filtro. Disponíveis: " + eds.slice(0, 20).join(", ");
  }
  return { produtos: cands, aviso };
}

export function novoItem(linha, qtd) {
  return { linha, qtd, produtos: [], todasOfertas: [], ofertas: [], candidatas: [], estado: {}, aviso: null, paginasLidas: 0 };
}

export function nomeProduto(it, idProduto) {
  const p = it.produtos.find((x) => x.id === idProduto);
  return p ? `${p.nome} (${p.edicao} ${p.numero})`.trim() : it.linha;
}

export function linkProduto(it, idProduto) {
  return it.produtos.find((x) => x.id === idProduto)?.link || null;
}

export const disponivel = (it) => it.ofertas.reduce((s, o) => s + o.quantidade, 0);

// ================================================================ filtros e poda
// Folga do limiar em múltiplos do maior frete (veja otimizacao.py): 1.0 abre bem menos páginas.
export const FOLGA_FRETE = 1.0;
const FATOR_QUALIDADE = { NM: 1.0, SP: 0.6, MP: 0.45, HP: 0.3, DM: 0.2 };

export function limiar(ofertas, qtd, freteMax) {
  let acum = 0;
  for (const o of ofertas) {
    acum += o.quantidade;
    if (acum >= qtd) return o.preco + FOLGA_FRETE * freteMax;
  }
  return Infinity;
}

/** filtros: {qualidadeMin, idiomas[], excluir[], printingsExcluir[]} */
export function aplicarFiltros(itens, f, freteMax = null) {
  const qOk = new Set(QUALIDADES.slice(0, QUALIDADES.indexOf(f.qualidadeMin) + 1));
  const idiomas = new Set((f.idiomas || []).map(norm).filter(Boolean));
  const excluir = new Set((f.excluir || []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const sem = new Set((f.printingsExcluir || []).map(norm).filter(Boolean));
  for (const it of itens) {
    it.ofertas = it.todasOfertas.filter((o) => qOk.has(o.qualidade)
      && (!idiomas.size || idiomas.has(norm(o.idioma)))
      && !excluir.has(o.vendedor.toLowerCase())
      && !(o.printing && (sem.has(norm(o.printing)) || o.printing.split(",").some((e) => sem.has(norm(e))))))
      .sort((a, b) => a.preco - b.preco);
    if (freteMax == null) it.candidatas = [...it.ofertas];
    else {
      const lim = limiar(it.ofertas, it.qtd, freteMax);
      it.candidatas = it.ofertas.filter((o) => o.preco <= lim);
    }
  }
}

function pisoEdicao(p, f) {
  if (!p.precosNm.length) return 0; // sem informação: abre de qualquer jeito
  const idiomas = new Set((f.idiomas || []).map(norm).filter(Boolean));
  let precos = p.precosNm.filter(([lang]) => !idiomas.size || idiomas.has(norm(lang))).map(([, v]) => v);
  if (!precos.length) precos = p.precosNm.map(([, v]) => v);
  return Math.min(...precos) * (FATOR_QUALIDADE[f.qualidadeMin] ?? 0.2);
}

/** Abre só as páginas de ofertas que ainda podem baratear o carrinho. */
export async function completar(cli, itens, f, freteMax, maxPaginas = 10, progresso = () => {}) {
  let abertas = 0;
  for (const [i, it] of itens.entries()) {
    for (;;) {
      aplicarFiltros([it], f, freteMax);
      const lim = limiar(it.ofertas, it.qtd, freteMax);
      let proxima = null;
      for (const p of it.produtos) {
        if (!p.temOferta) continue;
        const st = (it.estado[p.id] ??= { paginas: 0, piso: 0, esgotada: false });
        if (st.esgotada || st.paginas >= maxPaginas) continue;
        const piso = st.paginas === 0 ? pisoEdicao(p, f) : st.piso;
        if (piso <= lim && (!proxima || piso < proxima.piso)) proxima = { piso, p, st };
      }
      if (!proxima) break;
      const { p, st } = proxima;
      progresso(i / itens.length, `${it.linha}: ${p.edicao} ${p.numero}, página ${st.paginas + 1}`);
      let res;
      try {
        res = await cli.paginaOfertas(p, st.paginas + 1);
      } catch (e) {
        if (e instanceof BloqueioMyp || e instanceof Cancelado) throw e;
        it.aviso = `algumas edições não carregaram (${e.message})`;
        st.esgotada = true;
        continue;
      }
      st.paginas++;
      it.paginasLidas++;
      abertas++;
      const vistos = new Set(it.todasOfertas.map((o) => o.idEstoque));
      it.todasOfertas.push(...res.ofertas.filter((o) => !vistos.has(o.idEstoque)));
      if (res.piso == null) st.esgotada = true;
      else st.piso = res.piso;
    }
  }
  progresso(1, "Ofertas carregadas");
  return abertas;
}

export async function carregarVendedores(cli, itens, progresso = () => {}) {
  const nicks = [...new Set(itens.flatMap((it) => it.candidatas.map((o) => o.vendedor)))].sort();
  const out = {};
  for (const [k, n] of nicks.entries()) {
    progresso(k / Math.max(nicks.length, 1), `Vendedor ${n} (${k + 1}/${nicks.length})`);
    try {
      out[n] = await cli.vendedor(n);
    } catch (e) {
      if (e instanceof Cancelado) throw e;
      out[n] = { nick: n, cidade: null, freteGratisAPartir: null, freteEstimado: null };
    }
  }
  progresso(1, "Vendedores carregados");
  return out;
}

// ================================================================ frete
export class RegraFrete {
  constructor({ padrao = 20, mesmoUf = null, uf = null } = {}) {
    this.padrao = padrao;
    this.mesmoUf = mesmoUf;
    this.uf = uf;
    this.reais = {}; // nick -> frete real (carrinho)
    // Durante a cotação: teto para quem ainda não foi cotado (o menor frete real já visto), para
    // que um vendedor com estimativa alta ainda tenha a chance de ser escolhido e cotado.
    this.otimista = null;
    this.tentados = new Set(); // já passaram pela cotação (com ou sem sucesso): sem teto otimista
  }
  custoBase(v) {
    if (v.nick in this.reais) return this.reais[v.nick];
    let c = this.padrao;
    if (v.freteEstimado != null) c = v.freteEstimado;
    else if (this.uf && this.mesmoUf != null && ufDe(v) === this.uf) c = this.mesmoUf;
    return this.otimista != null && !this.tentados.has(v.nick) ? Math.min(c, this.otimista) : c;
  }
  custo(v, subtotal) {
    if (v.freteGratisAPartir && subtotal >= v.freteGratisAPartir) return 0;
    return this.custoBase(v);
  }
  origem(v) {
    if (v.nick in this.reais) return "real (carrinho MYP)";
    if (v.freteEstimado != null) return "estimado pela MYP";
    if (this.uf && this.mesmoUf != null && ufDe(v) === this.uf) return "suposto (mesma UF)";
    return "suposto";
  }
  get maximo() {
    return Math.max(this.padrao, this.mesmoUf || 0, ...Object.values(this.reais));
  }
}

// ================================================================ otimização
function alocar(itens, permitidos) {
  const usado = new Map();
  const aloc = [];
  for (const it of itens) {
    let falta = it.qtd;
    for (const o of it.candidatas) {
      if (!falta) break;
      if (permitidos && !permitidos.has(o.vendedor)) continue;
      const livre = o.quantidade - (usado.get(o.idEstoque) || 0);
      if (livre <= 0) continue;
      const n = Math.min(livre, falta);
      usado.set(o.idEstoque, (usado.get(o.idEstoque) || 0) + n);
      aloc.push({ item: it, oferta: o, n });
      falta -= n;
    }
    if (falta) return null;
  }
  return aloc;
}

export function avaliar(aloc, vendedores, regra, metodo = "") {
  const subtotais = {};
  for (const { oferta: o, n } of aloc) subtotais[o.vendedor] = (subtotais[o.vendedor] || 0) + o.preco * n;
  const fretes = Object.fromEntries(Object.entries(subtotais)
    .map(([v, s]) => [v, regra.custo(vendedores[v], s)]));
  const cartas = Object.values(subtotais).reduce((a, b) => a + b, 0);
  const frete = Object.values(fretes).reduce((a, b) => a + b, 0);
  return { alocacao: aloc, subtotais, fretes, metodo, cartas, frete, total: cartas + frete };
}

export function maisBaratoPorCarta(itens, vendedores, regra) {
  const a = alocar(itens, null);
  return a ? avaliar(a, vendedores, regra, "mais barato por carta") : null;
}

function buscaLocal(itens, vendedores, regra, inicio) {
  const todos = Object.keys(vendedores);
  const custo = (U) => {
    const a = alocar(itens, U);
    return a ? [avaliar(a, vendedores, regra).total, a] : [Infinity, null];
  };
  let U = new Set(inicio);
  let [melhor, aloc] = custo(U);
  if (!aloc) return null;
  for (;;) {
    const usados = new Set(aloc.map((x) => x.oferta.vendedor));
    let achou = null;
    const tentar = (C) => {
      const [t, a] = custo(C);
      if (a && t < melhor - 0.005 && (!achou || t < achou[0])) achou = [t, a, C];
    };
    for (const v of usados) { const C = new Set(U); C.delete(v); tentar(C); }
    for (const v of todos) if (!U.has(v)) { const C = new Set(U); C.add(v); tentar(C); }
    if (!achou) break;
    [melhor, aloc, U] = achou;
  }
  return avaliar(aloc, vendedores, regra, "busca local");
}

/** Busca local partindo de todos os vendedores e do 'mais barato por carta'; fica com a melhor. */
export function heuristica(itens, vendedores, regra) {
  const base = maisBaratoPorCarta(itens, vendedores, regra);
  if (!base) return null;
  const a = buscaLocal(itens, vendedores, regra, Object.keys(vendedores));
  const b = buscaLocal(itens, vendedores, regra, Object.keys(base.subtotais));
  return [a, b].filter(Boolean).reduce((x, y) => (y.total < x.total ? y : x));
}

/**
 * Programação inteira com o HiGHS (o mesmo solver que o scipy usa no app Python):
 * x = unidades por oferta, y = vendedor usado, g = vendedor atingiu o frete grátis.
 * min Σ preço·x + Σ frete·y − Σ frete·g, com subtotal ≥ limiar·g e g ≤ y.
 */
export function exato(highs, itens, vendedores, regra, limiteSeg = 30) {
  const ofs = itens.flatMap((it, i) => it.candidatas.map((o) => ({ i, o })));
  const vs = [...new Set(ofs.map(({ o }) => o.vendedor))].sort();
  const vi = new Map(vs.map((v, k) => [v, k]));
  const fr = vs.map((v) => regra.custoBase(vendedores[v]));
  const lim = vs.map((v) => vendedores[v].freteGratisAPartir || 0);
  const n = (x) => (Math.round(x * 1e6) / 1e6).toString();
  const termos = (pares) => pares.map(([c, nome]) => `${c < 0 ? "-" : "+"} ${n(Math.abs(c))} ${nome}`).join(" ");

  const obj = [...ofs.map(({ o }, k) => [o.preco, `x${k}`]),
    ...vs.map((_, j) => [fr[j], `y${j}`]),
    ...vs.flatMap((_, j) => (lim[j] > 0 ? [[-fr[j], `g${j}`]] : []))].filter(([c]) => c !== 0);
  const linhas = [];
  itens.forEach((it, i) => {
    const xs = ofs.map((x, k) => [x, k]).filter(([x]) => x.i === i).map(([, k]) => `x${k}`);
    linhas.push(`item${i}: ${xs.join(" + ")} = ${it.qtd}`);
  });
  ofs.forEach(({ o }, k) => linhas.push(`abre${k}: x${k} - ${o.quantidade} y${vi.get(o.vendedor)} <= 0`));
  vs.forEach((v, j) => {
    if (lim[j] <= 0) return;
    linhas.push(`gy${j}: g${j} - y${j} <= 0`);
    const sub = ofs.map(({ o }, k) => [o, k]).filter(([o]) => o.vendedor === v).map(([o, k]) => [o.preco, `x${k}`]);
    linhas.push(`gratis${j}: ${termos(sub)} - ${n(lim[j])} g${j} >= 0`);
  });
  const lp = [
    "Minimize", ` obj: ${termos(obj) || "0 y0"}`,
    "Subject To", ...linhas.map((l) => ` ${l}`),
    "Bounds", ...ofs.map(({ o }, k) => ` 0 <= x${k} <= ${o.quantidade}`),
    "General", ` ${ofs.map((_, k) => `x${k}`).join(" ")}`,
    "Binary", ` ${vs.map((_, j) => `y${j}`).join(" ")} ${vs.map((_, j) => (lim[j] > 0 ? `g${j}` : "")).join(" ")}`,
    "End",
  ].join("\n");

  const r = highs.solve(lp, { output_flag: false, time_limit: limiteSeg, mip_rel_gap: 1e-9 });
  if (!r.Columns || !["Optimal", "Time limit reached"].includes(r.Status)) return null;
  const aloc = [];
  ofs.forEach(({ i, o }, k) => {
    const q = Math.round(r.Columns[`x${k}`]?.Primal || 0);
    if (q > 0) aloc.push({ item: itens[i], oferta: o, n: q });
  });
  if (!aloc.length) return null;
  return avaliar(aloc, vendedores, regra, r.Status === "Optimal" ? "exato (ótimo)" : "exato (melhor no tempo limite)");
}

/** Exato quando o solver está disponível; a busca local fica de reserva. */
export function otimizar(itens, vendedores, regra, highs = null) {
  const h = heuristica(itens, vendedores, regra);
  if (!highs || !h) return h;
  let e = null;
  try { e = exato(highs, itens, vendedores, regra); } catch { /* fica com a heurística */ }
  return e && e.total <= h.total + 0.005 ? e : h;
}

export const itensAtendiveis = (itens) => itens.filter((it) => disponivel(it) >= it.qtd);

// ================================================================ frete real

/**
 * Otimiza, cota o frete real dos vendedores escolhidos e otimiza de novo, até que todos os
 * vendedores do carrinho tenham frete real (ou acabem as rodadas).
 * Quem ainda não foi cotado entra com no máximo o menor frete real já visto: muitos vendedores
 * têm frete fixo bem abaixo do PAC/estimativa, e sem isso eles nunca seriam escolhidos para cotar.
 */
export async function otimizarComFreteReal(itens, vendedores, regra, cotador, highs = null, progresso = () => {}, maxRodadas = 8) {
  const cotados = {};
  let interrompido = null;
  for (let r = 0; r < maxRodadas; r++) {
    const reais = Object.values(regra.reais);
    regra.otimista = reais.length ? Math.min(...reais) : null;
    const res = otimizar(itens, vendedores, regra, highs);
    if (!res) break;
    const semReal = Object.keys(res.subtotais).filter((v) => !(v in cotados));
    if (!semReal.length) break;
    const amostras = {};
    for (const v of semReal) { // a oferta mais barata de cada vendedor serve de amostra
      let menor = null;
      for (const it of itens) for (const o of it.candidatas) if (o.vendedor === v && (!menor || o.preco < menor.preco)) menor = o;
      amostras[v] = menor.idEstoque;
    }
    try {
      const novos = await cotador.cotar(amostras, progresso);
      for (const [v, fr] of Object.entries(novos)) {
        cotados[v] = fr;
        const m = melhorOpcao(fr);
        if (m) regra.reais[v] = m.preco;
        cotador.cli?.log?.(m ? `frete real de ${v}: R$ ${m.preco.toFixed(2).replace(".", ",")} (${m.nome})`
          : `frete real de ${v}: sem valor (${fr.erro || "sem opções"})`);
      }
      for (const v of semReal) regra.tentados.add(v);
    } catch (e) {
      if (!(e instanceof BloqueioMyp)) throw e;
      interrompido = e.message;
      for (const v of semReal) cotados[v] ??= { vendedor: v, opcoes: [], erro: e.message };
      break;
    }
  }
  // resultado final com os valores de verdade: real onde houver, estimado/suposto no resto
  regra.otimista = null;
  return { res: otimizar(itens, vendedores, regra, highs), cotados, interrompido };
}

export { ErroMyp };
