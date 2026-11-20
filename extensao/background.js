// Service worker: abre a página do app, mantém o documento offscreen (onde a busca roda)
// e guarda o estado da busca em chrome.storage.local, que a página do app observa.

const APP = chrome.runtime.getURL("app.html");
let criando = null;

async function garantirOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  criando ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Ler as páginas de ofertas da MYP Cards em segundo plano",
  }).finally(() => { criando = null; });
  await criando;
}

// Ao abrir o navegador ou atualizar a extensão, uma busca "rodando" que ficou para trás
// já não existe (o documento offscreen foi fechado).
async function limparEstadoOrfao() {
  const { estado } = await chrome.storage.local.get("estado");
  if (estado?.fase === "rodando") {
    await chrome.storage.local.set({ estado: { ...estado, fase: "parado", mensagem: "A busca anterior foi interrompida." } });
  }
}
chrome.runtime.onStartup.addListener(limparEstadoOrfao);
chrome.runtime.onInstalled.addListener(limparEstadoOrfao);

chrome.action.onClicked.addListener(async () => {
  const [aba] = await chrome.tabs.query({ url: APP });
  if (aba) {
    await chrome.tabs.update(aba.id, { active: true });
    await chrome.windows.update(aba.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (msg?.para !== "bg") return;
  (async () => {
    if (msg.tipo === "iniciar" || msg.tipo === "colocarNoCarrinho" || msg.tipo === "cancelar") {
      await garantirOffscreen();
      await chrome.runtime.sendMessage({ ...msg, para: "offscreen" });
    } else if (msg.tipo === "estado") {
      await chrome.storage.local.set({ estado: msg.estado });
      if (msg.estado.fase === "fim" && msg.estado.notificar) {
        chrome.notifications.create({
          type: "basic", iconUrl: "icone.png", title: "MYP Carrinho Inteligente",
          message: msg.estado.resumo || "Busca concluída",
        });
      }
    }
    responder({ ok: true });
  })().catch((e) => responder({ ok: false, erro: String(e) }));
  return true;
});

chrome.notifications.onClicked.addListener(async () => {
  const [aba] = await chrome.tabs.query({ url: APP });
  if (aba) await chrome.tabs.update(aba.id, { active: true });
  else await chrome.tabs.create({ url: APP });
});
