// Compara a extensão (JS) com o código Python, sem acessar a MYP.
//   1. python testes_extensao/referencia.py > testes_extensao/ref.json   (PYTHONIOENCODING=utf-8)
//   2. cd testes_extensao && npm install && npm test
// Usa as páginas salvas em ../.cache_myp. Opcional: CARRINHO_HTML e FRETE_JSON apontando para
// um /carrinho salvo e uma resposta de /carrinho/atualizar-frete.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import carregarHighs from "highs";

import { Cliente, ErroMyp, lerOfertas, lerVendedor } from "../extensao/lib/myp.js";
import { lerCarrinho, opcoesDoHtml } from "../extensao/lib/frete.js";
import {
  RegraFrete, aplicarFiltros, carregarVendedores, completar, exato, heuristica, itensAtendiveis,
  lerLista, maisBaratoPorCarta, novoItem, otimizar, otimizarComFreteReal, resolver,
} from "../extensao/lib/otimizador.js";
import { montarResultado } from "../extensao/lib/resultado.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const CACHE = join(AQUI, "..", ".cache_myp");
const ref = JSON.parse(readFileSync(join(AQUI, "ref.json"), "utf-8"));
const { DOMParser } = new JSDOM("").window;
const parseHTML = (h) => new DOMParser().parseFromString(h, "text/html");
const highs = await carregarHighs();

let falhas = 0;
const confere = (ok, msg) => {
  if (!ok) { falhas++; console.log("  FALHOU:", msg); }
};
const quase = (a, b) => (a == null && b == null) || Math.abs(a - b) < 0.006;

// ------------------------------------------------------------------ 1. ofertas
let nOfertas = 0;
for (const [arq, esperado] of Object.entries(ref.paginas.ofertas)) {
  const doc = parseHTML(readFileSync(join(CACHE, arq), "utf-8"));
  const { ofertas, piso } = lerOfertas(doc, 1, 1);
  confere(ofertas.length === esperado.ofertas.length, `${arq}: ${ofertas.length} ofertas, Python ${esperado.ofertas.length}`);
  confere(quase(piso, esperado.piso), `${arq}: piso ${piso} vs ${esperado.piso}`);
  esperado.ofertas.forEach((p, k) => {
    const o = ofertas[k] || {};
    const pares = [["idEstoque", "id_estoque"], ["vendedor", "vendedor"], ["quantidade", "quantidade"],
      ["qualidade", "qualidade"], ["idioma", "idioma"], ["printing", "printing"], ["versao", "versao"], ["obs", "obs"]];
    for (const [j, py] of pares) confere((o[j] ?? null) === (p[py] ?? null), `${arq} #${k} ${j}: ${o[j]} vs ${p[py]}`);
    confere(quase(o.preco, p.preco), `${arq} #${k} preço ${o.preco} vs ${p.preco}`);
    nOfertas++;
  });
}
console.log(`1. ofertas: ${Object.keys(ref.paginas.ofertas).length} páginas, ${nOfertas} ofertas comparadas`);

// ------------------------------------------------------------------ 2. vendedores
for (const [arq, p] of Object.entries(ref.paginas.vendedores)) {
  const v = lerVendedor(parseHTML(readFileSync(join(CACHE, arq), "utf-8")), "nick");
  confere(v.cidade === p.cidade, `${arq}: cidade ${v.cidade} vs ${p.cidade}`);
  confere(quase(v.freteGratisAPartir, p.frete_gratis_a_partir), `${arq}: frete grátis ${v.freteGratisAPartir} vs ${p.frete_gratis_a_partir}`);
  confere(quase(v.freteEstimado, p.frete_estimado), `${arq}: estimado ${v.freteEstimado} vs ${p.frete_estimado}`);
}
console.log(`2. vendedores: ${Object.keys(ref.paginas.vendedores).length} páginas comparadas`);

