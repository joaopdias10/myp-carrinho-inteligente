"""Interface visual (Streamlit).

    streamlit run app.py
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pandas as pd
import streamlit as st

from myp_carrinho import (QUALIDADES, ErroMyp, Filtros, MypClient, RegraFrete,
                          aplicar_filtros, carregar_vendedores, coletar, completar, itens_atendiveis,
                          mais_barato_por_carta, otimizar, segredo, CotadorFrete,
                          otimizar_com_frete_real)

st.set_page_config(page_title="MYP Carrinho Inteligente", page_icon="🃏", layout="wide")

UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
       "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]
NOMES_QUALIDADE = {"NM": "NM · Quase nova", "SP": "SP · Pouco jogada", "MP": "MP · Moderadamente jogada",
                   "HP": "HP · Muito jogada", "DM": "DM · Danificada"}
JOGOS_PADRAO = {"pokemon": "Pokémon", "magic": "Magic", "yugioh": "Yu-Gi-Oh!",
                "onepiece": "One Piece", "lorcana": "Lorcana", "digimon": "Digimon"}
EXEMPLO = Path(__file__).with_name("cartas_exemplo.txt")

st.markdown("""
<style>
  .block-container {padding-top: 2rem; max-width: 1200px;}
  .vend-titulo {font-size: 1.1rem; font-weight: 600; margin: 0;}
  .vend-sub {color: var(--text-color); opacity: .7; font-size: .85rem; margin: 0 0 .4rem 0;}
  .chip {display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .78rem;
         margin-right: .35rem; border: 1px solid rgba(128,128,128,.35);}
  .chip-ok {background: rgba(33,195,84,.14); border-color: rgba(33,195,84,.45);}
  .chip-alerta {background: rgba(255,170,0,.14); border-color: rgba(255,170,0,.45);}
  .rodape {opacity: .6; font-size: .8rem; margin-top: 2rem;}
</style>
""", unsafe_allow_html=True)


def brl(v: float) -> str:
    return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# ------------------------------------------------------------------ cliente (por sessão)
def cliente(token: str | None, cookie: str | None) -> MypClient:
    chave = (token or "", cookie or "")
    if st.session_state.get("cli_chave") != chave:
        st.session_state.cli = MypClient(cookie=cookie, api_token=token)
        st.session_state.cli_chave = chave
    return st.session_state.cli


@st.cache_data(ttl=24 * 3600, show_spinner=False)
def lista_jogos() -> dict[str, str]:
    try:
        return MypClient().jogos() or JOGOS_PADRAO
    except Exception:
        return JOGOS_PADRAO


# ------------------------------------------------------------------ barra lateral
with st.sidebar:
    st.header("⚙️ Configurações")
    jogos = lista_jogos()
    slugs = list(jogos)
    jogo = st.selectbox("Jogo", slugs, index=slugs.index("yugioh") if "yugioh" in slugs else 0,
                        format_func=lambda s: jogos[s])

    st.subheader("Filtros")
    qualidade = st.select_slider("Qualidade mínima", options=QUALIDADES, value="SP",
                                 format_func=lambda q: NOMES_QUALIDADE[q])
    itens_sessao = st.session_state.get("itens") or []
    idiomas_vistos = sorted({o.idioma for it in itens_sessao for o in it.todas_ofertas})
    idiomas = st.multiselect("Idiomas aceitos", idiomas_vistos or ["Português", "Inglês", "Japonês"],
                             placeholder="Todos")
    printings_vistos = sorted({e.strip() for it in itens_sessao for o in it.todas_ofertas if o.printing
                               for e in o.printing.split(",") if e.strip()})
    sem_printing = st.multiselect("Ignorar impressões", printings_vistos, placeholder="Nenhuma",
                                  help="Ofertas com qualquer uma delas ficam de fora (ex.: 1st, Foil, Reverse Foil).")
    vendedores_vistos = sorted({o.vendedor for it in itens_sessao for o in it.todas_ofertas},
                               key=str.lower)
    excluir = st.multiselect("Vendedores a evitar", vendedores_vistos, placeholder="Nenhum")

    st.subheader("Frete")
    uf = st.selectbox("Sua UF", ["—"] + UFS, index=0)
    frete_padrao = st.number_input("Frete suposto por vendedor (R$)", 0.0, 200.0, 20.0, 1.0,
                                   help="Usado quando a MYP não informa o frete (sem login).")
    frete_uf = st.number_input("Frete suposto para vendedor da sua UF (R$)", 0.0, 200.0, 15.0, 1.0,
                               disabled=uf == "—")
    usar_frete_real = st.toggle("Calcular frete real pelo CEP", value=False,
                                help="Para cada vendedor do carrinho escolhido, o app simula o carrinho "
                                     "da MYP numa sessão anônima (nada é comprado) e lê as opções de "
                                     "envio (frete fixo, PAC, SEDEX…). Usa a mais barata e recalcula.")
    cep = st.text_input("Seu CEP", placeholder="00000-000", disabled=not usar_frete_real,
                        value=segredo("cep.txt", "MYP_CEP") or "")

    with st.expander("Avançado"):
        max_paginas = st.slider("Limite de páginas por edição", 1, 20, 10,
                                help="Teto de segurança. O app já para sozinho quando as próximas "
                                     "páginas (mais caras) não podem baratear o carrinho.")
        usar_exato = st.toggle("Otimização exata (recomendado)", value=True)
        token = st.text_input("Token da API da MYP", type="password",
                              value=segredo("api_token.txt", "MYP_API_TOKEN") or "",
                              help="Opcional. Aumenta o limite da API de 10 para 60 req/min. "
                                   "Peça em mypcards.com/acesso-api.")
        cookie = st.text_input("Cookie da sua sessão na MYP", type="password",
                               value=segredo("cookie.txt", "MYP_COOKIE") or "",
                               help="Opcional. Com ele o app lê o frete estimado de cada vendedor. "
                                    "Fica só nesta máquina.")
        if st.button("Limpar cache local"):
            for f in Path(".cache_myp").glob("*.txt"):
                f.unlink()
            st.session_state.pop("cli_chave", None)
            st.toast("Cache apagado")

# ------------------------------------------------------------------ cabeçalho e lista
st.title("🃏 MYP Carrinho Inteligente")
st.caption("Cole sua lista de cartas e descubra de quais vendedores da MYP Cards comprar "
           "para pagar o menor total de **cartas + frete**.")

col_lista, col_ajuda = st.columns([3, 2], gap="large")
with col_lista:
    texto = st.text_area(
        "Lista de cartas", height=230, key="texto_lista",
        value=EXEMPLO.read_text(encoding="utf-8") if EXEMPLO.exists() else "",
        help="Uma carta por linha, com a quantidade na frente.")
    buscar = st.button("🔎 Buscar ofertas", type="primary", use_container_width=True)
with col_ajuda:
    st.markdown("""
