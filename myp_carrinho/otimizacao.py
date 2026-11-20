"""Lista de cartas -> ofertas -> escolha de vendedores com menor (preço + frete)."""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable

from .cliente import QUALIDADES, BloqueioMyp, ErroMyp, MypClient, Oferta, Produto, Vendedor

Log = Callable[[str], None]
Progresso = Callable[[float, str], None]


# ================================================================ lista de cartas
@dataclass
class EstadoEdicao:
    """Quanto já lemos das ofertas de uma edição."""
    paginas: int = 0
    piso: float = 0.0  # menor preço possível de uma oferta ainda não lida
    esgotada: bool = False


@dataclass
class Item:
    linha: str
    qtd: int
    produtos: list[Produto] = field(default_factory=list)
    todas_ofertas: list[Oferta] = field(default_factory=list)  # sem filtro
    ofertas: list[Oferta] = field(default_factory=list)  # filtradas, por preço
    candidatas: list[Oferta] = field(default_factory=list)  # filtradas e que podem entrar no ótimo
    estado: dict[int, EstadoEdicao] = field(default_factory=dict)
    aviso: str | None = None
    paginas_lidas: int = 0

    def nome_produto(self, id_produto: int) -> str:
        p = next((p for p in self.produtos if p.id == id_produto), None)
        return f"{p.nome} ({p.edicao} {p.numero})".strip() if p else self.linha

    def link_produto(self, id_produto: int) -> str | None:
        return next((p.link for p in self.produtos if p.id == id_produto), None)

    @property
    def disponivel(self) -> int:
        return sum(o.quantidade for o in self.ofertas)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s).strip().lower()


def ler_lista(texto: str) -> list[tuple[int, str]]:
    """Uma carta por linha: '[qtd[x]] alvo'. '#' inicia comentário."""
    itens = []
    for bruto in texto.splitlines():
        linha = bruto.split("#", 1)[0].strip()
        if not linha:
            continue
        m = re.match(r"^(\d+)\s*x?\s+(.+)$", linha, re.I)
        qtd, alvo = (int(m.group(1)), m.group(2).strip()) if m else (1, linha)
        itens.append((qtd, alvo))
    return itens


def _bate_numero(produto: Produto, numero: str) -> bool:
    a = produto.numero.split("/")[0].lstrip("0") or "0"
    b = numero.split("/")[0].lstrip("0") or "0"
    return a.lower() == b.lower()


def resolver(cli: MypClient, jogo: str, alvo: str) -> tuple[list[Produto], str | None]:
    """Transforma uma linha da lista em produtos da MYP.
    Aceita URL, ID, 'nome | EDIÇÃO número', 'nome | EDIÇÃO' ou só 'nome'."""
    m = re.search(r"/produto/(\d+)", alvo) or re.fullmatch(r"(\d+)", alvo)
    if m:
        return [cli.produto(int(m.group(1)))], None

    nome, _, filtro = alvo.partition("|")
    nome = nome.strip()
    partes = filtro.split()
    edicao = partes[0].upper() if partes else None
    numero = partes[1] if len(partes) > 1 else None

    aviso = None
    cands = cli.buscar_api(jogo, nome)  # nome exato, PT ou EN
    if not cands:
        aviso = "nome não encontrado na API; usei a busca do site"
        metas = cli.buscar_site(jogo, nome)[:25]
        exatos = [p for p in metas if norm(p.nome) == norm(nome)]
        cands = exatos or [p for p in metas if norm(nome) in norm(p.nome)]
        if not cands and edicao:
            cands = metas
    antes = cands
    if edicao:
        cands = [p for p in cands if p.edicao.upper() == edicao]
    if numero:
        cands = [p for p in cands if _bate_numero(p, numero)]
    if not cands and antes:
        eds = sorted({f"{p.edicao} {p.numero}" for p in antes})
        aviso = "nenhuma edição bateu com o filtro. Disponíveis: " + ", ".join(eds[:20])
    return cands, aviso


