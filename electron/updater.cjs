// Linux otomatik güncelleme. electron-updater kullanmıyoruz: paketleme
// release-app/ altındaki bağımlılıksız bir package.json'dan koşuyor
// (npmRebuild: false, pnpm/corepack Node 22'de kırık — bkz. package-linux.sh),
// yeni bir runtime bağımlılığı o akışı bozardı. GitHub Releases API'si zaten
// bize yeterli.
//
// İki kurulum biçimi desteklenir:
//   AppImage → dosyayı yerinde değiştir, parola sormaz, tam otomatik.
//   deb      → yeni .deb'i indir, pkexec ile kur (sistem parolası sorulur).
//              apt aynı paket adını yerinde yükseltir, eski sürüm kalmaz.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { app, net } = require("electron");

const REPO = "Arclude/Arterm";
// GitHub REST API'sini bilerek kullanmıyoruz: kimliksiz istekler IP başına
// saatte 60 ile sınırlı ve ortak NAT arkasındaki kullanıcılar güncelleme
// kontrolünde 403 yiyor. Release asset'leri statik indirmedir, limiti yoktur.
const LATEST_MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`;
// İndirme yalnızca kendi release'lerimizden yapılabilir; kurulacak her URL bu
// ön eke karşı doğrulanır.
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const UA = "Arterm-Updater";

/** "appimage" | "deb" | null (dev checkout veya tanınmayan kurulum). */
function installKind() {
  // AppImage runtime'ı bu değişkeni AppImage dosyasının yoluna set eder.
  const appImage = process.env.APPIMAGE;
  if (appImage && fs.existsSync(appImage)) {
    try {
      fs.accessSync(appImage, fs.constants.W_OK);
      return "appimage";
    } catch {
      // Yazılamıyorsa (ör. root'a ait bir konuma konmuş) yerinde güncelleme
      // yapamayız; deb yoluna düşmek de yanlış olur.
      return null;
    }
  }
  if (process.execPath.startsWith("/opt/")) return "deb";
  return null;
}

function parseVersion(v) {
  return String(v)
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

function isNewer(remote, current) {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Yeni sürüm varsa tanımını döner, yoksa null. */
async function checkUpdate() {
  const kind = installKind();
  if (!kind) return null;

  // latest.json her release'de yayımlanır (Tauri updater manifesti); Linux
  // için yalnızca sürüm ve notları buradan alıyoruz.
  const res = await net.fetch(LATEST_MANIFEST, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`update manifest: HTTP ${res.status}`);
  const manifest = await res.json();

  const version = String(manifest.version ?? "").replace(/^v/, "");
  const current = app.getVersion();
  if (!version || !isNewer(version, current)) return null;

  // Asset adları ve sha256'ları scripts/package-linux.sh tarafından üretilip
  // release'e yüklenir; indirmeyi buna karşı doğruluyoruz.
  const sumsUrl = `${ASSET_PREFIX}v${version}/linux-checksums.json`;
  const sumsRes = await net.fetch(sumsUrl, { headers: { "User-Agent": UA } });
  if (!sumsRes.ok) {
    throw new Error(`release ${version} has no Linux checksum manifest`);
  }
  const sums = await sumsRes.json();
  const entry = sums[kind];
  if (!entry?.name || !entry?.sha256) {
    throw new Error(`release ${version} has no ${kind} asset`);
  }

  const url = `${ASSET_PREFIX}v${version}/${entry.name}`;
  if (!url.startsWith(ASSET_PREFIX)) {
    throw new Error("refusing to download asset from unexpected host");
  }

  return {
    kind,
    version,
    currentVersion: current,
    body: String(manifest.notes ?? ""),
    url,
    size: typeof entry.size === "number" ? entry.size : null,
    digest: `sha256:${entry.sha256}`,
  };
}

/** İndirir, ilerlemeyi onProgress ile bildirir, dosya yolunu döner. */
async function download(update, dest, onProgress) {
  const res = await net.fetch(update.url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const header = Number(res.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : update.size;
  onProgress({ event: "Started", data: { contentLength: total ?? null } });

  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(dest, { mode: 0o644 });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) {
        await new Promise((r) => out.once("drain", r));
      }
      onProgress({ event: "Progress", data: { chunkLength: value.length } });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }

  if (update.digest) {
    const [algo, expected] = update.digest.split(":");
    if (algo === "sha256" && hash.digest("hex") !== expected) {
      fs.unlinkSync(dest);
      throw new Error("downloaded file failed checksum verification");
    }
  }
  onProgress({ event: "Finished" });
  return dest;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      // pkexec: 126 = yetkilendirme reddedildi, 127 = kullanıcı iptal etti.
      else if (code === 126 || code === 127) {
        reject(new Error("authorization cancelled"));
      } else {
        reject(new Error(stderr.trim() || `${cmd} exited with ${code}`));
      }
    });
  });
}

async function installAppImage(file) {
  const target = process.env.APPIMAGE;
  fs.chmodSync(file, 0o755);
  // Aynı dosya sisteminde rename atomiktir: yarıda kesilse bile çalışan bir
  // AppImage kalır, yarım yazılmış bir dosya değil.
  fs.renameSync(file, target);
}

async function installDeb(file) {
  // apt-get, dpkg -i'nin aksine bağımlılıkları da çözer; aynı paket adı
  // (arterm) olduğu için kurulum eski sürümü yerinde değiştirir.
  await run("pkexec", ["apt-get", "install", "-y", "--allow-downgrades", file]);
}

/** İndirir + kurar. Çağıran bittiğinde uygulamayı yeniden başlatmalı. */
async function downloadAndInstall(update, onProgress) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arterm-update-"));
  const file = path.join(dir, path.basename(new URL(update.url).pathname));
  try {
    await download(update, file, onProgress);
    if (update.kind === "appimage") {
      await installAppImage(file);
    } else {
      await installDeb(file);
    }
  } finally {
    // AppImage yolunda dosya taşındı; kalanları her durumda temizle ki
    // indirilen paketler /tmp'de birikmesin.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function relaunch() {
  // AppImage'de execPath sıkıştırılmış imajın içindeki binary'yi gösterir;
  // yeniden başlatırken dış AppImage dosyasını çalıştırmalıyız.
  const appImage = process.env.APPIMAGE;
  app.relaunch(appImage ? { execPath: appImage } : undefined);
  app.exit(0);
}

module.exports = { installKind, checkUpdate, downloadAndInstall, relaunch };
