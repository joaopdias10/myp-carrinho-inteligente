"""Versão de linha de comando.

    python cli.py cartas_exemplo.txt --qualidade-min SP --uf SP --frete-mesmo-uf 15
    python cli.py cartas_exemplo.txt --cep 01310-100     # frete real por CEP
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

from myp_carrinho import (QUALIDADES, CotadorFrete, Filtros, MypClient, RegraFrete,
                          aplicar_filtros, carregar_vendedores, coletar, itens_atendiveis,
                          mais_barato_por_carta, otimizar, otimizar_com_frete_real, segredo)


def main():
    ap = argparse.ArgumentParser(description="Otimizador de carrinho da MYP Cards")
    ap.add_argument("lista", help="arquivo com uma carta por linha")
    ap.add_argument("--jogo", default="yugioh")
    ap.add_argument("--qualidade-min", default="SP", choices=QUALIDADES)
    ap.add_argument("--idiomas", default="", help='ex.: "Português,Inglês" (vazio = todos)')
    ap.add_argument("--excluir", default="", help="vendedores a ignorar, separados por vírgula")
    ap.add_argument("--frete-padrao", type=float, default=20.0)
    ap.add_argument("--uf")
    ap.add_argument("--frete-mesmo-uf", type=float)
    ap.add_argument("--cep", help="calcula o frete real de cada vendedor escolhido para este CEP "
                                  "(pelo carrinho da MYP, numa sessão anônima; nada é comprado)")
    ap.add_argument("--max-paginas", type=int, default=10,
                    help="limite de páginas por edição; a coleta para antes quando as próximas não podem compensar")
    ap.add_argument("--cookie-arquivo", default="cookie.txt")
    ap.add_argument("--token-arquivo", default="api_token.txt")
    ap.add_argument("--heuristica", action="store_true", help="não usar o solver exato")
    ap.add_argument("--json", help="salvar resultado em JSON")
    a = ap.parse_args()

    cli = MypClient(cookie=segredo(a.cookie_arquivo, "MYP_COOKIE"),
                    api_token=segredo(a.token_arquivo, "MYP_API_TOKEN"),
                    log=lambda m: print(f"  ... {m}"))
    print(f"Sessão: {'logado' if cli.logado else 'anônimo'} | "
          f"API: {'com token' if cli.api_token else 'sem token (10 req/min)'}")

    with open(a.lista, encoding="utf-8") as f:
        texto = f.read()
    ultimo = [""]

    def prog(_, msg):
        if msg != ultimo[0]:
            print(" ", msg)
            ultimo[0] = msg

    filtros = Filtros(qualidade_min=a.qualidade_min,
                      idiomas=[x for x in a.idiomas.split(",") if x.strip()],
                      excluir=a.excluir.split(","))
    regra = RegraFrete(a.frete_padrao, a.frete_mesmo_uf, a.uf.upper() if a.uf else None)
    itens, bloqueio = coletar(cli, texto, a.jogo, filtros, regra.maximo, a.max_paginas, prog)
    if bloqueio:
        print(f"! resultado parcial: {bloqueio}. Rode de novo depois; o cache guarda o que já foi lido.")
    aplicar_filtros(itens, filtros, regra.maximo)
    for it in itens:
        com_oferta = sum(p.tem_oferta for p in it.produtos)
        print(f"> {it.qtd}x {it.linha}: {com_oferta} edições com oferta, {it.paginas_lidas} páginas "
              f"lidas, {len(it.ofertas)} ofertas válidas ({len(it.candidatas)} candidatas), "
              f"{it.disponivel} un." + (f"  [{it.aviso}]" if it.aviso else ""))
    ok = itens_atendiveis(itens)
    for it in itens:
        if it not in ok:
            print(f"! sem estoque suficiente: {it.qtd}x {it.linha}")
    if not ok:
        sys.exit("Nada para otimizar.")

    vend = carregar_vendedores(cli, ok, prog)
    cotados = {}
    if a.cep:
        cotador = CotadorFrete(a.cep, log=lambda m: print(f"  ... {m}"))
        res, cotados = otimizar_com_frete_real(ok, vend, regra, cotador,
                                               usar_exato=not a.heuristica, progresso=prog)
    else:
        res = otimizar(ok, vend, regra, usar_exato=not a.heuristica)
    if res is None:
        sys.exit("Não foi possível montar um carrinho com essas cartas.")
    base = mais_barato_por_carta(ok, vend, regra)

    for v in sorted(res.subtotais, key=lambda x: -res.subtotais[x]):
        vd = vend[v]
        print(f"\n{v} ({vd.cidade or '?'})  {vd.url}")
        for it, o, n in res.alocacao:
            if o.vendedor == v:
                print(f"   {n}x {it.nome_produto(o.id_produto)[:44]:<44} {o.qualidade:<3} "
                      f"{o.idioma[:10]:<10} R$ {o.preco:>8.2f}")
        print(f"   subtotal R$ {res.subtotais[v]:.2f} + frete R$ {res.fretes[v]:.2f} "
              f"({'grátis' if not res.fretes[v] else regra.origem(vd)})")
        fr = cotados.get(v)
        if fr and fr.opcoes:
            print("   opções de envio: " + " | ".join(f"{o.nome} R$ {o.preco:.2f}" for o in fr.opcoes))
        elif fr and fr.erro:
            print(f"   frete real indisponível: {fr.erro}")
    print(f"\nTOTAL R$ {res.total:.2f} (cartas R$ {res.cartas:.2f} + frete R$ {res.frete:.2f}, "
          f"{len(res.subtotais)} vendedores, {res.metodo})")
    if base:
        print(f"Comprando o mais barato de cada carta: R$ {base.total:.2f} "
              f"-> economia de R$ {base.total - res.total:.2f}")
    print("Dados: MYP Cards — https://mypcards.com")

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"total": round(res.total, 2), "fretes": res.fretes,
                       "subtotais": res.subtotais,
                       "compras": [{"item": it.linha, "qtd": n, **asdict(o)}
                                   for it, o, n in res.alocacao]},
                      f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
