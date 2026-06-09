import { create } from "zustand";

/** A command contributed by an executable extension, as surfaced to the UI
 *  (command palette). Declared in the manifest's `contributes.commands`; the
 *  handler is bound lazily when the command is first invoked. */
export type ExtensionCommand = {
  extensionId: string;
  command: string;
  title: string;
  category?: string;
};

type State = {
  commands: ExtensionCommand[];
  /** Replace the full set (called on every extension (re)load). */
  set: (commands: ExtensionCommand[]) => void;
};

/** Contributed commands from all enabled executable extensions. The command
 *  palette reads this to merge extension commands alongside built-in actions. */
export const useExtensionCommandsStore = create<State>((set) => ({
  commands: [],
  set: (commands) => set({ commands }),
}));
