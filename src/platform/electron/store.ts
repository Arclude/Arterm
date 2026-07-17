type ChangeHandler = (key: string, value: unknown) => void;

/**
 * File-backed stand-in for the Tauri `LazyStore`, reading and writing the
 * same JSON files as tauri-plugin-store (one flat object per file under the
 * app data dir), so settings stay shared between the Tauri and Electron
 * shells. Hydrates lazily on first access; `save()` persists atomically via
 * the preload's `storeWrite`.
 */
export class LazyStore {
  private readonly path: string;
  private readonly defaults: Record<string, unknown>;
  private readonly handlers = new Set<ChangeHandler>();
  private data: Map<string, unknown> | null = null;
  private loading: Promise<Map<string, unknown>> | null = null;

  constructor(path: string, options?: { defaults?: Record<string, unknown> }) {
    this.path = path;
    this.defaults = options?.defaults ?? {};
  }

  private load(): Promise<Map<string, unknown>> {
    if (this.data) return Promise.resolve(this.data);
    this.loading ??= (async () => {
      let parsed: Record<string, unknown> = { ...this.defaults };
      try {
        const raw = await window.artermBridge?.storeRead(this.path);
        if (raw != null) parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Unreadable/corrupt store falls back to defaults, like plugin-store.
      }
      this.data = new Map(Object.entries(parsed));
      return this.data;
    })();
    return this.loading;
  }

  private notify(key: string, value: unknown): void {
    for (const handler of this.handlers) handler(key, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.load()).get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    (await this.load()).set(key, value);
    this.notify(key, value);
  }

  async has(key: string): Promise<boolean> {
    return (await this.load()).has(key);
  }

  async delete(key: string): Promise<boolean> {
    const data = await this.load();
    const existed = data.delete(key);
    if (existed) this.notify(key, undefined);
    return existed;
  }

  async keys(): Promise<string[]> {
    return [...(await this.load()).keys()];
  }

  async values<T>(): Promise<T[]> {
    return [...(await this.load()).values()] as T[];
  }

  async entries<T>(): Promise<[string, T][]> {
    return [...(await this.load()).entries()] as [string, T][];
  }

  async clear(): Promise<void> {
    (await this.load()).clear();
  }

  async save(): Promise<void> {
    const data = await this.load();
    await window.artermBridge?.storeWrite(
      this.path,
      JSON.stringify(Object.fromEntries(data)),
    );
  }

  async onChange<T>(
    cb: (key: string, value: T | undefined) => void,
  ): Promise<() => void> {
    const handler: ChangeHandler = (key, value) =>
      cb(key, value as T | undefined);
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