def resolver_itens(cli: MypClient, texto_lista: str, jogo: str,
                   progresso: Progresso | None = None) -> list[Item]:
    """Transforma cada linha da lista nas edições correspondentes (só API/busca)."""
    progresso = progresso or (lambda f, m: None)
    linhas = ler_lista(texto_lista)
    itens: list[Item] = []
    for i, (qtd, alvo) in enumerate(linhas):
        progresso(i / max(len(linhas), 1), f"Procurando {alvo}")
        it = Item(linha=alvo, qtd=qtd)
        try:
            it.produtos, it.aviso = resolver(cli, jogo, alvo)
        except ErroMyp as e:
            it.aviso = f"falha na busca: {e}"
        itens.append(it)
    return itens


# ================================================================ filtros
@dataclass
class Filtros:
    qualidade_min: str = "SP"
    idiomas: list[str] = field(default_factory=list)  # vazio = todos
    excluir: list[str] = field(default_factory=list)
    printings_excluir: list[str] = field(default_factory=list)  # ex.: ["Foil"]


# Folga do limiar, em múltiplos do maior frete. Com 2.0 o corte é garantidamente exato;
# com 1.0 só perde o caso raro em que pagar mais caro numa carta faz um vendedor passar do
# frete grátis e ainda evita abrir outro vendedor. 1.0 abre bem menos páginas.
FOLGA_FRETE = 1.0


def _limiar(ofertas: list[Oferta], qtd: int, frete_max: float) -> float:
    """Preço acima do qual uma oferta não compensa no carrinho.

    Seja p o preço da qtd-ésima unidade mais barata que passa nos filtros. Trocar uma
    oferta mais cara por uma dessas unidades baratas economiza (preço - p) e custa, no
    máximo, abrir mais um vendedor (frete_max); no pior caso, também fazer outro perder
    o frete grátis (2 × frete_max). Ofertas acima de p + FOLGA_FRETE × frete_max ficam fora."""
    acum = 0
    for o in ofertas:  # já ordenadas por preço
        acum += o.quantidade
        if acum >= qtd:
            return o.preco + FOLGA_FRETE * frete_max
    return math.inf


def aplicar_filtros(itens: list[Item], f: Filtros, frete_max: float | None = None) -> None:
    """Preenche `ofertas` (filtradas) e `candidatas` (filtradas e abaixo do limiar)."""
    q_ok = set(QUALIDADES[: QUALIDADES.index(f.qualidade_min) + 1])
    idiomas = {norm(x) for x in f.idiomas}
    excluir = {x.strip().lower() for x in f.excluir if x.strip()}
    sem = {norm(x) for x in f.printings_excluir}
    for it in itens:
        it.ofertas = sorted(
            (o for o in it.todas_ofertas
             if o.qualidade in q_ok
             and (not idiomas or norm(o.idioma) in idiomas)
             and o.vendedor.lower() not in excluir
             and not (o.printing and norm(o.printing) in sem)),
            key=lambda o: o.preco)
        if frete_max is None:
            it.candidatas = list(it.ofertas)
        else:
            lim = _limiar(it.ofertas, it.qtd, frete_max)
            it.candidatas = [o for o in it.ofertas if o.preco <= lim]


# ================================================================ coleta econômica
# A API só informa o preço mínimo em NM. Para filtros que aceitam qualidades piores,
# usamos uma fração dele como piso estimado (ofertas SP/MP costumam ser mais baratas).
FATOR_QUALIDADE = {"NM": 1.0, "SP": 0.6, "MP": 0.45, "HP": 0.3, "DM": 0.2}