// ------------------------------------------------------------------ 3. carrinho e frete
const htmlCarrinho = process.env.CARRINHO_HTML;
if (htmlCarrinho && existsSync(htmlCarrinho)) {
  const { lojas, csrf } = lerCarrinho(parseHTML(readFileSync(htmlCarrinho, "utf-8")));
  console.log(`3a. carrinho: ${lojas.map((l) => `${l.nick}#${l.idVendedor} itens=${l.idsEstoque.join(",")}`).join(" | ")}; csrf ${csrf ? "ok" : "ausente"}`);
  confere(lojas.length > 0 && lojas.every((l) => l.nick && l.idsEstoque.length), "carrinho sem lojas/itens");
  for (const l of lojas) console.log(`    opções no HTML do carrinho (${l.nick}):`, JSON.stringify(opcoesDoHtml(l.el)));
}
const jsonFrete = process.env.FRETE_JSON;
if (jsonFrete && existsSync(jsonFrete)) {
  const html = JSON.parse(readFileSync(jsonFrete, "utf-8")).formasDeEnvioHtml;
  const ops = opcoesDoHtml(parseHTML(`<div>${html}</div>`));
  console.log("3b. atualizar-frete:", JSON.stringify(ops));
  confere(ops.length > 0, "nenhuma opção de envio lida");
}

// ------------------------------------------------------------------ 4. coleta completa a partir do cache
class ClienteCache extends Cliente {
  async http(caminho) {
    let url = caminho.startsWith("http") ? caminho : "https://mypcards.com" + caminho;
    // o Python codifica ! ' ( ) * (quote); o encodeURIComponent não. Igualamos para achar no cache.
    url = url.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const arq = join(CACHE, createHash("sha1").update(url).digest("hex") + ".txt");
    if (!existsSync(arq)) throw new ErroMyp(`fora do cache: ${url}`);
    return readFileSync(arq, "utf-8");
  }
}
{
  const cli = new ClienteCache({ parseHTML });
  const filtros = { qualidadeMin: "SP", idiomas: [], excluir: [], printingsExcluir: [] };
  const regra = new RegraFrete({ padrao: 20 });
  const itens = [];
  for (const [qtd, alvo] of lerLista(ref.pipeline.lista)) {
    const it = novoItem(alvo, qtd);
    try { Object.assign(it, await resolver(cli, "pokemon", alvo)); } catch (e) { it.aviso = e.message; }
    itens.push(it);
  }
  await completar(cli, itens, filtros, regra.maximo, 10);
  aplicarFiltros(itens, filtros, regra.maximo);
  ref.pipeline.itens.forEach((p, k) => {
    const it = itens[k];
    confere(it.paginasLidas === p.paginas, `${p.linha}: páginas ${it.paginasLidas} vs ${p.paginas}`);
    confere(it.ofertas.length === p.validas, `${p.linha}: válidas ${it.ofertas.length} vs ${p.validas}`);
    confere(it.candidatas.length === p.candidatas, `${p.linha}: candidatas ${it.candidatas.length} vs ${p.candidatas}`);
  });
  const ok = itensAtendiveis(itens);
  const vend = await carregarVendedores(cli, ok);
  const t0 = Date.now();
  const e = exato(highs, ok, vend, regra);
  const ms = Date.now() - t0;
  const h = heuristica(ok, vend, regra);
  const final = otimizar(ok, vend, regra, highs);
  console.log(`4. coleta pelo cache: ${itens.map((it) => `${it.linha}=${it.paginasLidas}p/${it.candidatas.length}c`).join(", ")}`);
  console.log(`   exato JS R$ ${e?.total.toFixed(2)} (${ms} ms) | Python exato R$ ${ref.pipeline.exato?.toFixed(2)} | busca local JS R$ ${h?.total.toFixed(2)} | Python heurística R$ ${ref.pipeline.heuristica?.toFixed(2)}`);
  confere(quase(e?.total, ref.pipeline.exato), "exato difere do Python");
  confere(final.total <= e.total + 0.006, "otimizar não ficou com o exato");

  // estado de exemplo para olhar a interface (testes_extensao/ui.html), com um frete "real" fictício
  const nick = Object.keys(final.subtotais)[0];
  const cotados = { [nick]: { vendedor: nick, erro: null, opcoes: [{ nome: "PAC", preco: 23.3, prazo: "" }, { nome: "Frete Fixo com rastreio", preco: 12, prazo: "até 30 dias" }] } };
  regra.reais[nick] = 12;
  const comReal = otimizar(ok, vend, regra, highs);
  const resultado = montarResultado(itens, ok, comReal, maisBaratoPorCarta(ok, vend, regra), vend, regra, cotados);
  writeFileSync(join(AQUI, "ui_estado.json"), JSON.stringify({
    fase: "fim", progresso: 1, mensagem: "Pronto", duracao: 312, requisicoes: 41, log: ["exemplo gerado pelo teste offline"],
    bloqueio: null, resultado,
  }));
}

// ------------------------------------------------------------------ 5. instâncias sintéticas
{
  let iguais = 0;
  let piorQueHeuristicaPy = 0;
  for (const inst of ref.instancias) {
    const vend = Object.fromEntries(Object.entries(inst.vendedores).map(([k, v]) =>
      [k, { nick: v.nick, cidade: v.cidade, freteGratisAPartir: v.frete_gratis_a_partir, freteEstimado: v.frete_estimado }]));
    const itens = inst.itens.map((x) => ({
      ...novoItem(x.linha, x.qtd),
      todasOfertas: x.ofertas.map((o) => ({ idEstoque: o.id_estoque, idProduto: o.id_produto, vendedor: o.vendedor,
        preco: o.preco, quantidade: o.quantidade, qualidade: o.qualidade, idioma: o.idioma, printing: null })),
    }));
    aplicarFiltros(itens, { qualidadeMin: "DM" }, null);
    const regra = new RegraFrete({ padrao: inst.padrao });
    const e = exato(highs, itens, vend, regra);
    const h = heuristica(itens, vend, regra);
    if (quase(e?.total, inst.exato)) iguais++;
    else confere(false, `instância: exato JS ${e?.total} vs Python ${inst.exato}`);
    if (h.total > inst.heuristica + 0.006) piorQueHeuristicaPy++;
  }
  console.log(`5. ${ref.instancias.length} instâncias sintéticas: exato igual ao Python em ${iguais}; busca local JS pior que a do Python em ${piorQueHeuristicaPy}`);
}

// ------------------------------------------------------------------ 6. frete real: vendedor com estimativa alta
// Caso real (Yu-Gi-Oh!): logado, a MYP estima ~R$ 45 de frete para todos, mas no carrinho vários têm
// frete fixo bem menor. A RollCard (3 un. a R$ 2,99, frete real R$ 15) precisa ser cotada e escolhida.
{
  const oferta = (id, vendedor, preco, quantidade) => ({ idEstoque: id, idProduto: 1, vendedor, preco, quantidade,
    qualidade: "NM", idioma: "Português", printing: null });
  const fera = { ...novoItem("3 Fera", 3), todasOfertas: [oferta(1, "xNewbe", 1, 1), oferta(2, "Franklin", 1, 1),
    oferta(3, "Bortolatto", 1, 1), oferta(4, "TBCorp", 2.49, 3), oferta(5, "RollCard", 2.99, 3)] };
  const ponte = { ...novoItem("1 Ponte", 1), todasOfertas: [oferta(6, "Bortolatto", 2, 1)] };
  const itens = [fera, ponte];
  aplicarFiltros(itens, { qualidadeMin: "NM" }, null);
  const reais = { xNewbe: 18, Franklin: 32.4, Bortolatto: 19, TBCorp: 40, RollCard: 15 };
  const vend = Object.fromEntries(Object.keys(reais).map((n) => [n, { nick: n, cidade: null, freteGratisAPartir: null, freteEstimado: 45 }]));
  const pedidos = [];
  const cotador = { cotar: async (amostras) => Object.fromEntries(Object.keys(amostras).map((v) => {
    pedidos.push(v);
    return [v, { vendedor: v, erro: null, opcoes: [{ nome: "Frete Fixo", preco: reais[v], prazo: "" }] }];
  })) };
  const regra = new RegraFrete({ padrao: 20 });
  const { res } = await otimizarComFreteReal(itens, vend, regra, cotador, highs);
  console.log(`6. frete real com estimativa alta: R$ ${res.total.toFixed(2)} com ${Object.keys(res.subtotais).join(", ")}; cotados: ${pedidos.join(", ")}`);
  confere(quase(res.total, 42.98) && "RollCard" in res.subtotais, "não escolheu a RollCard (esperado R$ 42,98)");
  confere(Object.keys(res.subtotais).every((v) => v in regra.reais), "carrinho final com vendedor sem frete real");
}

// ------------------------------------------------------------------ 7. busca local: juntar 2 unidades num vendedor
// Caso real: 3 Fera; as unidades a R$ 1 estão em 3 vendedores e a Yamicardsbr tem 2 a R$ 2,40 com
// frete R$ 17,39. Sem o solver exato, a busca local precisa trocar xNewbe/Franklin pela Yamicardsbr.
{
  const of = (id, vendedor, preco, quantidade) => ({ idEstoque: id, idProduto: 1, vendedor, preco, quantidade,
    qualidade: "NM", idioma: "Português", printing: null });
  const itens = [
    { ...novoItem("3 Fera", 3), todasOfertas: [of(1, "xNewbe", 1, 1), of(2, "Franklin", 1, 1), of(3, "Bortolatto", 1, 1),
      of(4, "Claudiotonaro", 1.5, 1), of(5, "Yamicardsbr", 2.4, 2), of(6, "TBCorp", 2.49, 3)] },
    { ...novoItem("2 Ponte", 2), todasOfertas: [of(7, "Bortolatto", 2, 2)] },
    { ...novoItem("1 Pégaso", 1), todasOfertas: [of(8, "Suricato", 0.5, 1)] },
  ];
  aplicarFiltros(itens, { qualidadeMin: "NM" }, null);
  const reais = { Bortolatto: 19, xNewbe: 18, Franklin: 32.4, Suricato: 16, Yamicardsbr: 17.39, Claudiotonaro: 32.4 };
  const vend = Object.fromEntries(["xNewbe", "Franklin", "Bortolatto", "Claudiotonaro", "Yamicardsbr", "TBCorp", "Suricato"]
    .map((n) => [n, { nick: n, cidade: null, freteGratisAPartir: null, freteEstimado: 60 }]));
  const regra = new RegraFrete({ padrao: 20 });
  Object.assign(regra.reais, reais);
  const e = exato(highs, itens, vend, regra);
  const h = heuristica(itens, vend, regra);
  console.log(`7. juntar unidades: exato R$ ${e.total.toFixed(2)} | busca local R$ ${h.total.toFixed(2)} (${Object.keys(h.subtotais).join(", ")})`);
  confere(quase(h.total, e.total), "busca local não achou o ótimo (juntar na Yamicardsbr)");
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam` : "\nTudo confere com o Python.");
process.exit(falhas ? 1 : 0);
