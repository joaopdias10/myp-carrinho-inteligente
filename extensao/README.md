# Extensão do Chrome (protótipo)

A mesma lógica do app Python, rodando dentro do seu navegador:

- **A busca sai do seu navegador**, com o seu IP e a sua sessão na MYP. Cada pessoa tem o próprio limite de acesso, e não há servidor.
- **Roda em segundo plano**: você pode fechar a aba do app e usar outras abas. Quando termina, aparece uma notificação.
- **Frete real no seu carrinho da MYP**: a extensão põe 1 carta de cada vendedor escolhido no seu carrinho, informa o CEP, lê as opções de envio e tira o que colocou.
- **Colocar no carrinho**: um botão põe o carrinho escolhido no seu carrinho da MYP. Você revisa e finaliza a compra lá; a extensão nunca compra nada.
- **Otimização exata** com o [HiGHS](https://highs.dev) em WebAssembly (o mesmo solver que o `scipy` usa no app Python).

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions` (no Edge: `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `extensao/`.
4. Clique no ícone **M** da barra de extensões. A página do app abre numa aba.

Depois de mudar o código, clique em **↻ Recarregar** no card da extensão em `chrome://extensions`.

## Usar

1. Faça login na mypcards.com no mesmo navegador. É opcional, mas com login a página do vendedor também mostra o frete estimado para o seu endereço.
2. Na página do app, cole a lista (mesmo formato do app Python), ajuste os filtros e o CEP e clique em **Buscar ofertas**.
3. Acompanhe a barra de progresso ou vá fazer outra coisa; a notificação avisa quando acabar.
4. Confira o carrinho e, se quiser, clique em **Colocar tudo no meu carrinho da MYP**.

## Como o frete real mexe no seu carrinho

- Se você **já tem itens** de um vendedor no carrinho, a extensão só lê o frete dele, sem mexer nos itens.
- Para os outros vendedores, ela adiciona 1 unidade de uma oferta, lê o frete e **remove só o que adicionou**.
- Informar o CEP pode trocar o CEP selecionado no seu carrinho. Deixe o campo vazio para usar o que já estiver lá.
- Evite mexer no carrinho da MYP enquanto a cotação roda.
- Se algo falhar no meio, a extensão avisa no registro para você conferir o carrinho.

## Estrutura

```
manifest.json      # Manifest V3: permissão só para mypcards.com
background.js      # service worker: abre o app, cria o documento offscreen, guarda o estado, notifica
offscreen.html/js  # onde a busca roda, fora da aba do app
app.html/js/css    # interface
lib/myp.js         # acesso à MYP (API + páginas), ritmo de 4 s, cache, bloqueio do Cloudflare
lib/otimizador.js  # lista, filtros, coleta econômica, frete, otimização (HiGHS + busca local)
lib/frete.js       # frete real e "colocar no carrinho"
lib/resultado.js   # resultado em JSON para a interface
vendor/highs/      # HiGHS em WebAssembly (highs-js 1.15.4, licença MIT)
```

## Testes

Os testes em [`../testes_extensao`](../testes_extensao) comparam a extensão com o código Python usando as páginas já salvas em `.cache_myp`, sem acessar a MYP:

```bash
PYTHONIOENCODING=utf-8 python testes_extensao/referencia.py > testes_extensao/ref.json
cd testes_extensao && npm install && npm test
```

Eles conferem o parse das ofertas e dos vendedores, a coleta completa e o otimizador exato contra o `scipy`. Depois de rodar, `testes_extensao/ui.html` mostra uma prévia da interface com um resultado de exemplo; sirva a raiz do repositório com `python -m http.server 8765` e abra http://127.0.0.1:8765/testes_extensao/ui.html.

## Ainda não testado

- **No Chrome de verdade, com a MYP no ar.** Os testes cobrem a lógica com páginas salvas, mas não o comportamento do navegador. Pontos a observar:
  - se o Cloudflare aceita as requisições feitas pela extensão;
  - se os cookies da sessão vão junto;
  - se o Chrome desacelera o documento offscreen em buscas longas.
- **O fluxo do carrinho com uma conta logada.** O fluxo foi validado numa sessão anônima.

## Publicar

- **Chrome Web Store:** taxa única de US$ 5 e revisão. A política de privacidade precisa dizer que a extensão só acessa mypcards.com e não envia dados para outros lugares.
- **Antes de publicar:** fale com a MYP Cards. A [API](https://github.com/MYPCards/mypcards-api) exige atribuição visível, que a página já mostra.