def _piso_edicao(p: Produto, f: Filtros) -> float:
    """Menor preço que esperamos encontrar numa edição ainda não aberta."""
    if not p.precos_nm:
        return 0.0  # sem informação (veio da busca do site): abre de qualquer jeito
    idiomas = {norm(x) for x in f.idiomas}
    precos = [v for lang, v in p.precos_nm if not idiomas or norm(lang) in idiomas]
    base = min(precos or [v for _, v in p.precos_nm])
    return base * FATOR_QUALIDADE.get(f.qualidade_min, 0.2)


def completar(cli: MypClient, itens: list[Item], f: Filtros, frete_max: float,
              max_paginas: int = 10, progresso: Progresso | None = None) -> int:
    """Baixa só as páginas de ofertas que ainda podem mudar o resultado.

    Para cada carta, abre sempre a página com o menor preço possível ainda não lida
    (edição mais barata primeiro, depois as páginas seguintes) e para quando esse piso
    passa do limiar da carta. Páginas já baixadas vêm do cache. Retorna quantas
    páginas foram abertas nesta chamada."""
    progresso = progresso or (lambda fr, m: None)
    abertas = 0
    for i, it in enumerate(itens):
        while True:
            aplicar_filtros([it], f, frete_max)
            lim = _limiar(it.ofertas, it.qtd, frete_max)
            proxima = None
            for p in it.produtos:
                if not p.tem_oferta:
                    continue
                st = it.estado.setdefault(p.id, EstadoEdicao())
                if st.esgotada or st.paginas >= max_paginas:
                    continue
                piso = _piso_edicao(p, f) if st.paginas == 0 else st.piso
                if piso <= lim and (proxima is None or piso < proxima[0]):
                    proxima = (piso, p, st)
            if proxima is None:
                break
            _, p, st = proxima
            progresso(i / len(itens),
                      f"{it.linha}: {p.edicao} {p.numero}, página {st.paginas + 1}")
            try:
                novas, piso = cli.pagina_ofertas(p, st.paginas + 1)
            except BloqueioMyp:
                raise  # para tudo; o que já foi lido fica nos itens e no cache
            except ErroMyp as e:
                it.aviso = f"algumas edições não carregaram ({e})"
                st.esgotada = True
                continue
            st.paginas += 1
            it.paginas_lidas += 1
            abertas += 1
            vistos = {o.id_estoque for o in it.todas_ofertas}
            it.todas_ofertas.extend(o for o in novas if o.id_estoque not in vistos)
            if piso is None:
                st.esgotada = True
            else:
                st.piso = piso
    progresso(1.0, "Ofertas carregadas")
    return abertas


def coletar(cli: MypClient, texto_lista: str, jogo: str, filtros: Filtros, frete_max: float,
            max_paginas: int = 10, progresso: Progresso | None = None
            ) -> tuple[list[Item], str | None]:
    """Resolve a lista e baixa as ofertas necessárias para esses filtros.
    Retorna (itens, aviso_de_bloqueio). Se a MYP limitar o acesso no meio, os itens vêm
    com o que deu para ler; chamar `completar` depois continua de onde parou."""
    itens = resolver_itens(cli, texto_lista, jogo, progresso)
    try:
        completar(cli, itens, filtros, frete_max, max_paginas, progresso)
    except BloqueioMyp as e:
        return itens, str(e)
    return itens, None