**Como escrever cada linha**

| Exemplo | Significa |
|---|---|
| `3 Regra de Ouro` | qualquer edição |
| `1 Ponte Arco-Íris \\| BLCR` | só a edição BLCR |
| `1 Ponte Arco-Íris \\| BLCR blcr-en055` | edição e número |
| `1 https://mypcards.com/...` | carta exata (URL) |

O nome pode estar em **inglês ou português**. O código da edição é o que aparece na MYP.
""")

cli = cliente(token or None, cookie or None)
filtros = Filtros(qualidade_min=qualidade, idiomas=idiomas, excluir=excluir,
                  printings_excluir=sem_printing)
regra = RegraFrete(padrao=frete_padrao, mesmo_uf=frete_uf if uf != "—" else None,
                   uf=uf if uf != "—" else None)

# ------------------------------------------------------------------ coleta
if buscar:
    if not texto.strip():
        st.warning("Escreva pelo menos uma carta.")
    else:
        with st.status("Buscando ofertas na MYP…", expanded=True) as status:
            barra = st.progress(0.0)
            msg = st.empty()

            def prog(frac, texto_msg):
                barra.progress(min(max(frac, 0.0), 1.0))
                msg.caption(texto_msg)

            itens_novos, bloqueio = coletar(cli, texto, jogo, filtros, regra.maximo, max_paginas, prog)
            st.session_state.itens = itens_novos
            st.session_state.jogo_coletado = jogo
            st.session_state.aviso_bloqueio = bloqueio
            status.update(label="Coleta interrompida pela MYP" if bloqueio else "Ofertas carregadas",
                          state="error" if bloqueio else "complete", expanded=False)
        st.rerun()

if st.session_state.get("aviso_bloqueio"):
    st.warning(f"⏳ Resultado parcial: {st.session_state.aviso_bloqueio}. "
               "Clique em **Buscar ofertas** de novo depois disso; o que já foi lido está no cache "
               "e a busca continua de onde parou.")

itens = st.session_state.get("itens")
if not itens:
    st.info("Monte sua lista e clique em **Buscar ofertas**. A primeira busca leva alguns minutos, "
            "porque o app respeita o limite de acesso da MYP. As seguintes usam o cache local.")
    st.markdown('<p class="rodape">Projeto independente, sem vínculo com a MYP Cards. '
                'Dados: <a href="https://mypcards.com">MYP Cards</a>.</p>', unsafe_allow_html=True)
    st.stop()

# ------------------------------------------------------------------ filtros e resumo por carta
# Filtros ou frete mudaram? Busca só as páginas que passaram a importar (o resto vem do cache).
paginas_antes = sum(it.paginas_lidas for it in itens)
with st.spinner("Conferindo se faltam ofertas para esses filtros…"):
    try:
        completar(cli, itens, filtros, regra.maximo, max_paginas)
        st.session_state.aviso_bloqueio = None
    except ErroMyp as e:
        st.warning(f"Não consegui buscar mais ofertas agora ({e}).")
novas_paginas = sum(it.paginas_lidas for it in itens) - paginas_antes
if novas_paginas:
    st.toast(f"{novas_paginas} página(s) de ofertas a mais para esses filtros")
aplicar_filtros(itens, filtros, regra.maximo)
ok = itens_atendiveis(itens)

st.subheader("Cartas da lista")
linhas = []
for it in itens:
    menor = it.ofertas[0].preco if it.ofertas else None
    if it in ok:
        situacao = "✅ ok"
    elif not it.produtos:
        situacao = "❌ não encontrada"
    else:
        situacao = f"⚠️ só {it.disponivel} un. com esses filtros"
    linhas.append({"Carta": it.linha, "Qtd": it.qtd,
                   "Edições": sum(p.tem_oferta for p in it.produtos),
                   "Páginas lidas": it.paginas_lidas,
                   "Ofertas válidas": len(it.ofertas), "Unidades": it.disponivel,
                   "Menor preço": menor, "Situação": situacao, "Observação": it.aviso or ""})
st.dataframe(pd.DataFrame(linhas), hide_index=True, use_container_width=True,
             column_config={"Menor preço": st.column_config.NumberColumn(format="R$ %.2f")})

# ------------------------------------------------------------------ vendedores e otimização
res = base = None
cotador = None
cotados: dict = {}
vendedores: dict = {}
if ok:
    faltam = {o.vendedor for it in ok for o in it.candidatas} - set(cli._vendedores)
    if faltam:
        with st.status(f"Lendo {len(faltam)} vendedores (cidade e frete)…", expanded=False) as status:
            barra = st.progress(0.0)
            vendedores = carregar_vendedores(cli, ok, lambda f, m: barra.progress(min(f, 1.0), text=m))
            status.update(label="Vendedores carregados", state="complete")
    else:
        vendedores = carregar_vendedores(cli, ok)
    cotador = None
    if usar_frete_real and cep.strip():
        try:
            cotador = CotadorFrete(cep)
        except ValueError as e:
            st.sidebar.error(str(e))
    if cotador:
        with st.status("Calculando a melhor combinação com frete real…", expanded=False) as status:
            barra = st.progress(0.0)
            try:
                res, cotados = otimizar_com_frete_real(
                    ok, vendedores, regra, cotador, usar_exato=usar_exato,
                    progresso=lambda f, m: barra.progress(min(f, 1.0), text=m))
                status.update(label="Frete real calculado", state="complete")
            except ErroMyp as e:
                status.update(label="Não consegui calcular o frete real agora", state="error")
                st.warning(f"{e}. Usando os fretes supostos.")
                res = otimizar(ok, vendedores, regra, usar_exato=usar_exato)
        base = mais_barato_por_carta(ok, vendedores, regra)
    else:
        with st.spinner("Calculando a melhor combinação…"):
            base = mais_barato_por_carta(ok, vendedores, regra)
            res = otimizar(ok, vendedores, regra, usar_exato=usar_exato)

no_carrinho: dict[int, int] = {}
if res:
    for _, o, n in res.alocacao:
        no_carrinho[o.id_estoque] = no_carrinho.get(o.id_estoque, 0) + n

aba_carrinho, aba_ofertas = st.tabs(["🛒 Melhor carrinho", "🏷️ Todas as ofertas"])

# ------------------------------------------------------------------ aba: melhor carrinho
with aba_carrinho:
    if not ok:
        st.warning("Nenhuma carta tem estoque suficiente com esses filtros. "
                   "Tente afrouxar a qualidade ou os idiomas. As ofertas continuam na aba ao lado.")
    elif not res:
        st.error("Não foi possível montar um carrinho com essas cartas.")
    else:
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Total", brl(res.total),
                  delta=f"-{brl(base.total - res.total)} vs. mais barato por carta"
                  if base and base.total - res.total > 0.005 else None,
                  delta_color="inverse")
        m2.metric("Cartas", brl(res.cartas))
        m3.metric("Frete", brl(res.frete))
        m4.metric("Vendedores", len(res.subtotais))
        if not cotador and not cli.logado:
            st.caption("ℹ️ Fretes **supostos**. Para usar o frete real, ative "
                       "*Calcular frete real pelo CEP* na barra lateral.")
        pendentes = [it for it in itens if it not in ok]
        if pendentes:
            st.caption("Fora do carrinho por falta de estoque: "
                       + ", ".join(f"{it.qtd}x {it.linha}" for it in pendentes))

        for v in sorted(res.subtotais, key=lambda x: -res.subtotais[x]):
            vd = vendedores[v]
            sub, fr = res.subtotais[v], res.fretes[v]
            with st.container(border=True):
                c1, c2 = st.columns([3, 1])
                with c1:
                    st.markdown(f'<p class="vend-titulo"><a href="{vd.url}" target="_blank">{v}</a></p>'
                                f'<p class="vend-sub">📍 {vd.cidade or "local não informado"}</p>',
                                unsafe_allow_html=True)
                    chips = []
                    if fr == 0:
                        chips.append('<span class="chip chip-ok">frete grátis</span>')
                    else:
                        chips.append(f'<span class="chip">frete {brl(fr)} · {regra.origem(vd)}</span>')
                    if vd.frete_gratis_a_partir:
                        falta = vd.frete_gratis_a_partir - sub
                        if falta > 0:
                            chips.append(f'<span class="chip chip-alerta">faltam {brl(falta)} p/ frete grátis '
                                         f'(acima de {brl(vd.frete_gratis_a_partir)})</span>')
                    st.markdown(" ".join(chips), unsafe_allow_html=True)
                    fr_real = cotados.get(v)
                    if fr_real and fr_real.opcoes:
                        st.caption("Opções de envio: " + " · ".join(
                            f"{o.nome} {brl(o.preco)}" + (f" ({o.prazo})" if o.prazo else "")
                            for o in sorted(fr_real.opcoes, key=lambda o: o.preco)))
                    elif fr_real and fr_real.erro:
                        st.caption(f"Frete real indisponível ({fr_real.erro}); usando o suposto.")
                with c2:
                    st.metric("Subtotal + frete", brl(sub + fr))
                rows = [{"Carta": it.nome_produto(o.id_produto), "Qtd": n, "Qualidade": o.qualidade,
                         "Idioma": o.idioma, "Versão": " ".join(x for x in [o.printing, o.versao] if x),
                         "Preço un.": o.preco, "Total": o.preco * n,
                         "Link": it.link_produto(o.id_produto), "Obs.": o.obs or ""}
                        for it, o, n in res.alocacao if o.vendedor == v]
                st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True,
                             column_config={
                                 "Preço un.": st.column_config.NumberColumn(format="R$ %.2f"),
                                 "Total": st.column_config.NumberColumn(format="R$ %.2f"),
                                 "Link": st.column_config.LinkColumn(display_text="abrir na MYP"),
                             })

        compras = [{"vendedor": o.vendedor, "carta": it.nome_produto(o.id_produto), "qtd": n,
                    "qualidade": o.qualidade, "idioma": o.idioma, "preco": o.preco,
                    "link": it.link_produto(o.id_produto), "id_estoque": o.id_estoque}
                   for it, o, n in res.alocacao]
        e1, e2, _ = st.columns([1, 1, 3])
        e1.download_button("⬇️ Baixar CSV", pd.DataFrame(compras).to_csv(index=False).encode("utf-8-sig"),
                           "carrinho_myp.csv", "text/csv", use_container_width=True)
        e2.download_button("⬇️ Baixar JSON",
                           json.dumps({"total": round(res.total, 2), "cartas": round(res.cartas, 2),
                                       "frete": round(res.frete, 2), "fretes": res.fretes,
                                       "metodo": res.metodo, "compras": compras},
                                      ensure_ascii=False, indent=2).encode("utf-8"),
                           "carrinho_myp.json", "application/json", use_container_width=True)
        st.caption(f"Método: {res.metodo}.")
        if cotados:
            falhas = sum(1 for fr in cotados.values() if not fr.melhor)
            with st.expander(f"Fretes cotados no carrinho da MYP ({len(cotados)}"
                             + (f", {falhas} com erro)" if falhas else ")"), expanded=bool(falhas)):
                st.dataframe(pd.DataFrame([{
                    "Vendedor": v,
                    "Frete": fr.melhor.preco if fr.melhor else None,
                    "Opção / erro": fr.melhor.nome if fr.melhor else (fr.erro or "sem opções de envio"),
                    "No resultado": "sim" if v in res.subtotais else "",
                } for v, fr in sorted(cotados.items(), key=lambda x: x[0].lower())]),
                    hide_index=True, use_container_width=True,
                    column_config={"Frete": st.column_config.NumberColumn(format="R$ %.2f")})

# ------------------------------------------------------------------ aba: todas as ofertas
with aba_ofertas:
    st.caption("Todas as ofertas coletadas, com o preço que cada vendedor colocou. "
               "Clique no cabeçalho de uma coluna para ordenar.")
    opcoes = ["Todas as cartas"] + [f"{it.qtd}x {it.linha}" for it in itens]
    f1, f2, f3 = st.columns([2, 2, 1])
    escolha = f1.selectbox("Carta", range(len(opcoes)), format_func=lambda i: opcoes[i])
    busca_vend = f2.text_input("Filtrar vendedor", placeholder="parte do nome")
    so_filtradas = f3.toggle("Aplicar filtros", value=True,
                             help="Usa qualidade, idiomas, versões e vendedores da barra lateral.")
    selecionados = itens if escolha == 0 else [itens[escolha - 1]]

    linhas_of = []
    for it in selecionados:
        for o in (it.ofertas if so_filtradas else it.todas_ofertas):
            if busca_vend and busca_vend.lower() not in o.vendedor.lower():
                continue
            vd = cli._vendedores.get(o.vendedor)
            linhas_of.append({
                "🛒": f"{no_carrinho[o.id_estoque]} un." if o.id_estoque in no_carrinho else "",
                "Carta": it.nome_produto(o.id_produto),
                "Vendedor": o.vendedor,
                "Cidade": vd.cidade if vd and vd.cidade else "",
                "Qualidade": o.qualidade,
                "Idioma": o.idioma,
                "Versão": " ".join(x for x in [o.printing, o.versao] if x),
                "Estoque": o.quantidade,
                "Preço": o.preco,
                "Obs.": o.obs or "",
                "Link": it.link_produto(o.id_produto),
                "Loja": f"https://mypcards.com/{o.vendedor}",
            })

    if not linhas_of:
        st.info("Nenhuma oferta com esses critérios.")
    else:
        df = pd.DataFrame(linhas_of).sort_values(["Carta", "Preço"] if escolha == 0 else "Preço")
        precos = df["Preço"]
        s1, s2, s3, s4 = st.columns(4)
        s1.metric("Ofertas", len(df))
        s2.metric("Vendedores", df["Vendedor"].nunique())
        s3.metric("Menor preço", brl(precos.min()))
        s4.metric("Preço mediano", brl(precos.median()))
        st.dataframe(df, hide_index=True, use_container_width=True, height=520,
                     column_config={
                         "🛒": st.column_config.TextColumn(width="small",
                                                          help="Unidades desta oferta no melhor carrinho"),
                         "Preço": st.column_config.NumberColumn(format="R$ %.2f"),
                         "Estoque": st.column_config.NumberColumn(format="%d un."),
                         "Link": st.column_config.LinkColumn("Carta na MYP", display_text="abrir"),
                         "Loja": st.column_config.LinkColumn("Loja", display_text="ver loja"),
                     })
        st.download_button("⬇️ Baixar ofertas (CSV)", df.to_csv(index=False).encode("utf-8-sig"),
                           "ofertas_myp.csv", "text/csv")
        if not so_filtradas:
            st.caption("Sem filtros: inclui qualidades e idiomas que não entram no carrinho.")
        st.caption("Cada edição mostra até 10 × *páginas de ofertas* (em *Avançado*) das ofertas mais "
                   "baratas por tabela; as mais caras podem não aparecer.")

st.markdown('<p class="rodape">Projeto independente, sem vínculo com a MYP Cards. '
            'Dados: <a href="https://mypcards.com">MYP Cards</a>.</p>', unsafe_allow_html=True)
