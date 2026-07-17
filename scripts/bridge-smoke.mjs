// Electron köprüsü duman testi: arterm-bridge'i başlatır, WS üzerinden yeni
// dispatch arm'larını (ssh/lsp/dap/net/agent/cli/wsl) ve emit fan-out'unu
// uçtan uca doğrular. Ağ testleri yerel bir HTTP sunucusuna karşı koşar.
//
//   node scripts/bridge-smoke.mjs
//   ARTERM_BRIDGE_BIN=/path/to/arterm-bridge node scripts/bridge-smoke.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function bridgeBinary() {
  if (process.env.ARTERM_BRIDGE_BIN) return process.env.ARTERM_BRIDGE_BIN;
  // Testler taze kodu hedeflemeli: iki profil de varsa mtime'ı yeni olanı seç
  // (bayat release binary'si yeni komutları bilmez ve yanlış negatif üretir).
  let best = null;
  for (const profile of ["release", "debug"]) {
    const p = path.join(ROOT, "src-tauri", "target", profile, "arterm-bridge");
    try {
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { p, mtime };
    } catch {}
  }
  if (best) return best.p;
  throw new Error(
    "arterm-bridge bulunamadı; `cargo build --bin arterm-bridge` ile derle veya ARTERM_BRIDGE_BIN ver",
  );
}

function startBridge() {
  return new Promise((resolve, reject) => {
    const child = spawn(bridgeBinary(), [], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    createInterface({ input: child.stderr }).on("line", (l) => {
      if (process.env.SMOKE_VERBOSE) console.error(`[bridge] ${l}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = line.match(/^ARTERM_BRIDGE_READY (\S+) (\S+)$/);
      if (m) resolve({ child, url: m[1], token: m[2] });
    });
    setTimeout(() => reject(new Error("bridge handshake zaman aşımı")), 10_000);
  });
}

/** Minimal v1 protokol istemcisi (src/platform/electron/transport.ts eşleniği). */
class Conn {
  constructor(url, token) {
    this.ws = new WebSocket(`${url}/bridge?token=${token}`);
    this.ws.binaryType = "arraybuffer";
    this.next = 1;
    this.pending = new Map();
    this.chans = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const chan = new DataView(ev.data).getUint32(0, true);
        this.chans.get(chan)?.(ev.data.slice(4));
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.t === "result") {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
      } else if (msg.t === "chan") {
        this.chans.get(msg.chan)?.(msg.value);
      } else if (msg.t === "event") {
        this.events.push(msg);
      }
    };
  }
  invoke(cmd, args = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
    });
  }
  emit(event, payload) {
    this.ws.send(JSON.stringify({ t: "emit", event, payload }));
  }
  chan(id, fn) {
    this.chans.set(id, fn);
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const { child, url, token } = await startBridge();
const c = new Conn(url, token);
await c.ready;

// ── düz çağrılar ─────────────────────────────────────────────────────────
check("lsp_install_dir", typeof (await c.invoke("lsp_install_dir")) === "string");
check("lsp_install_list", Array.isArray(await c.invoke("lsp_install_list")));
check("wsl_list_distros", Array.isArray(await c.invoke("wsl_list_distros")));
check("wsl_default_distro", (await c.invoke("wsl_default_distro")) === null);
check("wsl_home err", await c.invoke("wsl_home", { distro: "x" }).then(() => false, () => true));
check("agent_claude_hooks_status", typeof (await c.invoke("agent_claude_hooks_status")) === "boolean");
check("arterm_cli_list_sessions", Array.isArray(await c.invoke("arterm_cli_list_sessions")));
check("dap_stop_all", (await c.invoke("dap_stop_all")) === 0);
check("lsp_stop_all", (await c.invoke("lsp_stop_all")) === 0);

// ── hata yolları (arm'ın varlığını ve doğrulamasını kanıtlar) ───────────
check("ssh_write no-shell", await c.invoke("ssh_write", { id: 999, data: "x" }).then(() => false, (e) => /no shell/.test(e.message)));
check("ssh_sftp_list no-conn", await c.invoke("ssh_sftp_list", { connId: 999, path: "/" }).then(() => false, (e) => /no connection/.test(e.message)));
check("dap_send no-adapter", await c.invoke("dap_send", { id: 9, message: "{}" }).then(() => false, (e) => /no debug adapter/.test(e.message)));
check("lsp_start empty cmd", await c.invoke("lsp_start", { languageId: "x", command: "", args: [], cwd: null, onMessage: { __arterm_chan__: 1 } }).then(() => false, (e) => /empty language server/.test(e.message)));
check("unknown cmd err", await c.invoke("definitely_not_a_command").then(() => false, (e) => /not implemented/.test(e.message)));

// ── lsp_start gerçek spawn (cat frame üretmez ama süreç açılır) ─────────
const sid = await c.invoke("lsp_start", { languageId: "test", command: "cat", args: [], cwd: null, onMessage: { __arterm_chan__: 42 } });
check("lsp_start spawn", typeof sid === "number" && sid >= 1);
check("lsp_send", (await c.invoke("lsp_send", { id: sid, message: '{"jsonrpc":"2.0"}' })) === null);
check("lsp_stop", (await c.invoke("lsp_stop", { id: sid })) === null);

// ── net: yerel HTTP sunucusuna karşı ai_http_request/stream ─────────────
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "x-smoke": "1" });
  res.end("hello-bridge");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const resp = await c.invoke("ai_http_request", {
  url: `http://127.0.0.1:${port}/x`,
  method: "GET",
  headers: null,
  body: null,
  allowPrivateNetwork: true,
});
check("ai_http_request status", resp.status === 200);
check("ai_http_request header", resp.headers["x-smoke"] === "1");
check("ai_http_request body", Buffer.from(resp.body).toString() === "hello-bridge");
check("ai_http_request ssrf", await c.invoke("ai_http_request", { url: `http://127.0.0.1:${port}/x`, method: "GET", allowPrivateNetwork: false }).then(() => false, (e) => /private|loopback/.test(e.message)));

const streamEvents = [];
c.chan(77, (v) => streamEvents.push(v));
await c.invoke("ai_http_stream", {
  url: `http://127.0.0.1:${port}/s`,
  method: "GET",
  headers: null,
  body: null,
  allowPrivateNetwork: true,
  onEvent: { __arterm_chan__: 77 },
});
await new Promise((r) => setTimeout(r, 100));
const kinds = streamEvents.map((e) => e.kind);
check("ai_http_stream headers", kinds[0] === "headers" && streamEvents[0].status === 200);
check("ai_http_stream chunk", kinds.includes("chunk") && Buffer.from(streamEvents.find((e) => e.kind === "chunk").bytes).toString() === "hello-bridge");
check("ai_http_stream end", kinds[kinds.length - 1] === "end");
srv.close();

// ── iki bağlantı arasında emit fan-out ──────────────────────────────────
const c2 = new Conn(url, token);
await c2.ready;
await new Promise((r) => setTimeout(r, 50));
c.emit("smoke-test-event", { x: 1 });
await new Promise((r) => setTimeout(r, 150));
check("emit fan-out reaches other conn", c2.events.some((e) => e.event === "smoke-test-event" && e.payload?.x === 1));
check("emit not echoed to sender", !c.events.some((e) => e.event === "smoke-test-event"));

console.log(`\n${pass} passed, ${fail} failed`);
child.kill();
process.exit(fail ? 1 : 0);
