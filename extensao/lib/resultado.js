// Converte o resultado da otimização num objeto simples (JSON) para a página do app.
import { BASE } from "./myp.js";
import { melhorOpcao } from "./frete.js";
import { disponivel, linkProduto, nomeProduto } from "./otimizador.js";

export function montarResultado(itens, ok, res, base, vendedores, regra, cotados) {
  const noCarrinho = new Set(res ? res.alocacao.map((x) => x.oferta.idEstoque) : []);
  const validas = new Set(itens.flatMap((it) => it.ofertas.map((o) => o.idEstoque)));
  const out = {
    itens: itens.map((it) => ({
      linha: it.linha,
      qtd: it.qtd,
      aviso: it.aviso,
      edicoes: it.produtos.filter((p) => p.temOferta).length,
      paginasLidas: it.paginasLidas,
      validas: it.ofertas.length,
      candidatas: it.candidatas.length,
      disponivel: disponivel(it),
      atendivel: ok.includes(it),
      ofertas: [...it.todasOfertas].sort((a, b) => a.preco - b.preco).map((o) => ({
        ...o,
        carta: nomeProduto(it, o.idProduto),
        link: linkProduto(it, o.idProduto),
        valida: validas.has(o.idEstoque),
        noCarrinho: noCarrinho.has(o.idEstoque),
      })),
    })),
    carrinho: null,
  };
  out.cotacoes = Object.entries(cotados).map(([nick, fr]) => {
    const m = melhorOpcao(fr);
    return { nick, frete: m?.preco ?? null, opcao: m?.nome ?? null, erro: m ? null : (fr.erro || "sem opções de envio"),
      noCarrinho: Boolean(res && nick in res.subtotais) };
  }).sort((a, b) => a.nick.localeCompare(b.nick));
  if (!res) return out;
  out.carrinho = {
    total: res.total, cartas: res.cartas, frete: res.frete, metodo: res.metodo,
    baseTotal: base ? base.total : null,
    vendedores: Object.keys(res.subtotais).sort((a, b) => res.subtotais[b] - res.subtotais[a]).map((nick) => {
      const v = vendedores[nick];
      const fr = cotados[nick];
      const sub = res.subtotais[nick];
      return {
        nick,
        url: `${BASE}/${encodeURIComponent(nick)}`,
        cidade: v.cidade,
        subtotal: sub,
        frete: res.fretes[nick],
        origem: res.fretes[nick] ? regra.origem(v) : "grátis",
        faltaGratis: v.freteGratisAPartir && sub < v.freteGratisAPartir ? v.freteGratisAPartir - sub : null,
        opcoes: fr?.opcoes || [],
        erroFrete: fr?.erro || null,
        linhas: res.alocacao.filter((x) => x.oferta.vendedor === nick).map(({ item, oferta: o, n }) => ({
          carta: nomeProduto(item, o.idProduto),
          link: linkProduto(item, o.idProduto),
          qtd: n, preco: o.preco, qualidade: o.qualidade, idioma: o.idioma,
          printing: o.printing, idEstoque: o.idEstoque,
        })),
      };
    }),
  };
  return out;
}
