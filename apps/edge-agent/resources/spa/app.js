const out = document.getElementById("out");
const btn = document.getElementById("btn");
const healthBtn = document.getElementById("btn-health");
const printBtn = document.getElementById("btn-print");

async function showJson(label, promise) {
  try {
    if (!window.edgeBridge) {
      out.textContent = "edgeBridge missing (preload failed)";
      return;
    }
    const res = await promise;
    out.textContent = `${label}\n` + JSON.stringify(res, null, 2);
  } catch (err) {
    out.textContent = String(err);
  }
}

btn.addEventListener("click", () => {
  void showJson("ping", window.edgeBridge.ping());
});

healthBtn.addEventListener("click", async () => {
  const [health, upgrade, connection] = await Promise.all([
    window.edgeBridge.health(),
    window.edgeBridge.upgradeStatus(),
    window.edgeBridge.connection(),
  ]);
  out.textContent = JSON.stringify({ health, upgrade, connection }, null, 2);
});

printBtn.addEventListener("click", async () => {
  await window.edgeBridge.printEnqueue("xp58");
  const list = await window.edgeBridge.printList();
  out.textContent = JSON.stringify(list, null, 2);
});

out.textContent = [
  `href=${location.href}`,
  `protocol=${location.protocol}`,
  `secureContext=${window.isSecureContext}`,
  `online=${navigator.onLine}`,
].join("\n");