# ================================================================ frete
@dataclass
class RegraFrete:
    padrao: float = 20.0
    mesmo_uf: float | None = None
    uf: str | None = None
    reais: dict[str, float] = field(default_factory=dict)  # vendedor -> frete real (carrinho)
    # Durante a cotação: teto para quem ainda não foi cotado (o menor frete real já visto), para
    # que um vendedor com estimativa alta ainda tenha a chance de ser escolhido e cotado.
    otimista: float | None = None
    tentados: set[str] = field(default_factory=set)  # já passaram pela cotação: sem teto otimista

    def custo(self, v: Vendedor, subtotal: float) -> float:
        if v.frete_gratis_a_partir and subtotal >= v.frete_gratis_a_partir:
            return 0.0
        return self.custo_base(v)

    def custo_base(self, v: Vendedor) -> float:
        if v.nick in self.reais:
            return self.reais[v.nick]
        if v.frete_estimado is not None:
            c = v.frete_estimado
        elif self.uf and self.mesmo_uf is not None and v.uf == self.uf:
            c = self.mesmo_uf
        else:
            c = self.padrao
        if self.otimista is not None and v.nick not in self.tentados:
            return min(c, self.otimista)
        return c

    def origem(self, v: Vendedor) -> str:
        if v.nick in self.reais:
            return "real (carrinho MYP)"
        if v.frete_estimado is not None:
            return "estimado pela MYP"
        if self.uf and self.mesmo_uf is not None and v.uf == self.uf:
            return "suposto (mesma UF)"
        return "suposto"

    @property
    def maximo(self) -> float:
        """Maior frete que um vendedor pode custar, para o limiar de poda."""
        return max([self.padrao, self.mesmo_uf or 0.0, *self.reais.values()])


# ================================================================ otimização
Alocacao = list[tuple[Item, Oferta, int]]


@dataclass
class Resultado:
    alocacao: Alocacao
    subtotais: dict[str, float]
    fretes: dict[str, float]
    metodo: str

    @property
    def cartas(self) -> float:
        return sum(self.subtotais.values())

    @property
    def frete(self) -> float:
        return sum(self.fretes.values())

    @property
    def total(self) -> float:
        return self.cartas + self.frete


def _alocar(itens: list[Item], permitidos: set[str] | None) -> Alocacao | None:
    """Ofertas mais baratas de cada item entre os vendedores permitidos."""
    usado: dict[int, int] = {}
    aloc: Alocacao = []
    for it in itens:
        falta = it.qtd
        for o in it.candidatas:
            if falta == 0:
                break
            if permitidos is not None and o.vendedor not in permitidos:
                continue
            livre = o.quantidade - usado.get(o.id_estoque, 0)
            if livre <= 0:
                continue
            n = min(livre, falta)
            usado[o.id_estoque] = usado.get(o.id_estoque, 0) + n
            aloc.append((it, o, n))
            falta -= n
        if falta:
            return None
    return aloc


def avaliar(aloc: Alocacao, vendedores: dict[str, Vendedor], frete: RegraFrete,
            metodo: str = "") -> Resultado:
    sub: dict[str, float] = {}
    for _, o, n in aloc:
        sub[o.vendedor] = sub.get(o.vendedor, 0.0) + o.preco * n
    fretes = {v: frete.custo(vendedores[v], s) for v, s in sub.items()}
    return Resultado(aloc, sub, fretes, metodo)


def mais_barato_por_carta(itens, vendedores, frete) -> Resultado | None:
    """Referência: o que a gente faria 'no olho', pegando a oferta mais barata de cada carta."""
    a = _alocar(itens, None)
    return avaliar(a, vendedores, frete, "mais barato por carta") if a else None


def heuristica(itens, vendedores, frete) -> Resultado | None:
    """Busca local: tira/recoloca vendedores enquanto o total cair."""
    todos = set(vendedores)

    def custo(U):
        a = _alocar(itens, U)
        return (math.inf, None) if a is None else (avaliar(a, vendedores, frete).total, a)

    U = set(todos)
    melhor, aloc = custo(U)
    if aloc is None:
        return None
    while True:
        usados = {o.vendedor for _, o, _ in aloc}
        cands = [U - {v} for v in usados] + [U | {v} for v in todos - U]
        r = min(((*custo(c), c) for c in cands), key=lambda t: t[0], default=None)
        if not r or r[0] >= melhor - 0.005:
            break
        melhor, aloc, U = r
    return avaliar(aloc, vendedores, frete, "heurística")


