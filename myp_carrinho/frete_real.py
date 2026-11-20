"""Frete real por CEP, calculado pelo próprio carrinho da MYP.

Como funciona (sem login, numa sessão anônima descartável, nunca no carrinho do usuário):
  1. adiciona uma carta barata de cada vendedor ao carrinho    GET  /carrinho/adicionar
  2. informa o CEP                                             POST /carrinho/selecionar-endereco
  3. pede o cálculo das transportadoras integradas (Correios)  POST /carrinho/atualizar-frete
  4. lê as opções de envio de cada vendedor e os preços        GET  /carrinho
  5. remove os itens                                           POST /carrinho/remover
Nada é comprado. O valor usado é a opção mais barata com preço (frete combinado fica de fora).
Ele é cotado com 1 carta por vendedor; para poucas cartas o valor praticamente não muda.
"""
from __future__ import annotations

import json
import random
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import requests
from bs4 import BeautifulSoup

from .cliente import (BASE, HEADERS, BloqueioMyp, ErroMyp, checar_bloqueio, parse_brl,
                      registrar_desafio)

AJAX = {"X-Requested-With": "XMLHttpRequest", "Accept": "*/*"}
LOTE = 8  # vendedores por rodada no carrinho (o site limita o tamanho do carrinho)


@dataclass
class OpcaoEnvio:
    nome: str
    preco: float
    prazo: str = ""


@dataclass
class FreteReal:
    vendedor: str
    opcoes: list[OpcaoEnvio] = field(default_factory=list)
    erro: str | None = None
    quando: float = field(default_factory=time.time)

    @property
    def melhor(self) -> OpcaoEnvio | None:
        return min(self.opcoes, key=lambda o: o.preco) if self.opcoes else None


def _cep_valido(cep: str) -> str:
    dig = re.sub(r"\D", "", cep or "")
    if len(dig) != 8:
        raise ValueError("CEP precisa ter 8 dígitos")
    return f"{dig[:5]}-{dig[5:]}"


def _opcoes_do_html(html_envio: str) -> list[OpcaoEnvio]:
    """Extrai 'Nome (R$ X) prazo' de cada opção de envio com preço."""
    soup = BeautifulSoup(html_envio, "html.parser")
    out: list[OpcaoEnvio] = []
    for label in soup.select("label"):
        txt = " ".join(label.get_text(" ", strip=True).split())
        # um label pode conter várias opções (ex.: "Correios PAC (R$ 23,30) ... SEDEX (R$ 25,80) ...")
        for m in re.finditer(r"([^()]+?)\s*\(R\$\s*([\d.]+,\d{2})\)\s*((?:até\s+)?\d+\s+dias(?:\s+úteis)?)?", txt):
            nome = re.sub(r"^(Correios|Valores estimados.*?\.)\s+", r"\1 ", m.group(1)).strip()
            nome = re.sub(r"^.*?(até \d+ dias(?: úteis)?)\s+", "", nome)  # resto do prazo anterior
            preco = parse_brl("R$ " + m.group(2))
            if preco is not None:
                out.append(OpcaoEnvio(nome=nome, preco=preco, prazo=(m.group(3) or "").strip()))
    vistos, unicos = set(), []
    for o in out:
        if (o.nome, o.preco) not in vistos:
            vistos.add((o.nome, o.preco))
            unicos.append(o)
    return unicos


