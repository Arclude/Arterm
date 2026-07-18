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
# sha256'ya karşı doğrular; asset adlarını da buradan öğrenir.
node scripts/linux-checksums.mjs

ls -lah release-electron/*.AppImage release-electron/*.deb release-electron/linux-checksums.json 2>/dev/null
