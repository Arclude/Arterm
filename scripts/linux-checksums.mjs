// Uygulama içi güncelleyici (electron/updater.cjs) bu manifesti okur: asset
// adlarını ve sha256'larını buradan öğrenir, GitHub API'sine hiç gitmez
// (kimliksiz API IP başına saatte 60 istekle sınırlı).
//
// Ayrı dosya olarak duruyor çünkü `node -e '...'` içine gömülü Türkçe yorumlar
// kesme işareti taşıyınca shell'in tek tırnaklı string'ini erken kapatıyor.
import { createHash } from "node:crypto";
import fs from "node:fs";

const dir = "release-electron";
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));

const sha256 = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Dosyalar sürüme göre seçilir: çıktı dizininde önceki build kalabilir (yerel
// çalıştırmada kalıyor) ve gelişigüzel eşleşme kullanıcıyı eski bir sürüme
// güncellerdi.
const artifacts = {
  appimage: `Arterm-${version}.AppImage`,
  deb: `arterm_${version}_amd64.deb`,
};

const out = {};
for (const [kind, name] of Object.entries(artifacts)) {
  const file = `${dir}/${name}`;
  if (!fs.existsSync(file)) {
    console.error(`missing ${kind} artifact: ${file}`);
    process.exit(1);
  }
  out[kind] = { name, size: fs.statSync(file).size, sha256: sha256(file) };
}

fs.writeFileSync(`${dir}/linux-checksums.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
