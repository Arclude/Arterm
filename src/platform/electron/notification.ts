export async function isPermissionGranted(): Promise<boolean> {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

export function sendNotification(
  options: string | { title: string; body?: string },
): void {
  if (typeof Notification === "undefined") return;
  if (typeof options === "string") {
    new Notification(options);
    return;
  }
  new Notification(options.title, { body: options.body });
}
