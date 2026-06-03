import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { offsetToPosition, positionToOffset } from "./codemirror/position";
import { languageInfoForPath, resolveServerConfig } from "./config";
import { pathToUri, sameUri, uriToPath } from "./uri";

describe("uri conversion", () => {
  it("round-trips a Windows path with a drive letter", () => {
    const p = "C:/Users/foo/bar.ts";
    const uri = pathToUri(p);
    expect(uri).toBe("file:///C:/Users/foo/bar.ts");
    expect(uriToPath(uri)).toBe(p);
  });

  it("normalizes backslashes and round-trips", () => {
    expect(pathToUri("C:\\a\\b.rs")).toBe("file:///C:/a/b.rs");
  });

  it("encodes spaces but keeps the drive colon literal", () => {
    const uri = pathToUri("C:/my code/x.py");
    expect(uri).toBe("file:///C:/my%20code/x.py");
    expect(uriToPath(uri)).toBe("C:/my code/x.py");
  });

  it("round-trips a POSIX path", () => {
    const p = "/home/u/p/main.go";
    expect(pathToUri(p)).toBe("file:///home/u/p/main.go");
    expect(uriToPath(pathToUri(p))).toBe(p);
  });

  it("treats drive-letter case and colon encoding as the same target", () => {
    expect(sameUri("file:///C:/A/b.ts", "file:///c%3A/a/B.ts")).toBe(true);
    expect(sameUri("file:///C:/a.ts", "file:///C:/b.ts")).toBe(false);
  });
});

describe("position mapping", () => {
  const doc = Text.of(["const x = 1;", "let yy = 2;", ""]);

  it("maps offset to a 0-based line/character", () => {
    expect(offsetToPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    // first char of line 2 (after "const x = 1;\n" = 13 chars)
    expect(offsetToPosition(doc, 13)).toEqual({ line: 1, character: 0 });
  });

  it("round-trips offset -> position -> offset", () => {
    for (const offset of [0, 5, 13, 18, doc.length]) {
      const back = positionToOffset(doc, offsetToPosition(doc, offset));
      expect(back).toBe(offset);
    }
  });

  it("clamps out-of-range positions to the document bounds", () => {
    expect(positionToOffset(doc, { line: 999, character: 0 })).toBe(doc.length);
    expect(positionToOffset(doc, { line: -1, character: 0 })).toBe(0);
  });
});

describe("language + server resolution", () => {
  it("maps file extensions to languageId and serverId", () => {
    expect(languageInfoForPath("a/b/file.tsx")).toEqual({
      languageId: "typescriptreact",
      serverId: "typescript",
    });
    expect(languageInfoForPath("x.py")).toEqual({
      languageId: "python",
      serverId: "python",
    });
    expect(languageInfoForPath("README.md")).toBeNull();
    expect(languageInfoForPath("Makefile")).toBeNull();
  });

  it("merges a user override over the default and defaults enabled to true", () => {
    const cfg = resolveServerConfig("typescript", {
      typescript: { command: "my-tsls", args: ["--stdio", "--log"] },
    });
    expect(cfg).toEqual({
      command: "my-tsls",
      args: ["--stdio", "--log"],
      enabled: true,
    });
  });

  it("falls back to the default command when no override exists", () => {
    const cfg = resolveServerConfig("rust", {});
    expect(cfg?.command).toBe("rust-analyzer");
  });

  it("returns null for an unknown server id", () => {
    expect(resolveServerConfig("cobol", {})).toBeNull();
  });
});
