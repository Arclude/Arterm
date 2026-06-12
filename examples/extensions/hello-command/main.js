// Arterm executable extension — entry point.
//
// This file runs inside a sandboxed Web Worker. There is no DOM, no `window`,
// and no direct filesystem access. Everything you can do comes from the global
// `arterm` API object; capabilities that touch the user's files (like
// `workspace.fs`) require the matching permission in arterm-extension.json.
//
// You get `arterm`, `module`, `exports`, and `console` in scope. Set
// `exports.activate(context)` (and optionally `exports.deactivate()`).

exports.activate = (context) => {
  // A simple command. The title shows in the command palette under "Hello".
  context.subscriptions.push(
    arterm.commands.registerCommand("hello.world", () => {
      arterm.window.showInformationMessage("👋 Hello from your extension!");
    }),
  );

  // A command that uses a permission-gated capability (needs "fs:read").
  context.subscriptions.push(
    arterm.commands.registerCommand("hello.readPackage", async () => {
      try {
        const text = await arterm.workspace.fs.readTextFile("package.json");
        arterm.window.showInformationMessage(
          `package.json is ${text.length} characters`,
        );
      } catch (err) {
        arterm.window.showErrorMessage(`Could not read package.json: ${err.message}`);
      }
    }),
  );

  console.log("hello-command activated");
};

exports.deactivate = () => {
  // Anything pushed to context.subscriptions is disposed automatically.
};
