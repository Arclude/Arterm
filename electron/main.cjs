// Arterm Linux kabuğu (Electron). Windows/macOS Tauri kabuğunu kullanır;
// bu giriş yalnızca Linux dağıtımında paketlenir.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { app, BrowserWindow, protocol, net, ipcMain, shell } = require("electron");

const DIST = path.join(__dirname, "..", "dist");
// vite base "/" ile üretilen mutlak asset yolları için dist'i app:// altında servis et
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function serveDist() {
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// Rust backend sidecar (src-tauri/src/bin/arterm-bridge.rs). Prints one
// "ARTERM_BRIDGE_READY <ws-url> <token>" line on stdout once listening.
let bridgeChild = null;

function bridgeBinary() {
  if (process.env.ARTERM_BRIDGE_BIN) return process.env.ARTERM_BRIDGE_BIN;
  const target = path.join(__dirname, "..", "src-tauri", "target");
  for (const profile of ["release", "debug"]) {
    const p = path.join(target, profile, "arterm-bridge");
    try {
      require("node:fs").accessSync(p);
      return p;
    } catch {}
  }
  throw new Error("arterm-bridge binary not found; build it with cargo or set ARTERM_BRIDGE_BIN");
}

function startBridge() {
  return new Promise((resolve, reject) => {
    bridgeChild = spawn(bridgeBinary(), [], { stdio: ["ignore", "pipe", "pipe"] });
    bridgeChild.on("error", reject);
    bridgeChild.on("exit", (code) => {
      console.error(`arterm-bridge exited (code ${code})`);
      bridgeChild = null;
    });
    readline.createInterface({ input: bridgeChild.stderr }).on("line", (l) => {
      console.error(`[bridge] ${l}`);
    });
    const out = readline.createInterface({ input: bridgeChild.stdout });
    out.on("line", (line) => {
      const m = line.match(/^ARTERM_BRIDGE_READY (\S+) (\S+)$/);
      if (m) resolve({ url: m[1], token: m[2] });
    });
    setTimeout(() => reject(new Error("bridge handshake timed out")), 10_000);
  });
}

// tauri.conf.json'daki "settings" WebviewWindow eşleniği: tek instans,
// açıksa odakla; sekme değişimi renderer'ın bridge emit'iyle ulaşır.
let settingsWin = null;

function openSettingsWindow(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setAlwaysOnTop(true);
    settingsWin.show();
    settingsWin.focus();
    return { created: false };
  }
  settingsWin = new BrowserWindow({
    title: "Settings",
    width: 900,
    height: 700,
    minWidth: 820,
    minHeight: 620,
    frame: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  const query = tab ? `?tab=${encodeURIComponent(tab)}` : "";
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    settingsWin.loadURL(new URL(`settings.html${query}`, devUrl).toString());
  } else {
    settingsWin.loadURL(`app://local/settings.html${query}`);
  }
  return { created: true };
}

function createWindow() {
  // tauri.conf.json app.windows[0] ile eşlenik: 800x600, min 420x280,
  // overlay titlebar (Linux'ta frame:false + frontend'in kendi WindowControls'u)
  const win = new BrowserWindow({
    title: "Arterm",
    width: 800,
    height: 600,
    minWidth: 420,
    minHeight: 280,
    frame: false,
    show: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Tauri akışında pencereyi ilk paint sonrası frontend show() eder;
  // Electron'da köprü hazır olana dek ready-to-show yeterli.
  win.once("ready-to-show", () => win.show());

  win.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    if (level === "error" || level === "warning" || process.env.ARTERM_LOG_CONSOLE) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`renderer gone: ${details.reason}`);
  });
  win.webContents.on("did-finish-load", () => {
    setTimeout(() => {
      win.webContents
        .executeJavaScript(
          `({root: document.getElementById("root")?.childElementCount ?? -1,` +
            ` xterm: document.querySelectorAll(".xterm").length,` +
            ` title: document.title})`,
        )
        .then((s) => console.error(`[probe] ${JSON.stringify(s)}`))
        .catch((e) => console.error(`[probe] failed: ${e.message}`));
    }, 4000);
    // ARTERM_PERF_PROBE=1: WebKitGTK'daki takılmanın kök deseni olan
    // JS-güdümlü per-frame invalidasyonu (her karede style.transform yazımı)
    // 5 sn boyunca uygular, kare aralığı istatistiklerini loglar.
    if (process.env.ARTERM_PERF_PROBE) {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(
            `(async () => {
              const el = document.createElement("div");
              el.style.cssText = "position:fixed;left:0;top:0;width:220px;height:120px;z-index:99999;" +
                "background:linear-gradient(45deg,#f0f,#0ff);opacity:.85;will-change:transform;pointer-events:none";
              document.body.appendChild(el);
              const t0 = performance.now();
              let frames = 0, last = t0, x = 0;
              const deltas = [];
              await new Promise((done) => {
                function step(now) {
                  deltas.push(now - last); last = now; frames++;
                  x = (x + 7) % 500;
                  el.style.transform = "translate(" + x + "px," + (Math.sin(now / 100) * 40) + "px)";
                  if (now - t0 < 5000) requestAnimationFrame(step); else done();
                }
                requestAnimationFrame(step);
              });
              el.remove();
              deltas.shift();
              deltas.sort((a, b) => a - b);
              const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
              return {
                fps: +(frames / 5).toFixed(1),
                avgMs: +avg.toFixed(2),
                p95Ms: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1),
                worstMs: +deltas[deltas.length - 1].toFixed(1),
                droppedOver28ms: deltas.filter((d) => d > 28).length,
              };
            })()`,
          )
          .then((r) => console.error(`[perf] ${JSON.stringify(r)}`))
          .catch((e) => console.error(`[perf] failed: ${e.message}`));
      }, 6000);
    }
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL("app://local/index.html");
  }
  return win;
}

