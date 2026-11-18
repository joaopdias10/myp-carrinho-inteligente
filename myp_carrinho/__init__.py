"""MYP Carrinho Inteligente: escolhe de quais vendedores da MYP Cards comprar
cada carta para pagar o menor total de cartas + frete.

Projeto independente, sem vínculo com a MYP Cards. Dados: MYP Cards — https://mypcards.com
"""
from .cliente import QUALIDADES, BloqueioMyp, ErroMyp, MypClient, Oferta, Produto, Vendedor, segredo
from .frete_real import CotadorFrete, FreteReal, OpcaoEnvio, otimizar_com_frete_real
from .otimizacao import (Filtros, Item, RegraFrete, Resultado, aplicar_filtros,
                         carregar_vendedores, coletar, completar, itens_atendiveis,
                         mais_barato_por_carta, otimizar, resolver_itens)

__all__ = [
    "QUALIDADES", "BloqueioMyp", "ErroMyp", "MypClient", "Oferta", "Produto", "Vendedor", "segredo",
    "Filtros", "Item", "RegraFrete", "Resultado", "aplicar_filtros", "carregar_vendedores",
    "coletar", "completar", "itens_atendiveis", "mais_barato_por_carta", "otimizar",
    "resolver_itens", "CotadorFrete", "FreteReal", "OpcaoEnvio", "otimizar_com_frete_real",
]
