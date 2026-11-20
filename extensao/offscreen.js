// Documento offscreen: roda a busca inteira em segundo plano, fora da aba do app,
// para o usuário poder navegar normalmente. Só tem acesso a chrome.runtime, então manda o
// estado para o service worker, que grava em chrome.storage.local.
import { BloqueioMyp, Cancelado, Cliente } from "./lib/myp.js";
import { CotadorFrete, colocarNoCarrinho, melhorOpcao } from "./lib/frete.js";
import {
  RegraFrete, aplicarFiltros, carregarVendedores, completar, itensAtendiveis, lerLista,
  maisBaratoPorCarta, novoItem, otimizar, otimizarComFreteReal, resolver,
} from "./lib/otimizador.js";
import { montarResultado } from "./lib/resultado.js";
import carregarHighs from "./vendor/highs/highs.mjs";

let highsP = null;
async function solver() { // carrega o HiGHS (WebAssembly) uma vez; sem ele, usa a busca local
  highsP ??= carregarHighs().catch((e) => { registrar(`solver exato indisponível (${e.message})`); highsP = null; return null; });
  return highsP;
}

let cli = null;
let tokenAtual = null;
const cotadores = new Map(); // cep -> CotadorFrete (cotações valem enquanto o navegador está aberto)
let rodando = false;
let estado = { fase: "parado" };
let log = [];

function cliente(token) {
  if (!cli || token !== tokenAtual) {
    const antigo = cli;
    cli = new Cliente({ token, log: registrar });
    if (antigo) cli.bloqueadoAte = antigo.bloqueadoAte;
    tokenAtual = token;
  }
  cli.cancelado = false;
  return cli;
}

function registrar(msg) {
  log = [...log.slice(-40), `${new Date().toLocaleTimeString("pt-BR")} ${msg}`];
  emitir({});
}

let ultimoEnvio = 0;
function emitir(parcial, forcar = false) {
  estado = { ...estado, ...parcial, log };
  const agora = Date.now();
  if (!forcar && agora - ultimoEnvio < 300) return;
  ultimoEnvio = agora;
  chrome.runtime.sendMessage({ para: "bg", tipo: "estado", estado }).catch(() => {});
}

const progresso = (etapa, peso, base) => (f, msg) => {
  emitir({ progresso: base + peso * f, mensagem: msg, etapa });
};

// ------------------------------------------------------------------ busca
async function executar(p) {
  const c = cliente(p.token);
  const inicio = Date.now();
  const reqAntes = c.requisicoes;
  log = [];
  estado = { fase: "rodando", inicio, progresso: 0, mensagem: "Começando", resultado: null, erro: null };
  emitir({}, true);

  const regra = new RegraFrete(p.frete);
  let bloqueio = null;
  let itens = [];
  try {
    // 1. resolver nomes (API oficial)
    const linhas = lerLista(p.lista);
    if (!linhas.length) throw new Error("A lista está vazia.");
    for (const [i, [qtd, alvo]] of linhas.entries()) {
      progresso("Procurando cartas", 0.1, 0)(i / linhas.length, `Procurando ${alvo}`);
      const it = novoItem(alvo, qtd);
      try {
        Object.assign(it, await resolver(c, p.jogo, alvo));
      } catch (e) {
        if (e instanceof BloqueioMyp || e instanceof Cancelado) throw e;
        it.aviso = `falha na busca: ${e.message}`;
      }
      itens.push(it);
    }
    // 2. ofertas (só as páginas que podem baratear o carrinho)
    await completar(c, itens, p.filtros, regra.maximo, p.maxPaginas, progresso("Lendo ofertas", 0.55, 0.1));
  } catch (e) {
    if (e instanceof BloqueioMyp) bloqueio = e.message;
    else throw e;
  }
  aplicarFiltros(itens, p.filtros, regra.maximo);
  const ok = itensAtendiveis(itens);

  // 3. vendedores, otimização e frete real
  let res = null;
  let base = null;
  let cotados = {};
  let vendedores = {};
  if (ok.length) {
    vendedores = await carregarVendedores(c, ok, progresso("Lendo vendedores", 0.15, 0.65));
    const highs = await solver();
    if (p.freteReal) {
      let cot = cotadores.get(p.cep || "");
      if (!cot) { cot = new CotadorFrete(c, p.cep); cotadores.set(p.cep || "", cot); }
      cot.cli = c;
      for (const [nick, fr] of cot.cache) { // o que já foi cotado entra de graça
        const m = melhorOpcao(fr);
        if (m && nick in vendedores) regra.reais[nick] = m.preco;
      }
      const r = await otimizarComFreteReal(ok, vendedores, regra, cot, highs, progresso("Calculando o frete real", 0.2, 0.8));
      res = r.res;
      // inclui as cotações reaproveitadas de buscas anteriores, para aparecerem em "Fretes cotados"
      cotados = { ...Object.fromEntries([...cot.cache].filter(([nick]) => nick in vendedores)), ...r.cotados };
      bloqueio ??= r.interrompido;
    } else {
      emitir({ progresso: 0.9, mensagem: "Calculando a melhor combinação" });
      res = otimizar(ok, vendedores, regra, highs);
    }
    base = maisBaratoPorCarta(ok, vendedores, regra);
  }

  return {
    resultado: montarResultado(itens, ok, res, base, vendedores, regra, cotados),
    bloqueio,
    duracao: Math.round((Date.now() - inicio) / 1000),
    requisicoes: c.requisicoes - reqAntes,
  };
}

// ------------------------------------------------------------------ mensagens
async function tarefa(nome, fn) {
  if (rodando) return;
  rodando = true;
  try {
    const r = await fn();
    emitir({ fase: "fim", progresso: 1, mensagem: "Pronto", ...r }, true);
  } catch (e) {
    if (e instanceof Cancelado) emitir({ fase: "parado", mensagem: "Cancelado", notificar: false }, true);
    else emitir({ fase: "erro", erro: `${nome}: ${e.message}`, notificar: false }, true);
  } finally {
    rodando = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.para !== "offscreen") return;
  if (msg.tipo === "cancelar") {
    if (cli) cli.cancelado = true;
  } else if (msg.tipo === "iniciar") {
    tarefa("Busca", async () => {
      const r = await executar(msg.params);
      const car = r.resultado.carrinho;
      return {
        ...r,
        notificar: true,
        resumo: car
          ? `Carrinho pronto: R$ ${car.total.toFixed(2).replace(".", ",")} em ${car.vendedores.length} vendedor(es)`
          : "Busca concluída, mas não deu para montar um carrinho",
      };
    });
  } else if (msg.tipo === "colocarNoCarrinho") {
    const resultadoAnterior = estado.resultado;
    tarefa("Carrinho", async () => {
      const c = cliente(tokenAtual);
      estado = { ...estado, fase: "rodando", progresso: 0, mensagem: "Colocando no carrinho da MYP" };
      emitir({}, true);
      const rel = await colocarNoCarrinho(c, msg.itens, (f, m) => emitir({ progresso: f, mensagem: m }));
      return {
        resultado: resultadoAnterior, notificar: true, carrinhoMyp: rel,
        resumo: `${rel.ok.length} item(ns) no carrinho da MYP` + (rel.falhas.length ? `, ${rel.falhas.length} com problema` : ""),
      };
    });
  }
});
