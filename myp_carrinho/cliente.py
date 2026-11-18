"""Coleta de dados da MYP Cards (mypcards.com).

Fontes:
- API pública oficial (https://github.com/MYPCards/mypcards-api), base /api/v1:
    /{jogo}/carta/{nome}   busca por nome exato (inglês ou português)
    /produto/{id}          metadados e preço mínimo NM
  Limite: 10 req/min por rota sem token, 60 com token (header X-Api-Token).
- A API não traz vendedores, estoque nem frete. Por isso o resto vem das páginas:
    /{jogo}/produto/{id}/...      tabelas de ofertas (paginadas, 10 por página, ordenadas por preço)
    /{nick}                       vendedor: cidade/UF, frete grátis e (logado) frete estimado
    /{jogo}?ProdutoSearch[query]  busca do site, usada só quando a API não acha o nome
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import quote, quote_plus

import requests
from bs4 import BeautifulSoup

BASE = "https://mypcards.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
}

QUALIDADES = ["NM", "SP", "MP", "HP", "DM"]  # melhor -> pior


class ErroMyp(Exception):
    """Falha ao acessar a MYP (bloqueio temporário, página fora do ar etc.)."""


def parse_brl(txt: str | None) -> float | None:
    if not txt:
        return None
    m = re.search(r"R\$\s*([\d.]+,\d{2})", txt.replace("\xa0", " "))
    if not m:
        return None
    return float(m.group(1).replace(".", "").replace(",", "."))


@dataclass
class Oferta:
    id_estoque: int
    id_produto: int
    vendedor: str
    preco: float
    quantidade: int
    qualidade: str
    idioma: str
    printing: str | None = None
    versao: str | None = None
    obs: str | None = None


@dataclass
class Vendedor:
    nick: str
    cidade: str | None = None
    frete_gratis_a_partir: float | None = None
    frete_estimado: float | None = None  # só aparece logado

    @property
    def uf(self) -> str | None:
        if self.cidade and re.search(r" - ([A-Z]{2})$", self.cidade):
            return self.cidade[-2:]
        return None

    @property
    def url(self) -> str:
        return f"{BASE}/{self.nick}"


@dataclass
class Produto:
    id: int
    nome: str
    edicao: str
    codigo: str
    link: str
    tem_oferta: bool
    ofertas: list[Oferta] = field(default_factory=list)

    @property
    def numero(self) -> str:
        return self.codigo.rsplit("_", 1)[-1] if self.codigo else ""


class MypClient:
    def __init__(self, cookie: str | None = None, api_token: str | None = None,
                 intervalo: float = 2.0, cache_dir: str | Path = ".cache_myp",
                 cache_horas: float = 6.0, log: Callable[[str], None] | None = None):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        if cookie:
            self.s.headers["Cookie"] = cookie.strip()
        self.logado = bool(cookie)
        self.api_token = api_token.strip() if api_token else None
        self.intervalo = intervalo
        # API: 10 req/min por rota sem token, 60 com token
        self.intervalo_api = 1.1 if self.api_token else 6.5
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        self.cache_seg = cache_horas * 3600
        self.log = log or (lambda msg: None)
        self._ultimo = 0.0
        self._ultimo_api = 0.0
        self._vendedores: dict[str, Vendedor] = {}

    # ---------------- HTTP com cache, intervalo e retentativas ----------------
    def _get(self, path: str, usa_cache: bool = True) -> str:
        url = path if path.startswith("http") else BASE + path
        eh_api = "/api/v1/" in url
        chave = hashlib.sha1((url + ("|logado" if self.logado else "")).encode()).hexdigest()
        arq = self.cache_dir / f"{chave}.txt"
        if usa_cache and arq.exists() and time.time() - arq.stat().st_mtime < self.cache_seg:
            return arq.read_text(encoding="utf-8")

        headers = {"Accept": "application/json"} if eh_api else {}
        if eh_api and self.api_token:
            headers["X-Api-Token"] = self.api_token
        r = None
        for tentativa in range(4):
            ultimo, intervalo = ((self._ultimo_api, self.intervalo_api) if eh_api
                                 else (self._ultimo, self.intervalo))
            espera = intervalo - (time.time() - ultimo)
            if espera > 0:
                time.sleep(espera)
            try:
                r = self.s.get(url, timeout=30, headers=headers)
            except requests.RequestException as e:
                self.log(f"erro de rede ({e.__class__.__name__}), tentando de novo")
                time.sleep(5 * (tentativa + 1))
                continue
            finally:
                if eh_api:
                    self._ultimo_api = time.time()
                else:
                    self._ultimo = time.time()

            desafio = r.status_code == 403 and "Just a moment" in r.text[:600]
            if desafio and not eh_api:
                self.intervalo = min(self.intervalo * 1.5, 10)  # desacelera de vez
            if r.status_code == 429 or r.status_code >= 500 or desafio:
                pausa = float(r.headers.get("Retry-After") or (61 if eh_api else 30 * (tentativa + 1)))
                motivo = "bloqueio temporário do Cloudflare" if desafio else f"HTTP {r.status_code}"
                self.log(f"{motivo}; aguardando {pausa:.0f}s")
                time.sleep(pausa)
                continue
            break

        if r is None or not r.ok:
            raise ErroMyp(f"falha ao abrir {url} (HTTP {getattr(r, 'status_code', '?')})")
        r.encoding = "utf-8"
        arq.write_text(r.text, encoding="utf-8")
        return r.text

    # ---------------- API pública ----------------
    @staticmethod
    def _produto_de_json(j: dict) -> Produto:
        return Produto(
            id=j["internal_code"],
            nome=j.get("name_pt") or j.get("name_en") or "",
            edicao=(j.get("edition_code") or "").upper(),
            codigo=j.get("card_code") or "",
            link=j.get("link") or f"{BASE}/produto/{j['internal_code']}",
            tem_oferta=bool(j.get("prices")) or j.get("min_price") is not None,
        )

    def jogos(self) -> dict[str, str]:
        """{slug: nome} dos jogos suportados."""
        j = json.loads(self._get("/api/v1/jogos"))
        return {g["slug"]: g["name"] for g in j.get("games", [])}

    def produto(self, id_produto: int) -> Produto:
        return self._produto_de_json(json.loads(self._get(f"/api/v1/produto/{id_produto}")))

    def buscar_api(self, jogo: str, nome: str) -> list[Produto]:
        """Busca oficial por nome exato (inglês ou português), todas as edições."""
        j = json.loads(self._get(f"/api/v1/{jogo}/carta/{quote(nome, safe='')}"))
        return [self._produto_de_json(c) for c in j.get("cards", [])]

    # ---------------- Busca do site (alternativa) ----------------
    def buscar_site(self, jogo: str, consulta: str) -> list[Produto]:
        txt = self._get(f"/{jogo}?ProdutoSearch%5Bquery%5D={quote_plus(consulta)}")
        soup = BeautifulSoup(txt, "html.parser")
        out: list[Produto] = []
        for li in soup.select("li.stream-item"):
            a = li.select_one(f'a[href^="/{jogo}/produto/"]')
            nome_el = li.select_one(".card-name h3") or li.select_one("h3")
            if not a or not nome_el:
                continue
            m = re.match(rf"/{re.escape(jogo)}/produto/(\d+)/", a["href"])
            if not m:
                continue
            titulo = " ".join((nome_el.get("title") or nome_el.get_text(" ", strip=True)).split())
            num = re.search(r"\(([^)]+)\)\s*$", titulo)
            ed = li.select_one(".card-edicao")
            qtd = li.select_one(".quantidade-num")
            qtd_txt = qtd.get_text(strip=True) if qtd else ""
            out.append(Produto(
                id=int(m.group(1)),
                nome=re.sub(r"\s*\([^)]*\)\s*$", "", titulo),
                edicao=(ed.get_text(strip=True) if ed else "").upper(),
                codigo="_" + num.group(1) if num else "",
                link=BASE + a["href"],
                tem_oferta=qtd_txt.isdigit() and int(qtd_txt) > 0,
            ))
        return out

    # ---------------- Ofertas ----------------
    @staticmethod
    def _linha_oferta(tr, id_produto: int) -> Oferta | None:
        """Lê uma linha <tr data-key> da tabela de ofertas.
        O JSON data-resumo só existe quando a oferta tem foto, então é só complemento."""
        if not tr.select_one(".addToCart[data-idestoque]"):
            return None  # oferta própria ou não adicionável ao carrinho
        vend = tr.select_one("a.nome-vendedor-apelido")
        preco_td = tr.select_one("td.estoque-lista-precoestoque")
        qtd_td = tr.select_one("td.estoque-lista-quantidadeestoque")
        if not vend or not preco_td or not qtd_td:
            return None
        valores = re.findall(r"R\$\s*[\d.]+,\d{2}", preco_td.get_text(" ").replace("\xa0", " "))
        preco = parse_brl(valores[-1]) if valores else None  # último = preço atual em promoção
        qtd = int(re.sub(r"\D", "", qtd_td.get_text()) or 0)
        if preco is None or not qtd:
            return None
        chip = tr.select_one("td.estoque-lista-qualidadenome .qualidade-texto span[title]")
        bandeira = tr.select_one("td.estoque-lista-qualidadenome .flag-icon[title]")
        extra_td = tr.select_one("td.estoque-lista-nomeenfoil")
        o = Oferta(
            id_estoque=int(tr["data-key"]), id_produto=id_produto,
            vendedor=vend.get_text(strip=True), preco=preco, quantidade=qtd,
            qualidade=(chip.get_text(strip=True).upper() if chip else "?"),
            idioma=(bandeira["title"] if bandeira else "?"),
            printing=(extra_td.get_text(" ", strip=True) or None) if extra_td else None,
        )
        res = tr.select_one("[data-resumo]")
        if res:
            try:
                r = json.loads(html.unescape(res["data-resumo"]))
                o.versao, o.obs = r.get("versao"), r.get("obs")
                o.printing = r.get("printing") or o.printing
            except ValueError:
                pass
        return o

    def ofertas(self, produto: Produto, max_paginas: int = 5) -> list[Oferta]:
        """Lê as ofertas das duas tabelas da página da carta (lojistas certificados e
        demais vendedores). Cada tabela vem ordenada por preço, 10 por página, então
        `max_paginas` limita a leitura às 10*max_paginas ofertas mais baratas de cada uma."""
        out: dict[int, Oferta] = {}
        for pag in range(1, max_paginas + 1):
            url = produto.link if pag == 1 else (
                f"{produto.link}?estoque-cert-page={pag}&estoque-outros-page={pag}")
            soup = BeautifulSoup(self._get(url), "html.parser")
            novos = 0
            for tr in soup.select("tr[data-key]"):
                o = self._linha_oferta(tr, produto.id)
                if o and o.id_estoque not in out:
                    out[o.id_estoque] = o
                    novos += 1
            tem_mais = any(a.get_text(strip=True) == str(pag + 1)
                           for a in soup.select(".pagination a"))
            if not novos or not tem_mais:
                break
        produto.ofertas = list(out.values())
        return produto.ofertas

    # ---------------- Vendedor ----------------
    def vendedor(self, nick: str) -> Vendedor:
        if nick in self._vendedores:
            return self._vendedores[nick]
        v = Vendedor(nick=nick)
        try:
            soup = BeautifulSoup(self._get(f"/{nick}"), "html.parser")
            c = soup.select_one("span.cidade")
            if c:
                v.cidade = " ".join(c.get_text(" ", strip=True).split())
            fg = soup.select_one(".frete-gratis .valor-frete") or soup.select_one(".frete-gratis")
            if fg:
                v.frete_gratis_a_partir = parse_brl(fg.get_text(" ", strip=True))
            fe = soup.select_one(".loja-frete-estimado")
            if fe and not fe.select_one('a[href="/login"]'):
                t = fe.get_text(" ", strip=True)
                v.frete_estimado = 0.0 if re.search(r"gr[aá]tis", t, re.I) else parse_brl(t)
        except ErroMyp as e:
            self.log(f"não consegui ler o vendedor {nick}: {e}")
        self._vendedores[nick] = v
        return v


def segredo(arquivo: str | None, env: str) -> str | None:
    """Lê um segredo de um arquivo local ou de uma variável de ambiente."""
    if arquivo and Path(arquivo).exists():
        return Path(arquivo).read_text(encoding="utf-8").strip() or None
    return os.environ.get(env) or None
