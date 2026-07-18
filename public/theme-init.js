// İlk boyamadan önce temayı uygular (FOUC koruması). Harici dosya olarak
// duruyor çünkü hem Tauri hem Electron kabuğu `script-src 'self'` CSP'si
// uyguluyor — inline halinde her iki kabukta da bloklanıyordu.
(function () {
  try {
    var t = localStorage.getItem("arterm-ui-theme-shadow");
    var resolved =
      t === "light" || t === "dark"
        ? t
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.classList.add(resolved);
    document.documentElement.style.backgroundColor =
      resolved === "dark" ? "#0a0a0a" : "#ffffff";
  } catch (e) {}
})();
