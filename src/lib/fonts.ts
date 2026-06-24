const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

// Bundled block-art font (see styles/fonts.css). unicode-range scopes it to
// box-drawing/block/braille codepoints only, so prepending it never affects
// normal text metrics or the user's chosen font — it just guarantees those
// glyphs tile full-cell in xterm's DOM renderer.
const BLOCK_GLYPH_FONT = '"ArtermBlocks"';
const FALLBACK_CHAIN = `${BLOCK_GLYPH_FONT}, "JetBrains Mono", SFMono-Regular, Menlo, monospace`;

let detected: string | null = null;
let monoReady: Promise<void> | null = null;

export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
    // U+2588 (full block) forces the block-art subset to load.
    document.fonts.load('400 14px "ArtermBlocks"', "█"),
  ]).then(() => undefined);
  return monoReady;
}

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined" || !document.fonts) {
    detected = FALLBACK_CHAIN;
    return detected;
  }
  for (const f of NERD_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`12px "${f}"`)) {
        // Block font stays first; the detected Nerd Font follows it.
        detected = `${BLOCK_GLYPH_FONT}, "${f}", "JetBrains Mono", SFMono-Regular, Menlo, monospace`;
        return detected;
      }
    } catch {
      // Some browsers throw on invalid font shorthand; ignore.
    }
  }
  detected = FALLBACK_CHAIN;
  return detected;
}
