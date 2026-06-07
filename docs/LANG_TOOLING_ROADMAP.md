# Artex — Açık Protokol Dil Araçları Yol Haritası

VS Code eklentilerinin verdiği yetenekleri (dil desteği, linter/formatter, syntax/tema, debug)
**eklenti çalıştırmadan**, eklentilerin dayandığı açık protokollerle (LSP / DAP / TextMate) Artex'e
kazandırma planı. 5 ajanlı paralel tasarım çalışmasının çıktısı.

## Özet

Artex'in zaten üretim kalitesinde tam bir **LSP yığını** var (Rust stdio transport + `Content-Length`
framing, `resolve_program` PATH/PATHEXT yürüyüşü, Job-object alt-süreç öldürme, TS JSON-RPC
client/manager/diagnostics, ayarlar UI'ı). Dört yetenekten üçü bu mevcut temelin **uzantısı**, dördüncüsü
(TextMate) ondan **bağımsız**. Bu, sıralamayı belirleyen stratejik içgörü.

## Sıralama

| Sıra | İş | Gerekçe |
|---|---|---|
| **0 (hazırlık)** | `lsp/framing.rs` → `modules/proto/{mod,framing}.rs` taşı; `lsp/process.rs` onu kullansın | Davranış değiştirmeyen mekanik taşıma; Plan 1 ve Plan 4'ün sonradan `lsp/mod.rs`'de çakışmasını önler |
| **1** | **LSP Sunucu Kurulum Yöneticisi** | En yüksek kaldıraç: LSP %90 hazır, tek eksik binary edinme; çalışan kodu tek tıkla deneyime çevirir, çekirdek invariant değişmez (en düşük risk) |
| **2 (paralel)** | **TextMate + VS Code tema importu** | Ayrık dosya kümesine dokunur; `syntaxEngine=lezer` varsayılanı arkasında diğer izlerden bağımsız geliştirilir |
| **3** | **Linter + Formatter** | ESLint/Ruff/Prettier'i otomatik kurmak için Plan 1'e dayanır; *riskli* tek-sunucu→çok-sunucu ve diagnostics-merge refactorları gerektirir |
| **4 (son)** | **DAP / Debug** | En büyük, en yeni alt sistem; `proto` modülü hazır olunca başlar, sıkı bir MVP ile en sona |

**İki iz:** Track A = `0 → 1 → 3 → 4` (LSP/DAP değer zinciri, `process.rs`/`lib.rs`/`EditorPane`'i
paylaştığı için serileştirilir). Track B = `2` (renklendirme/tema, paralel).

## Çakışma Haritası — Aktif yönetilecek 3 sıcak nokta

Tümü **eklemeli (additive)** çakışma; "aynı dosyaya tek seferde tek plan dokunur, append-only" kuralıyla çözülür.

- `src-tauri/src/lib.rs` — `invoke_handler!` makrosuna Plan 1 (`lsp_install_*` ×5), Plan 2 (`fmt_run`), Plan 4 (`dap_*` ×4) ekler.
- `src/modules/editor/EditorPane.tsx` — Plan 2 (linter compartment + Mod-Shift-F), Plan 3 (textmate resolver + tema), Plan 4 (debugCompartment). Her plan kendi compartment'ına + kendi useEffect'ine sahip.
- `src/modules/settings/store.ts` — Plan 2/3/4 `DEFAULT_PREFERENCES` + `onPreferencesChange`'e tercih ekler.

Ek olarak: `src-tauri/src/modules/lsp/mod.rs` (Plan 1 submodüller + Plan 4 framing taşıma — **Plan 4 framing taşıması önce**),
`src-tauri/src/modules/lsp/process.rs`, `src/modules/lsp/config.ts`, `manager.ts`, `extensions.ts`.

## İlk Dikey Dilim (en küçük uçtan uca değer)

**"rust-analyzer'ı tek tıkla kur, `.rs` açınca otomatik başlasın."** Binary sunucu olduğu için Node bağımlılığını
(npm.rs riski) tamamen atlar ve tüm Install-Manager zincirini kanıtlar: registry → güvenli indirme → arşiv açma →
managed çözümleme → mevcut LSP onu spawn eder → canlı diagnostics/completion.

Başlanacak dosyalar (sırayla):
1. `src-tauri/src/modules/lsp/install.rs` (yeni) — `lsp_install_dir_path/_download/_list/_uninstall`, `lsp_resolve_managed`. `net.rs` (validate_url/build_safe_client/bytes_stream) + `sha2` doğrulama + `extensions.rs` guard'ları.
2. `src-tauri/src/modules/lsp/archive.rs` (yeni) — sadece `.gz` tek-dosya yolu (rust-analyzer `.gz` gelir); unix 0o755.
3. `src-tauri/Cargo.toml` — sadece `flate2` + `sha2` (zip/tar sonra).
4. `src-tauri/src/lib.rs` + `lsp/mod.rs` — 5 komutu kaydet (Adım 0 framing taşımasından *sonra*).
5. `src/modules/lsp/installRegistry.ts` (yeni) — sadece `rust` girdisi (GitHub release `.gz` per platform) + `@tauri-apps/plugin-os` platform-key helper.
6. `src/modules/lsp/install.ts` (yeni) — invoke sarmalayıcılar; başarıda `lsp_resolve_managed` → mutlak yolu `lspServers["rust"]`'a `setLspServers` ile yaz → `lspManager.resetAll()`.
7. `src/settings/sections/LanguageServersSection.tsx` — Rust satırına Install/Uninstall butonu + progress (`MarketplaceSection.tsx` `busyId` deseni).

## Değişmez kural: boşluklu yol

Repo yolu boşluk içeriyor (`html css projelerim`). Asla komut string'i kurma — `Command`'a ve npm `--prefix`'e
`PathBuf`/`OsStr` argv dizileri geçir; `process.rs`'in cmd.exe-kullanmama kuralını koru. Tüm spawn'larda geçerli.

## Yetenek planları (özet)

Dördü de **büyük** efor. Tam dosya listeleri, adımlar ve riskler için tasarım çıktısına bakın
(her plan: filesToCreate/filesToModify/steps/risks/newDependencies içerir).
- **Plan 1 (Install Mgr):** install.rs/archive.rs/npm.rs + installRegistry.ts/install.ts; Cargo: zip,flate2,tar,sha2.
- **Plan 2 (Lint/Fmt):** fmt.rs + format/{config,runner}.ts; manager.ts çok-sunucu refactoru + diagnostics.ts per-source merge (yük taşıyan iki refactor).
- **Plan 3 (TextMate):** Motor **B seçildi** (vscode-textmate + vscode-oniguruma → @lezer/highlight tag), shiki DEĞİL — çünkü @replit minimap `state.facet(language).parser` + `highlightingFor` gerektirir, shiki bunları vermez. scopeToTag.ts keystone; vscodeTheme.ts importer.
- **Plan 4 (DAP):** proto/ framing paylaşımı + dap/ transport (lsp klonu); debug/ client/session/store/UI + CodeMirror breakpoint gutter & execution-line. MVP: tek-oturum stdio (debugpy/js-debug/codelldb). 1-tabanlı↔0-tabanlı dönüşüm en olası bug.
