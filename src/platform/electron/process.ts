export async function relaunch(): Promise<void> {
  // Güncelleme sonrası gerçek yeniden başlatma ana süreçten gelir; köprü yoksa
  // (dev, eski preload) sayfayı yenilemek eski davranışı korur.
  const bridge = window.artermBridge;
  if (bridge?.relaunch) {
    await bridge.relaunch();
    return;
  }
  location.reload();
}
