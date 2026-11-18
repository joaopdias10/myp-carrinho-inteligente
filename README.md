# 🃏 MYP Carrinho Inteligente

Monte sua lista de cartas e descubra **de quais vendedores da [MYP Cards](https://mypcards.com) comprar cada uma** para pagar o menor total de **cartas + frete**.

Escolher "a carta mais barata" de cada item quase nunca é o mais barato no fim: cada vendedor cobra um frete, e muitos dão frete grátis acima de um valor. Este projeto coleta todas as ofertas, aplica seus filtros (qualidade, idioma, versão) e resolve o problema de forma **exata** (programação inteira), juntando cartas no mesmo vendedor quando isso compensa.

> Projeto independente, **sem vínculo com a MYP Cards**. Dados: [MYP Cards](https://mypcards.com).

## Funcionalidades

- **Lista em texto livre**: nome (inglês ou português), nome + edição, nome + edição + número, ID ou URL da carta.
- **Filtros**: qualidade mínima (NM, SP, MP, HP, DM), idiomas aceitos, versões a ignorar (ex.: Foil) e vendedores a evitar.
- **Frete**:
  - considera o valor de frete grátis de cada vendedor;
  - com login, usa o frete estimado pela MYP;
  - sem login, usa um valor suposto, que pode ser diferente para vendedores da sua UF.
- **Otimização exata** com `scipy.optimize.milp`. Uma heurística serve de reserva.
- **Comparação** com a compra "no olho" (o mais barato de cada carta), mostrando quanto você economiza.
- **Interface visual** em Streamlit e **linha de comando**.
- **Exportação** em CSV e JSON.
- **Cache local** de 6 h e respeito aos limites de acesso da MYP.

## Instalação

Requer Python 3.10+.

```bash
git clone https://github.com/joaopdias10/myp-carrinho-inteligente.git
cd myp-carrinho-inteligente
pip install -r requirements.txt
```

## Uso

### Interface visual

```bash
streamlit run app.py
```

Abra http://localhost:8501, cole sua lista e clique em **Buscar ofertas**. Os filtros e o frete ficam na barra lateral; mudar um deles recalcula o carrinho na hora, sem buscar tudo de novo.

### Linha de comando

```bash
python cli.py cartas_exemplo.txt --qualidade-min SP --idiomas "Português,Inglês" --uf SP --frete-mesmo-uf 15
```

Rode `python cli.py -h` para ver todas as opções.

### Formato da lista

Uma carta por linha, com a quantidade na frente. `#` inicia um comentário.

```text
1 https://mypcards.com/pokemon/produto/204210/umbreon-vmax   # carta exata
2 Umbreon V                                                  # qualquer edição
4 Nest Ball | SV1                                            # só a edição SV1
1 Umbreon VMAX | S6A 048                                     # edição e número
1 204210                                                     # ID do produto
```

- O **nome** precisa ser exato, em inglês ou português ("Boss's Orders" ou "Ordem da Chefia").
- O **código da edição** é o que aparece na MYP (por exemplo, `SV1` e `SV2`, e não `SVI`/`PAL`). Se o filtro não bater, o app lista as edições disponíveis.

## Configuração opcional

| O quê | Para quê | Como informar |
|---|---|---|
| Token da API da MYP | Sobe o limite da API de 10 para 60 req/min, o que deixa a busca por nome mais rápida | Peça em [mypcards.com/acesso-api](https://mypcards.com/acesso-api). Depois use o campo em *Avançado*, o arquivo `api_token.txt` ou a variável `MYP_API_TOKEN` |
| Cookie da sua sessão | Faz o app ler o **frete estimado** de cada vendedor para o seu endereço | Copie o cabeçalho `Cookie` de uma requisição à mypcards.com (DevTools → Rede) para o campo em *Avançado*, o arquivo `cookie.txt` ou a variável `MYP_COOKIE` |

`api_token.txt` e `cookie.txt` estão no `.gitignore`. Nunca compartilhe esses valores.

## Como funciona

1. **Busca**: a [API pública da MYP](https://github.com/MYPCards/mypcards-api) (`/{jogo}/carta/{nome}`) encontra todas as edições da carta. Se o nome não estiver lá, o app usa a busca do site.
2. **Ofertas**: a API não informa vendedores, estoque nem frete. Por isso o app lê as tabelas de ofertas da página de cada edição: vendedor, qualidade, idioma, versão, quantidade e preço. Elas vêm ordenadas por preço, 10 por página; por padrão o app lê até 5 páginas por edição.
3. **Vendedores**: da página de cada vendedor saem a cidade/UF, o valor para frete grátis e, com login, o frete estimado.
4. **Otimização**: o app escolhe quantas unidades comprar de cada oferta para minimizar `Σ preços + Σ fretes dos vendedores usados`. Ele respeita o estoque e zera o frete de quem passar do valor de frete grátis.

Estrutura:

```
myp_carrinho/
  cliente.py      # acesso à MYP (API + páginas), cache, limites de requisição
  otimizacao.py   # lista -> ofertas -> filtros -> frete -> otimização
app.py            # interface Streamlit
cli.py            # linha de comando
```

## Limitações

- **Frete sem login** é uma estimativa (valor fixo configurável).
- **Limites de acesso**: a MYP usa Cloudflare e limita o acesso. Rajadas de requisições geram bloqueios temporários de alguns minutos. O app espera entre requisições, tenta de novo e guarda as páginas em cache. Mesmo assim, a primeira busca de uma lista grande leva alguns minutos.
- **Mudanças no site**: a leitura das páginas depende do HTML atual da MYP e pode quebrar se o site mudar.
- **Ofertas consideradas**: só as das primeiras páginas de cada edição (ajustável em *Avançado* / `--max-paginas`).

## Uso responsável

Use para consultas pessoais, com moderação. Respeite os [termos da MYP Cards](https://mypcards.com) e a exigência de atribuição da API: onde os dados forem exibidos, indique que vêm da MYP Cards, com link para https://mypcards.com.