class CotadorFrete:
    def __init__(self, cep: str, intervalo: float = 4.0, cache_dir: str | Path = ".cache_myp",
                 cache_horas: float = 24.0, log: Callable[[str], None] | None = None):
        self.cep = _cep_valido(cep)
        self.intervalo = intervalo
        self.log = log or (lambda m: None)
        self.cache_seg = cache_horas * 3600
        self.arq_cache = Path(cache_dir) / f"fretes_{self.cep.replace('-', '')}.json"
        self.cache: dict[str, FreteReal] = self._ler_cache()
        self._ultimo = 0.0
        self.s: requests.Session | None = None

    # ---------------- cache ----------------
    def _ler_cache(self) -> dict[str, FreteReal]:
        try:
            dados = json.loads(self.arq_cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        out = {}
        for nick, d in dados.items():
            fr = FreteReal(vendedor=nick, opcoes=[OpcaoEnvio(**o) for o in d.get("opcoes", [])],
                           erro=d.get("erro"), quando=d.get("quando", 0))
            if time.time() - fr.quando < self.cache_seg:
                out[nick] = fr
        return out

    def _salvar_cache(self) -> None:
        self.arq_cache.parent.mkdir(exist_ok=True)
        self.arq_cache.write_text(json.dumps({k: asdict(v) for k, v in self.cache.items()},
                                             ensure_ascii=False, indent=1), encoding="utf-8")

    # ---------------- HTTP (sessão anônima própria, sem cache) ----------------
    def _req(self, metodo: str, path: str, data: dict | None = None, ajax: bool = False,
             csrf: str | None = None) -> requests.Response:
        if self.s is None:
            self.s = requests.Session()
            self.s.headers.update(HEADERS)
        headers = dict(AJAX) if ajax else {}
        if csrf:
            headers["X-CSRF-Token"] = csrf
            data = {**(data or {}), "_csrf": csrf}
        checar_bloqueio()
        r = None
        for tentativa in range(4):
            espera = self.intervalo * random.uniform(0.9, 1.25) - (time.time() - self._ultimo)
            if espera > 0:
                time.sleep(espera)
            try:
                r = self.s.request(metodo, BASE + path, data=data, headers=headers, timeout=60)
            except requests.RequestException:
                time.sleep(5 * (tentativa + 1))
                continue
            finally:
                self._ultimo = time.time()
            if r.status_code == 403 and "Just a moment" in r.text[:600]:
                registrar_desafio(tentativa, self.log)  # levanta BloqueioMyp se persistir
                continue
            if r.status_code == 429 or r.status_code >= 500:
                pausa = 20 * (tentativa + 1)
                self.log(f"frete: HTTP {r.status_code}; aguardando {pausa}s")
                time.sleep(pausa)
                continue
            break
        if r is None or not r.ok:
            raise ErroMyp(f"falha no carrinho ({path.split('?')[0]}: HTTP {getattr(r, 'status_code', '?')})")
        return r

    def _carrinho(self) -> tuple[BeautifulSoup, str]:
        r = self._req("GET", "/carrinho")
        soup = BeautifulSoup(r.text, "html.parser")
        meta = soup.select_one('meta[name="csrf-token"]')
        return soup, (meta["content"] if meta else "")

    # ---------------- cotação ----------------
    def cotar(self, amostras: dict[str, int], progresso: Callable[[float, str], None] | None = None
              ) -> dict[str, FreteReal]:
        """amostras: {vendedor: id_estoque de uma oferta dele}. Usa o cache quando possível."""
        progresso = progresso or (lambda f, m: None)
        faltam = {v: e for v, e in amostras.items() if v not in self.cache}
        nicks = list(faltam)
        for ini in range(0, len(nicks), LOTE):
            lote = {v: faltam[v] for v in nicks[ini:ini + LOTE]}
            progresso(ini / max(len(nicks), 1),
                      f"Cotando frete real de {len(lote)} vendedor(es) para o CEP {self.cep}")
            try:
                self._cotar_lote(lote)
            except BloqueioMyp:
                self._salvar_cache()  # guarda o que já deu certo; bloqueio não vai para o cache
                raise
            except ErroMyp as e:
                for v in lote:
                    self.cache.setdefault(v, FreteReal(v, erro=str(e)))
            self._salvar_cache()
        progresso(1.0, "Fretes cotados")
        return {v: self.cache[v] for v in amostras if v in self.cache}

    def _cotar_lote(self, lote: dict[str, int]) -> None:
        adicionados: list[int] = []
        try:
            for v, id_estoque in lote.items():
                r = self._req("GET", f"/carrinho/adicionar?idestoque={id_estoque}&qtd=1&override=0", ajax=True)
                try:
                    cod = json.loads(r.text).get("errCode")
                except ValueError:
                    cod = None
                if cod in (1, 5):
                    adicionados.append(id_estoque)
                else:
                    self.cache[v] = FreteReal(v, erro=f"não foi possível adicionar ao carrinho (código {cod})")
            if not adicionados:
                return
            _, csrf = self._carrinho()
            self._req("POST", "/carrinho/selecionar-endereco", {"cep": self.cep}, ajax=True, csrf=csrf)
            soup, csrf = self._carrinho()

            for loja in soup.select("[id^=carrinho-da-loja-]"):
                idv = loja["id"].rsplit("-", 1)[-1]
                link = next((a for a in loja.select("a[href]")
                             if re.fullmatch(r"/[^/?#]+", a["href"])), None)
                nick = link["href"][1:] if link else None
                if nick not in lote:
                    continue
                html_envio = str(loja)
                provedores = {i.get("data-provedor-frete") for i in loja.select("input[data-provedor-frete]")}
                for prov in filter(None, provedores):
                    r = self._req("POST", f"/carrinho/atualizar-frete?t={int(time.time() * 1000)}",
                                  {"idvendedor": idv, "recalcularFreteProvedor": "true",
                                   "provedorFrete": prov}, ajax=True, csrf=csrf)
                    try:
                        html_envio = json.loads(r.text).get("formasDeEnvioHtml") or html_envio
                    except ValueError:
                        pass
                opcoes = _opcoes_do_html(html_envio)
                self.cache[nick] = FreteReal(nick, opcoes=opcoes,
                                             erro=None if opcoes else "vendedor sem frete com preço")
        finally:
            if adicionados:
                try:
                    _, csrf = self._carrinho()
                    for id_estoque in adicionados:
                        self._req("POST", f"/carrinho/remover?idestoque={id_estoque}", {}, ajax=True, csrf=csrf)
                except ErroMyp as e:
                    self.log(f"frete: não consegui limpar o carrinho anônimo ({e})")


def otimizar_com_frete_real(itens, vendedores, regra, cotador: CotadorFrete,
                            usar_exato: bool = True, max_rodadas: int = 8,
                            progresso: Callable[[float, str], None] | None = None):
    """Otimiza, cota o frete real dos vendedores escolhidos e otimiza de novo, até que
    todo vendedor do carrinho tenha frete real (ou acabem as rodadas).
    Quem ainda não foi cotado entra com no máximo o menor frete real já visto: muitos vendedores
    têm frete fixo bem abaixo do PAC/estimativa e, sem isso, nunca seriam escolhidos para cotar.
    Preenche `regra.reais` e devolve (resultado, {vendedor: FreteReal})."""
    from .otimizacao import otimizar

    cotados: dict[str, FreteReal] = {}
    for nick, fr in cotador.cache.items():  # o que já está no cache entra de graça
        if nick in vendedores:
            cotados[nick] = fr
            regra.tentados.add(nick)
            if fr.melhor:
                regra.reais[nick] = fr.melhor.preco
    for _ in range(max_rodadas):
        regra.otimista = min(regra.reais.values()) if regra.reais else None
        res = otimizar(itens, vendedores, regra, usar_exato=usar_exato)
        if res is None:
            break
        sem_real = [v for v in res.subtotais if v not in cotados]
        if not sem_real:
            break
        amostras = {}
        for v in sem_real:  # a oferta mais barata de cada vendedor serve de amostra
            o = min((o for it in itens for o in it.candidatas if o.vendedor == v),
                    key=lambda o: o.preco)
            amostras[v] = o.id_estoque
        try:
            novos = cotador.cotar(amostras, progresso)
        except BloqueioMyp as e:
            cotador.log(f"frete real interrompido: {e}")
            for v in sem_real:  # mostra o motivo; esses vendedores ficam com o frete suposto
                cotados.setdefault(v, FreteReal(v, erro=str(e)))
            break
        for v, fr in novos.items():
            cotados[v] = fr
            if fr.melhor:
                regra.reais[v] = fr.melhor.preco
        regra.tentados.update(sem_real)
    # resultado final com os valores de verdade: real onde houver, estimado/suposto no resto
    regra.otimista = None
    return otimizar(itens, vendedores, regra, usar_exato=usar_exato), cotados
