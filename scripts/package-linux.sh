#!/bin/bash
# Linux (Electron) paketi: AppImage + deb → release-electron/
# Staging (release-app/) bağımlılıksız bir package.json taşır ve electron-builder
# --project ile oradan koşulur; böylece kökteki pnpm-lock.yaml yüzünden
# node-module-collector'ın pnpm/corepack çağırması engellenir (Node 22'de
# corepack pnpm kırık — bkz. bellek: pnpm/corepack workaround).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d dist ] || { echo "dist/ yok — önce 'vite build' çalıştır"; exit 1; }
[ -f src-tauri/target/release/arterm-bridge ] || {
  echo "release arterm-bridge yok — önce 'cargo build --release --bin arterm-bridge'"; exit 1; }

rm -rf release-app
mkdir -p release-app/build
node -e '
const p = require("./package.json");
require("fs").writeFileSync(
  "release-app/package.json",
  JSON.stringify({
    name: p.name,
    version: p.version,
    main: "electron/main.cjs",
    private: true,
    homepage: "https://arclude.com",
    description: "AI-native terminal and editor",
    author: "Arclude <info@arclude.com>",
  }, null, 2),
);'
cp -r dist electron release-app/
cp electron-builder.yml release-app/
cp src-tauri/target/release/arterm-bridge release-app/build/
cp src-tauri/icons/128x128.png release-app/build/icon.png

npx --yes electron-builder --linux --project release-app --config electron-builder.yml

# Uygulama içi güncelleyici (electron/updater.cjs) indirdiği dosyayı buradaki
# sha256'ya karşı doğrular; asset adlarını da buradan öğrenir, GitHub API'sine
# hiç gitmez (kimliksiz API IP başına saatte 60 istekle sınırlı).
node -e '
const fs = require("fs");
const crypto = require("crypto");
const dir = "release-electron";
const version = require("./package.json").version;
const sha = (f) =>
  crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
// Dosyaları sürüme göre seçiyoruz: çıktı dizininde önceki build'ler durabilir
// (yerel çalıştırmada durur) ve rastgele eşleşme kullanıcıyı eski bir sürüme
// "güncellerdi".
const out = {};
for (const [kind, name] of [
  ["appimage", `Arterm-${version}.AppImage`],
  ["deb", `arterm_${version}_amd64.deb`],
]) {
  const p = `${dir}/${name}`;
  if (!fs.existsSync(p)) throw new Error(`missing ${kind} artifact: ${p}`);
  out[kind] = { name, size: fs.statSync(p).size, sha256: sha(p) };
}
fs.writeFileSync(`${dir}/linux-checksums.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));'

ls -lah release-electron/*.AppImage release-electron/*.deb release-electron/linux-checksums.json 2>/dev/null
