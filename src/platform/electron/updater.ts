// Tauri plugin-updater'ın `check()` sözleşmesinin Electron eşleniği: useUpdater
// aynı `Update` yüzeyini (downloadAndInstall + progress event'leri) sürer, o
// yüzden kabuk farkı hook'a sızmaz. Gerçek indirme/kurulum ana süreçte
// (electron/updater.cjs); burası yalnızca köprü.

interface DownloadEvent {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number | null; chunkLength?: number };
}

export interface ElectronUpdate {
  version: string;
  currentVersion: string;
  body: string;
  downloadAndInstall: (onEvent: (e: DownloadEvent) => void) => Promise<void>;
}

export async function check(): Promise<ElectronUpdate | null> {
  const bridge = window.artermBridge;
  const { updateCheck, updateInstall } = bridge ?? {};
  if (!updateCheck || !updateInstall) return null;

  // Desteklenmeyen kurulum biçiminde (dev checkout, salt-okunur AppImage)
  // ana süreç null döner ve UI elle indirme akışına düşer.
  const info = await updateCheck();
  if (!info) return null;

  return {
    version: info.version,
    currentVersion: info.currentVersion,
    body: info.body,
    downloadAndInstall: async (onEvent) => {
      const off = bridge?.onUpdateProgress?.(onEvent);
      try {
        await updateInstall();
      } finally {
        off?.();
      }
    },
  };
}