app.whenReady().then(async () => {
  let bridgeInfo;
  try {
    bridgeInfo = await startBridge();
  } catch (e) {
    console.error(`bridge start failed: ${e.message}`);
    bridgeInfo = null;
  }
  // Preload reads these synchronously before the page scripts run.
  ipcMain.on("arterm:bridge-info", (event) => {
    event.returnValue = bridgeInfo;
  });
  ipcMain.on("arterm:app-info", (event) => {
    event.returnValue = { name: "Arterm", version: app.getVersion() };
  });
  ipcMain.on("arterm:paths", (event) => {
    event.returnValue = {
      home: app.getPath("home"),
      appConfig: path.join(app.getPath("appData"), "app.arclude.arterm"),
      download: app.getPath("downloads"),
    };
  });
  ipcMain.handle("arterm:win", (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    switch (action) {
      case "minimize":
        win.minimize();
        return null;
      case "toggleMaximize":
        win.isMaximized() ? win.unmaximize() : win.maximize();
        return null;
      case "isMaximized":
        return win.isMaximized();
      case "close":
        win.close();
        return null;
      case "show":
        win.show();
        return null;
      case "setFocus":
        win.focus();
        return null;
      default:
        return null;
    }
  });
  // plugin-store dosya eşleniği: Tauri v2 store'ları app_data_dir altında tutar
  // (Linux: ~/.local/share/app.arclude.arterm/<path>). Aynı dosyaları okuyup
  // yazarız ki ayarlar iki kabuk arasında ortak kalsın.
  const fs = require("node:fs");
  const dataDir = path.join(
    process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share"),
    "app.arclude.arterm",
  );
  const storeFile = (rel) => {
    const file = path.normalize(path.join(dataDir, rel));
    if (!file.startsWith(dataDir)) throw new Error("store path escapes data dir");
    return file;
  };
  ipcMain.handle("arterm:store-read", (_e, rel) => {
    try {
      return fs.readFileSync(storeFile(rel), "utf8");
    } catch {
      return null;
    }
  });
  ipcMain.handle("arterm:store-write", (_e, rel, contents) => {
    const file = storeFile(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
    return null;
  });
  ipcMain.handle("arterm:open-settings", (_e, tab) => openSettingsWindow(tab));
  ipcMain.handle("arterm:open-external", (_e, url) => shell.openExternal(url));
  ipcMain.handle("arterm:open-path", (_e, p) => shell.openPath(p));
  ipcMain.handle("arterm:reveal", (_e, p) => shell.showItemInFolder(p));
  serveDist();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  if (bridgeChild) bridgeChild.kill();
});
