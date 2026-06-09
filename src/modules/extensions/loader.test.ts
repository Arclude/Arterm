import { describe, expect, it } from "vitest";
import { isExecutable, resolveCommands } from "./loader";
import type { ExtensionManifest } from "./types";

const base: ExtensionManifest = {
  id: "acme.demo",
  name: "Demo",
  version: "1.0.0",
};

describe("isExecutable", () => {
  it("is false for a declarative-only manifest", () => {
    expect(isExecutable(base)).toBe(false);
    expect(isExecutable({ ...base, contributes: { themes: [] } })).toBe(false);
  });

  it("is true when a main file is declared", () => {
    expect(isExecutable({ ...base, main: "main.js" })).toBe(true);
  });

  it("is true when inline mainSource is present", () => {
    expect(isExecutable({ ...base, mainSource: "exports.activate=()=>{}" })).toBe(
      true,
    );
  });
});

describe("resolveCommands", () => {
  it("returns nothing for a non-executable extension", () => {
    const m: ExtensionManifest = {
      ...base,
      contributes: {
        commands: [{ command: "demo.hello", title: "Hello" }],
      },
    };
    expect(resolveCommands(m)).toEqual([]);
  });

  it("maps valid commands and stamps the extension id", () => {
    const m: ExtensionManifest = {
      ...base,
      main: "main.js",
      contributes: {
        commands: [
          { command: "demo.hello", title: "Hello", category: "Demo" },
          { command: "demo.bye", title: "Bye" },
        ],
      },
    };
    expect(resolveCommands(m)).toEqual([
      {
        extensionId: "acme.demo",
        command: "demo.hello",
        title: "Hello",
        category: "Demo",
      },
      {
        extensionId: "acme.demo",
        command: "demo.bye",
        title: "Bye",
        category: undefined,
      },
    ]);
  });

  it("drops commands with invalid ids or missing titles", () => {
    const m: ExtensionManifest = {
      ...base,
      mainSource: "exports.activate=()=>{}",
      contributes: {
        commands: [
          { command: "Bad Id!", title: "nope" } as never,
          { command: "demo.ok", title: "   " } as never,
          { command: "demo.good", title: "Good" },
        ],
      },
    };
    expect(resolveCommands(m)).toEqual([
      {
        extensionId: "acme.demo",
        command: "demo.good",
        title: "Good",
        category: undefined,
      },
    ]);
  });
});
