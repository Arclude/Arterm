// PTY çıktı bütünlüğü testi: bridge üzerinden bir PTY açar, `seq 1 N` ile
// ardışık numaralı satırlar üretir, akış sırasında pause/resume (backpressure)
// döngüleri enjekte eder ve tüm satırların kayıpsız + sıralı ulaştığını
// doğrular. Electron terminalindeki tuş vuruşu/çıktı sıralama bozulmalarının
// regresyon testi.
//
//   node scripts/bridge-flood.mjs            # 300.000 satır
//   FLOOD_LINES=50000 node scripts/bridge-flood.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const N = Number(process.env.FLOOD_LINES ?? 300_000);
const SENTINEL = "SON-1234-ISARET"; // komut ekosunda asla düz görünmez (aritmetik açılım)
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
    const warnings = [];
    createInterface({ input: child.stderr }).on("line", (l) => {
      if (/backpressure|overflow|discard/i.test(l)) warnings.push(l);
      if (process.env.SMOKE_VERBOSE) console.error(`[bridge] ${l}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = line.match(/^ARTERM_BRIDGE_READY (\S+) (\S+)$/);
      if (m) resolve({ child, url: m[1], token: m[2], warnings });
    });
    setTimeout(() => reject(new Error("bridge handshake zaman aşımı")), 10_000);
  });
}

/** Terminal kontrol dizilerini ayıkla; salt metin satırları kalsın.
 *  OSC (BEL/ST sonlu), CSI, iki karakterli ESC dizileri ve \n dışındaki
 *  kontrol baytları temizlenir — ilk satırı yutan eski eksik filtre yüzünden
 *  yanlış negatif alınmıştı (bkz. 16 Tem 2026 oturumu). */
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL|ST
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-_]/g, "") // Fe (kalan iki baytlı ESC)
    .replace(/\x1b[()#][0-9A-Za-z]/g, "") // charset seçimleri
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ""); // \n hariç kontrol baytları
}

const { child, url, token, warnings } = await startBridge();
const ws = new WebSocket(`${url}/bridge?token=${token}`);
ws.binaryType = "arraybuffer";
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws error"));
});

let nextId = 1;
const pending = new Map();
const chunks = [];
let received = 0;
let sentinelSeen;
const sentinelPromise = new Promise((r) => {
  sentinelSeen = r;
});
let tail = "";

ws.onmessage = (ev) => {
  if (ev.data instanceof ArrayBuffer) {
    const chan = new DataView(ev.data).getUint32(0, true);
    if (chan !== 10) return; // onData kanalı
    const buf = Buffer.from(ev.data.slice(4));
    chunks.push(buf);
    received += buf.length;
    // Nöbetçi parça sınırına denk gelebilir: aramayı kuyruk+chunk üzerinde
    // yap, SONRA kuyruğu kırp (önce kırpmak nöbetçi + prompt aynı chunk'ta
    // gelince nöbetçiyi yutuyordu).
    const joined = tail + buf.toString("utf8");
    if (joined.includes(SENTINEL)) sentinelSeen();
    tail = joined.slice(-(SENTINEL.length - 1));
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.t === "result") {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
  }
};

function invoke(cmd, args = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
  });
}

const ptyId = await invoke("pty_open", {
  cols: 500, // sayılar satır kaydırmasın
  rows: 50,
  cwd: null,
  workspace: null,
  onData: { __arterm_chan__: 10 },
  onExit: { __arterm_chan__: 11 },
});
console.log(`pty açıldı id=${ptyId}, ${N} satır akıtılıyor...`);
await new Promise((r) => setTimeout(r, 500)); // kabuk prompt'u otursun

await invoke("pty_write", {
  id: ptyId,
  data: `seq 1 ${N}; echo SON-$((1233+1))-ISARET\r`,
});

// 3 pause/resume döngüsü: frontend'in watermark akış kontrolünü taklit eder.
// Aktarımın tamamı yüz milisaniyeler sürdüğünden döngüler hemen başlar; amaç
// pause'un akışın ORTASINA denk gelmesi (döngü başına bayt sayısı artmalı).
const cycles = (async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 30));
    await invoke("pty_pause", { id: ptyId });
    const atPause = received;
    await new Promise((r) => setTimeout(r, 200));
    await invoke("pty_resume", { id: ptyId });
    console.log(`  backpressure döngüsü ${i + 1}/3 (pause anında ${atPause} bayt)`);
  }
})();

const timeout = setTimeout(() => {
  console.error(`ZAMAN AŞIMI: nöbetçi görülmedi (${received} bayt alındı)`);
  child.kill();
  process.exit(1);
}, 120_000);
await sentinelPromise;
await cycles;
clearTimeout(timeout);
await invoke("pty_close", { id: ptyId });

// ── doğrulama ────────────────────────────────────────────────────────────
const text = stripAnsi(Buffer.concat(chunks).toString("utf8"));
const digitLines = text
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^\d+$/.test(l));

let ordered = true;
let firstBad = -1;
for (let i = 0; i < Math.min(digitLines.length, N); i++) {
  if (digitLines[i] !== String(i + 1)) {
    ordered = false;
    firstBad = i;
    break;
  }
}

const okCount = digitLines.length === N;
const mb = (received / 1024 / 1024).toFixed(1);
console.log(`\n${digitLines.length}/${N} satır, ${mb} MB, sıralama ${ordered ? "OK" : "BOZUK"}`);
if (warnings.length) console.log(`backpressure uyarıları:\n  ${warnings.join("\n  ")}`);
if (!okCount) {
  console.error(`FAIL: satır sayısı ${digitLines.length}, beklenen ${N}`);
} else if (!ordered) {
  console.error(`FAIL: indeks ${firstBad}: beklenen ${firstBad + 1}, gelen ${digitLines[firstBad]}`);
} else {
  console.log("PASS: kayıpsız ve sıralı");
}

child.kill();
process.exit(okCount && ordered ? 0 : 1);
