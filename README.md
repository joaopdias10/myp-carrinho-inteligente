# 🃏 MYP Carrinho Inteligente

Monte sua lista de cartas e descubra **de quais vendedores da [MYP Cards](https://mypcards.com) comprar cada uma** para pagar o menor total de **cartas + frete**.

Escolher "a carta mais barata" de cada item quase nunca é o mais barato no fim: cada vendedor cobra um frete, e muitos dão frete grátis acima de um valor. Este projeto coleta todas as ofertas, aplica seus filtros (qualidade, idioma, versão) e resolve o problema de forma **exata** (programação inteira), juntando cartas no mesmo vendedor quando isso compensa.

> Projeto independente, **sem vínculo com a MYP Cards**. Dados: [MYP Cards](https://mypcards.com).

## Funcionalidades

- **Lista em texto livre**: nome (inglês ou português), nome + edição, nome + edição + número, ID ou URL da carta.
- **Filtros**: qualidade mínima (NM, SP, MP, HP, DM), idiomas aceitos, impressões a ignorar (ex.: 1st, Foil; cada parte de "Ultra Rare, 1st" vira uma opção) e vendedores a evitar.
- **Frete**:
  - **frete real pelo seu CEP**: o app simula o carrinho da MYP e lê as opções de envio de cada vendedor (frete fixo, PAC, SEDEX…);
  - considera o valor de frete grátis de cada vendedor;
  - sem CEP, usa um valor suposto, que pode ser diferente para vendedores da sua UF.
- **Todas as ofertas**: uma aba com o preço que cada vendedor colocou em cada carta, com filtros e ordenação.
- **Otimização exata** com `scipy.optimize.milp`. Uma heurística serve de reserva.
- **Comparação** com a compra "no olho" (o mais barato de cada carta), mostrando quanto você economiza.
- **Interface visual** em Streamlit e **linha de comando**.
- **Extensão para Chrome e Brave** (beta): roda tudo no seu navegador, sem Python. Veja [extensao/README.md](extensao/README.md).
- **Exportação** em CSV e JSON.
- **Coleta econômica**: só baixa as páginas que podem mudar o resultado, guarda tudo em cache local e respeita os limites de acesso da MYP.

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

Abra http://localhost:8501, escolha o jogo (o padrão é Yu-Gi-Oh!), cole sua lista e clique em **Buscar ofertas**. Os filtros e o frete ficam na barra lateral; mudar um deles recalcula o carrinho na hora, buscando só as ofertas que passarem a importar.

Para o frete real, ative **Calcular frete real pelo CEP** e informe seu CEP.

### Linha de comando

```bash
python cli.py cartas_exemplo.txt --qualidade-min SP --idiomas "Português,Inglês" --uf SP --frete-mesmo-uf 15
```

Com frete real:

```bash
python cli.py cartas_exemplo.txt --cep 01310-100
```

Rode `python cli.py -h` para ver todas as opções.

### Extensão do Chrome e do Brave (beta)

A pasta [`extensao/`](extensao/) tem a mesma lógica em JavaScript, como extensão do navegador:

- **Busca:** sai do seu navegador, com o seu IP e a sua sessão na MYP, e roda em segundo plano enquanto você usa outras abas.
- **Mesmos critérios do app:** filtros, coleta e otimização exata funcionam do mesmo jeito e dão o mesmo resultado nos testes.
- **Frete real:** a diferença está aqui. O app cota numa sessão **anônima** da MYP; a extensão cota no **seu** carrinho, e um botão coloca o carrinho escolhido lá para você finalizar.

Já foi testada no Brave com login e frete real. **Ainda é beta e pode apresentar erros**: confira o carrinho na MYP antes de comprar. Instalação e detalhes em [extensao/README.md](extensao/README.md).

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
| CEP padrão | Já deixa o campo de CEP preenchido | Arquivo `cep.txt` ou variável `MYP_CEP` |
| Cookie da sua sessão | Alternativa ao CEP: com login, a página de cada vendedor mostra o frete estimado para o seu endereço | Copie o cabeçalho `Cookie` de uma requisição à mypcards.com (DevTools → Rede) para o campo em *Avançado*, o arquivo `cookie.txt` ou a variável `MYP_COOKIE` |

`api_token.txt`, `cep.txt` e `cookie.txt` estão no `.gitignore`. Nunca compartilhe esses valores.

## Como funciona

1. **Busca**: a [API pública da MYP](https://github.com/MYPCards/mypcards-api) (`/{jogo}/carta/{nome}`) encontra todas as edições da carta. Se o nome não estiver lá, o app usa a busca do site.
2. **Ofertas**: a API não informa vendedores, estoque nem frete. Por isso o app lê as tabelas de ofertas da página de cada edição: vendedor, qualidade, idioma, versão, quantidade e preço. Elas vêm ordenadas pelo preço atual, 10 por página.
3. **Coleta econômica**: o app abre primeiro a edição mais barata (pelo preço mínimo que a API informa) e só abre outra página ou edição enquanto ela ainda puder baratear o carrinho. O critério é o preço da unidade mais barata que passa nos filtros + o maior frete: uma oferta mais cara que isso não compensa nem para economizar um frete.
4. **Vendedores**: da página de cada vendedor que pode entrar no carrinho saem a cidade/UF e o valor para frete grátis.
5. **Otimização**: o app escolhe quantas unidades comprar de cada oferta para minimizar `Σ preços + Σ fretes dos vendedores usados`. Ele respeita o estoque e zera o frete de quem passar do valor de frete grátis. Se o solver exato falhar, uma busca local troca vendedores até o total parar de cair. O método usado aparece embaixo do carrinho.
6. **Frete real** (opcional): para cada vendedor do carrinho escolhido, o app usa uma sessão **anônima** da MYP, nunca a sua conta. Ele adiciona uma carta ao carrinho, informa o CEP, lê as opções de envio e remove o item; nada é comprado. Se o carrinho da MYP não mostrar as opções de envio de um vendedor, o app pede o cálculo aos Correios mesmo assim. Com os valores reais, otimiza de novo, até o carrinho estabilizar. Nessa etapa, quem ainda não foi cotado entra com no máximo o menor frete real já visto. Assim, um vendedor com frete fixo barato não fica de fora só porque a estimativa dele era alta. As cotações ficam em cache por 24 h.

Estrutura:

```
myp_carrinho/
  cliente.py      # acesso à MYP (API + páginas), cache, limites de requisição
  otimizacao.py   # lista -> ofertas -> filtros -> frete -> otimização
  frete_real.py   # cotação do frete real pelo carrinho da MYP
app.py            # interface Streamlit
cli.py            # linha de comando
extensao/         # extensão do Chrome (mesma lógica em JavaScript)
testes_extensao/  # compara a extensão com o código Python, offline
```

## Limitações

- **Frete sem CEP** é uma estimativa (valor fixo configurável).
- **Frete real** é cotado com 1 carta por vendedor e usa a opção de envio mais barata. Para poucas cartas o valor praticamente não muda; o valor final é confirmado na compra.
- **Limites de acesso**: a MYP usa Cloudflare. Muitas requisições seguidas geram bloqueios temporários de alguns minutos. O app mantém um ritmo de ~4 s entre páginas. Se for bloqueado, mostra o resultado parcial e pede para buscar de novo alguns minutos depois; a busca continua de onde parou.
- **Mudanças no site**: a leitura das páginas e do carrinho depende do HTML atual da MYP e pode quebrar se o site mudar.
- **Ainda pode ter erros**: o projeto é novo. Confira o carrinho na MYP antes de finalizar a compra. Na lista **Fretes cotados**, embaixo do carrinho, aparece o frete ou o erro de cada vendedor consultado.
- **Corte de ofertas**: ofertas mais caras que "unidade mais barata + maior frete" são ignoradas. Em casos raros, uma delas poderia compensar por levar um vendedor ao frete grátis.

## Uso responsável

Use para consultas pessoais, com moderação. Respeite os [termos da MYP Cards](https://mypcards.com) e a exigência de atribuição da API: onde os dados forem exibidos, indique que vêm da MYP Cards, com link para https://mypcards.com.

## Licença

[MIT](LICENSE). A licença cobre o código deste projeto; os dados exibidos pertencem à MYP Cards.
