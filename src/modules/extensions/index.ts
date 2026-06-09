export {
  EXTENSIONS_CHANGED_EVENT,
  emitExtensionsChanged,
  onExtensionsChange,
} from "./events";
export {
  type ExtensionCommand,
  extensionHost,
  useExtensionCommandsStore,
} from "./host";
export {
  installSampleExtension,
  loadExtensions,
  openExtensionsFolder,
  reloadAfterInstall,
  toggleExtension,
  uninstallExtension,
} from "./loader";
export {
  DEFAULT_REGISTRY_URL,
  fetchRegistry,
  getEffectiveRegistryUrl,
  installFromFile,
  installFromRegistry,
  installFromUrl,
  type RegistryEntry,
} from "./registry";
export { getRegistryUrl, setRegistryUrl, useExtensionsStore } from "./store";
export type { ExtensionManifest, LoadedExtension } from "./types";
export { compareVersions, isUpdateAvailable } from "./versioning";