def exato(itens, vendedores, frete, limite_seg: float = 60) -> Resultado | None:
    """Programação inteira (scipy.optimize.milp): ótimo global de preço + frete,
    incluindo frete grátis acima de um valor por vendedor."""
    import numpy as np
    from scipy.optimize import Bounds, LinearConstraint, milp

    ofs = [(i, o) for i, it in enumerate(itens) for o in it.candidatas]
    vs = sorted({o.vendedor for _, o in ofs})
    vi = {v: k for k, v in enumerate(vs)}
    nx, nv = len(ofs), len(vs)
    n = nx + 2 * nv  # x: unidades por oferta | y: vendedor usado | g: atingiu frete grátis
    fr = [frete.custo_base(vendedores[v]) for v in vs]
    limiar = [vendedores[v].frete_gratis_a_partir or 0.0 for v in vs]

    c = np.zeros(n)
    c[:nx] = [o.preco for _, o in ofs]
    c[nx:nx + nv] = fr
    c[nx + nv:] = [-f if t > 0 else 0.0 for f, t in zip(fr, limiar)]

    A, lo, hi = [], [], []
    for i, it in enumerate(itens):  # quantidade exata de cada carta
        row = np.zeros(n)
        for k, (j, _) in enumerate(ofs):
            if j == i:
                row[k] = 1
        A.append(row); lo.append(it.qtd); hi.append(it.qtd)
    for k, (_, o) in enumerate(ofs):  # só compra de vendedor "aberto"
        row = np.zeros(n); row[k] = 1; row[nx + vi[o.vendedor]] = -o.quantidade
        A.append(row); lo.append(-np.inf); hi.append(0)
    for v in vs:
        j = vi[v]
        row = np.zeros(n); row[nx + nv + j] = 1; row[nx + j] = -1  # g <= y
        A.append(row); lo.append(-np.inf); hi.append(0)
        if limiar[j] > 0:  # subtotal >= limiar * g
            row = np.zeros(n)
            for k, (_, o) in enumerate(ofs):
                if o.vendedor == v:
                    row[k] = o.preco
            row[nx + nv + j] = -limiar[j]
            A.append(row); lo.append(0); hi.append(np.inf)

    ub = np.concatenate([[o.quantidade for _, o in ofs], np.ones(nv),
                         [1.0 if t > 0 else 0.0 for t in limiar]])
    res = milp(c, constraints=LinearConstraint(np.array(A), lo, hi),
               integrality=np.ones(n), bounds=Bounds(np.zeros(n), ub),
               options={"time_limit": limite_seg})
    if res.x is None:
        return None
    aloc = [(itens[i], o, int(round(res.x[k]))) for k, (i, o) in enumerate(ofs)
            if round(res.x[k]) > 0]
    metodo = "exato (ótimo)" if res.status == 0 else "exato (melhor no tempo limite)"
    return avaliar(aloc, vendedores, frete, metodo)


def otimizar(itens, vendedores, frete, usar_exato: bool = True,
             limite_seg: float = 60) -> Resultado | None:
    h = heuristica(itens, vendedores, frete)
    if not usar_exato:
        return h
    try:
        e = exato(itens, vendedores, frete, limite_seg)
    except ImportError:
        return h
    if e and (not h or e.total <= h.total + 0.005):
        return e
    return h


def itens_atendiveis(itens: list[Item]) -> list[Item]:
    return [it for it in itens if it.disponivel >= it.qtd]


def carregar_vendedores(cli: MypClient, itens: list[Item],
                        progresso: Progresso | None = None) -> dict[str, Vendedor]:
    progresso = progresso or (lambda f, m: None)
    nicks = sorted({o.vendedor for it in itens for o in it.candidatas})
    out = {}
    for k, n in enumerate(nicks):
        progresso(k / max(len(nicks), 1), f"Vendedor {n} ({k + 1}/{len(nicks)})")
        out[n] = cli.vendedor(n)
    progresso(1.0, "Vendedores carregados")
    return out
