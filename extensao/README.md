# Extensão do Chrome (beta)

A mesma lógica do app Python, rodando dentro do seu navegador:

- **A busca sai do seu navegador**, com o seu IP e a sua sessão na MYP. Cada pessoa tem o próprio limite de acesso, e não há servidor.
- **Roda em segundo plano**: você pode fechar a aba do app e usar outras abas. Quando termina, aparece uma notificação.
- **Frete real no seu carrinho da MYP**: a extensão põe 1 carta de cada vendedor escolhido no seu carrinho, informa o CEP, lê as opções de envio (PAC, SEDEX, Mini Envios, Loggi, frete fixo do vendedor…) e tira o que colocou.
- **Colocar no carrinho**: um botão põe o carrinho escolhido no seu carrinho da MYP. Você revisa e finaliza a compra lá; a extensão nunca compra nada.
- **Otimização exata** com o [HiGHS](https://highs.dev) em WebAssembly (o mesmo solver que o `scipy` usa no app Python).

> **Ainda é beta e pode apresentar erros.** Confira o carrinho na MYP antes de finalizar a compra. Se algo parecer errado, veja a seção [Se der erro](#se-der-erro).

## Instalar (modo desenvolvedor)

Funciona no Chrome, no Brave e no Edge.

1. Abra `chrome://extensions` (no Brave: `brave://extensions`; no Edge: `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `extensao/`.
4. Clique no ícone **M** da barra de extensões. A página do app abre numa aba.

### Atualizar

A extensão carregada assim não se atualiza sozinha:

1. Baixe o código novo (`git pull`).
2. Clique em **↻ Recarregar** no card da extensão. Se a atualização mudou o `manifest.json`, remova a extensão e carregue a pasta de novo.
3. Feche a aba do app e abra de novo pelo ícone **M**. O rodapé mostra a versão em uso.

## Usar

1. Faça login na mypcards.com no mesmo navegador. É opcional, mas com login a página do vendedor também mostra o frete estimado para o seu endereço.
2. Na página do app, cole a lista (mesmo formato do app Python) e escolha o jogo. O padrão é Yu-Gi-Oh!.
3. Ajuste os filtros:
   - **Idiomas aceitos**: vazio aceita todos.
   - **Ignorar impressões**: cada impressão vira uma opção separada ("Ultra Rare, 1st" aparece como "Ultra Rare" e "1st"). Uma oferta com qualquer uma das escolhidas fica de fora.
   - As opções de impressão aparecem depois da primeira busca. Mudou um filtro? Busque de novo: as páginas já lidas vêm do cache.
4. Informe o CEP e clique em **Buscar ofertas**. Acompanhe a barra de progresso ou vá fazer outra coisa; a notificação avisa quando acabar.
5. Confira o carrinho e, se quiser, clique em **Colocar tudo no meu carrinho da MYP**.

## Como o frete real mexe no seu carrinho

- Se você **já tem itens** de um vendedor no carrinho, a extensão só lê o frete dele, sem mexer nos itens.
- Para os outros vendedores, ela adiciona 1 unidade de uma oferta, lê o frete e **remove só o que adicionou**.
- Informar o CEP pode trocar o CEP selecionado no seu carrinho. Deixe o campo vazio para usar o que já estiver lá.
- Evite mexer no carrinho da MYP enquanto a cotação roda.
- Se algo falhar no meio, a extensão avisa no registro para você conferir o carrinho.

## Se der erro

- Embaixo dos totais aparece o **método**. O esperado é "exato (ótimo)". Se aparecer "busca local", o solver exato não rodou e o carrinho pode não ser o mais barato. O **Registro** diz o motivo.
- No fim da aba **Melhor carrinho**, a seção **Fretes cotados** mostra o frete ou o erro de cada vendedor cotado, inclusive dos que ficaram fora do resultado.
- Em **Registro → Copiar diagnóstico** você copia a versão, o registro, as cotações e o carrinho de uma vez. Antes de compartilhar, apague o seu CEP se ele aparecer.

## Estrutura

```
manifest.json      # Manifest V3: permissão só para mypcards.com; libera WebAssembly para o HiGHS
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

Eles conferem:

- o parse das ofertas e dos vendedores;
- a coleta completa;
- o otimizador exato contra o `scipy`;
- a busca local;
- casos reais de frete (vendedor com estimativa alta e unidades a juntar num vendedor só).

Depois de rodar, `testes_extensao/ui.html` mostra uma prévia da interface com um resultado de exemplo. Para abrir, sirva a raiz do repositório com `python -m http.server 8765` e abra http://127.0.0.1:8765/testes_extensao/ui.html.

## O que já foi testado

- **No Brave, logado na MYP**, com frete real pelo carrinho, numa lista de Yu-Gi-Oh! com várias edições por carta e vários vendedores.
- **O fluxo do carrinho numa sessão anônima**, com o carrinho já tendo itens de outros vendedores.

Ainda pode dar problema com:

- **Cloudflare:** o bloqueio temporário da MYP em buscas grandes. A busca para e continua de onde parou depois de alguns minutos.
- **Buscas muito longas:** o Chrome pode desacelerar o documento em segundo plano.
- **Mudanças no site:** a leitura das páginas e do carrinho depende do HTML atual da MYP.

## Publicar

- **Chrome Web Store:** taxa única de US$ 5 e revisão. A política de privacidade precisa dizer que a extensão só acessa mypcards.com e não envia dados para outros lugares. Publicada lá, ela se atualiza sozinha no Chrome e no Brave.
- **Antes de publicar:** fale com a MYP Cards. A [API](https://github.com/MYPCards/mypcards-api) exige atribuição visível, que a página já mostra.
