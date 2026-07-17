type UnlistenFn = () => void;

function winCtl(
  action: Parameters<NonNullable<Window["artermBridge"]>["winCtl"]>[0],
): Promise<unknown> {
  return window.artermBridge?.winCtl(action) ?? Promise.resolve(undefined);
}

/**
 * Mirror of the Tauri `Window` surface actually used by the app. Window control
 * is delegated to the preload's `winCtl`; focus changes map to DOM focus/blur.
 */
export function getCurrentWindow() {
  return {
    async show(): Promise<void> {
      await winCtl("show");
    },
    // No renderer-side hide under Electron; kept as a no-op for surface parity.
    async hide(): Promise<void> {},
    async minimize(): Promise<void> {
      await winCtl("minimize");
    },
    async close(): Promise<void> {
      await winCtl("close");
    },
    async toggleMaximize(): Promise<void> {
      await winCtl("toggleMaximize");
    },
    async isMaximized(): Promise<boolean> {
      return Boolean(await winCtl("isMaximized"));
    },
    async setFocus(): Promise<void> {
      await winCtl("setFocus");
    },
    async setTitle(title: string): Promise<void> {
      document.title = title;
    },
    async onFocusChanged(
      cb: (event: { payload: boolean }) => void,
    ): Promise<UnlistenFn> {
      const onFocus = () => cb({ payload: true });
      const onBlur = () => cb({ payload: false });
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      };
    },
    async onResized(
      cb: (event: { payload: { width: number; height: number } }) => void,
    ): Promise<UnlistenFn> {
      const onResize = () =>
        cb({ payload: { width: window.innerWidth, height: window.innerHeight } });
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    },
  };
}
