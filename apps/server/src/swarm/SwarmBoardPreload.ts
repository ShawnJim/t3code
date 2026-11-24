export function renderSwarmBoardPreloadScript(): string {
  return `(() => {
  const resolveSidecarUrl = (input) => {
    if (typeof input === "string" && input.startsWith("/") && !input.startsWith("//")) {
      return new URL(input.slice(1), document.baseURI).toString();
    }
    return input;
  };

  const applyThemeTokens = (tokens, scheme) => {
    if (!tokens || typeof tokens !== "object") return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(tokens)) {
      if (typeof name === "string" && name.startsWith("--") && typeof value === "string") {
        root.style.setProperty(name, value);
      }
    }
    if (scheme === "dark" || scheme === "light") {
      root.dataset.theme = scheme;
      root.style.colorScheme = scheme;
    }
  };

  let notifiedExpired = false;
  window.sidecar = {
    conversationId: "",
    fetch: async (input, init) => {
      const response = await window.fetch(resolveSidecarUrl(input), init);
      if (response.status === 401 && !notifiedExpired) {
        notifiedExpired = true;
        window.parent?.postMessage({ type: "t3-swarm:token-expired" }, "*");
      }
      return response;
    },
    ui: {
      toggleAuxPane: (options) => {
        if (options && options.tabType === "fileView" && typeof options.uri === "string") {
          window.parent?.postMessage({ type: "t3-swarm:open-file", uri: options.uri }, "*");
        }
      },
      toggleConversation: (conversationId) => {
        if (typeof conversationId === "string" && conversationId.length > 0) {
          window.parent?.postMessage(
            { type: "t3-swarm:open-conversation", conversationId, baseUrl: document.baseURI },
            "*",
          );
        }
      },
    },
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "t3-swarm:theme") {
      applyThemeTokens(data.tokens, data.scheme);
    }
  });

  window.parent?.postMessage({ type: "t3-swarm:ready", baseUrl: document.baseURI }, "*");
})();
`;
}

export function renderSwarmBoardUnavailableHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm</title>
  <script src="./preload.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      --sw-bg: var(--background, #141416);
      --sw-fg: var(--foreground, #ececef);
      --sw-muted: var(--muted-foreground, #8e9299);
      --sw-border: var(--border, rgba(255, 255, 255, 0.1));
      --sw-font: var(--font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--sw-bg);
      color: var(--sw-fg);
      font-family: var(--sw-font);
    }
    body {
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      max-width: 420px;
      text-align: center;
      padding: 24px 20px;
      border: 1px solid var(--sw-border);
      border-radius: 10px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 600;
    }
    p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--sw-muted);
    }
  </style>
</head>
<body>
  <section class="card">
    <h2>Antigravity Swarm panel not installed yet</h2>
    <p>Start an Antigravity thread in T3 Code once so the bundled Antigravity runtime extracts its Swarm board, then reload this panel.</p>
  </section>
</body>
</html>`;
}
