"""Gera a saída de referência do código Python para comparar com a extensão (JS).

Usa só as páginas já salvas em .cache_myp (nenhuma requisição à MYP) e instâncias
sintéticas do otimizador. Uso: python testes_extensao/referencia.py > ref.json
"""
from __future__ import annotations

import hashlib
import json
import random
import sys
from dataclasses import asdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from bs4 import BeautifulSoup  # noqa: E402

from myp_carrinho import (Filtros, MypClient, Oferta, RegraFrete, Vendedor,  # noqa: E402
                          aplicar_filtros, carregar_vendedores, coletar, itens_atendiveis)
from myp_carrinho.cliente import ErroMyp  # noqa: E402
from myp_carrinho.otimizacao import Item, exato, heuristica  # noqa: E402

CACHE = RAIZ / ".cache_myp"


class ClienteCache(MypClient):
    """Só lê do cache; o que não está lá vira erro (igual ao cliente falso do teste JS)."""

    def _get(self, path, usa_cache=True):
        url = path if path.startswith("http") else "https://mypcards.com" + path
        arq = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".txt")
        if not arq.exists():
            raise ErroMyp(f"fora do cache: {url}")
        return arq.read_text(encoding="utf-8")


def paginas():
    out = {"ofertas": {}, "vendedores": {}}
    for arq in sorted(CACHE.glob("*.txt")):
        txt = arq.read_text(encoding="utf-8")
        if not txt.lstrip().startswith("<"):
            continue
        soup = BeautifulSoup(txt, "html.parser")
        if soup.select("tr[data-key]"):
            cli = ClienteCache(cache_dir=CACHE)
            cli._get = lambda _u, _t=txt: _t
            from myp_carrinho.cliente import Produto
            ofs, piso = cli.pagina_ofertas(Produto(1, "x", "X", "", "https://mypcards.com/x", True), 1)
            out["ofertas"][arq.name] = {"ofertas": [asdict(o) for o in ofs], "piso": piso}
        elif soup.select_one("span.cidade") or soup.select_one(".frete-gratis"):
            cli = ClienteCache(cache_dir=CACHE)
            cli._get = lambda _u, _t=txt: _t
            out["vendedores"][arq.name] = asdict(cli.vendedor("nick"))
    return out


def pipeline():
    lista = "4 Ultra Ball\n2 Boss's Orders\n4 Nest Ball\nUmbreon V"
    cli = ClienteCache(cache_dir=CACHE, cache_horas=1e9)
    filtros = Filtros(qualidade_min="SP")
    regra = RegraFrete(20.0)
    itens, bloqueio = coletar(cli, lista, "pokemon", filtros, regra.maximo, 10)
    aplicar_filtros(itens, filtros, regra.maximo)
    ok = itens_atendiveis(itens)
    vend = carregar_vendedores(cli, ok)
    h = heuristica(ok, vend, regra)
    e = exato(ok, vend, regra)
    return {
        "lista": lista,
        "itens": [{"linha": it.linha, "paginas": it.paginas_lidas, "validas": len(it.ofertas),
                   "candidatas": len(it.candidatas), "aviso": it.aviso} for it in itens],
        "heuristica": h.total if h else None,
        "exato": e.total if e else None,
    }


def instancias(n=40, semente=7):
    rnd = random.Random(semente)
    out = []
    for k in range(n):
        nv = rnd.randint(3, 9)
        vend = {f"v{i}": Vendedor(f"v{i}", frete_gratis_a_partir=rnd.choice([None, None, 30, 50, 80]))
                for i in range(nv)}
        itens = []
        idest = 1
        for c in range(rnd.randint(2, 6)):
            it = Item(linha=f"carta{c}", qtd=rnd.randint(1, 4))
            for v in rnd.sample(list(vend), rnd.randint(2, nv)):
                it.todas_ofertas.append(Oferta(idest, c, v, round(rnd.uniform(0.5, 40), 2),
                                               rnd.randint(1, 4), "NM", "Português"))
                idest += 1
            itens.append(it)
        regra = RegraFrete(padrao=rnd.choice([12.0, 18.0, 25.0]))
        aplicar_filtros(itens, Filtros(qualidade_min="DM"), None)
        ok = itens_atendiveis(itens)
        if not ok:
            continue
        h, e = heuristica(ok, vend, regra), exato(ok, vend, regra)
        out.append({
            "padrao": regra.padrao,
            "vendedores": {k2: asdict(v) for k2, v in vend.items()},
            "itens": [{"linha": it.linha, "qtd": it.qtd, "ofertas": [asdict(o) for o in it.todas_ofertas]} for it in ok],
            "heuristica": h.total if h else None,
            "exato": e.total if e else None,
        })
    return out


if __name__ == "__main__":
    json.dump({"paginas": paginas(), "pipeline": pipeline(), "instancias": instancias()},
              sys.stdout, ensure_ascii=False)
