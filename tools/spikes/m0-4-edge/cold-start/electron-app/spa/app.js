const out = document.getElementById("out");
const btn = document.getElementById("btn");

btn.addEventListener("click", async () => {
  try {
    if (!window.edgeBridge?.ping) {
      out.textContent = "edgeBridge missing (preload failed)";
      return;
    }
    const res = await window.edgeBridge.ping();
    out.textContent = JSON.stringify(res, null, 2);
  } catch (err) {
    out.textContent = String(err);
  }
});

out.textContent = [
  `href=${location.href}`,
  `protocol=${location.protocol}`,
  `secureContext=${window.isSecureContext}`,
  `online=${navigator.onLine}`,
].join("\n");
