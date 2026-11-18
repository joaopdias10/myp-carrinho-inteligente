"""MYP Carrinho Inteligente: escolhe de quais vendedores da MYP Cards comprar
cada carta para pagar o menor total de cartas + frete.

Projeto independente, sem vínculo com a MYP Cards. Dados: MYP Cards — https://mypcards.com
"""
from .cliente import QUALIDADES, ErroMyp, MypClient, Oferta, Produto, Vendedor, segredo
from .otimizacao import (Filtros, Item, RegraFrete, Resultado, aplicar_filtros,
                         carregar_vendedores, coletar, itens_atendiveis,
                         mais_barato_por_carta, otimizar)

__all__ = [
    "QUALIDADES", "ErroMyp", "MypClient", "Oferta", "Produto", "Vendedor", "segredo",
    "Filtros", "Item", "RegraFrete", "Resultado", "aplicar_filtros", "carregar_vendedores",
    "coletar", "itens_atendiveis", "mais_barato_por_carta", "otimizar",
]
