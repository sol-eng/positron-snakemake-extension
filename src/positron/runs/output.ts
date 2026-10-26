// A terminal per run that follows the run's output file, so the output can
// be shown again after a window reload.

import * as fs from "fs";
import * as vscode from "vscode";

import { isActive, type Run } from "./store";

const terminals = new Map<string, vscode.Terminal>();

export function trackOutputTerminals(): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((terminal) => {
    for (const [dir, t] of terminals) if (t === terminal) terminals.delete(dir);
  });
}

export function showOutput(run: Run, preserveFocus = false) {
  const existing = terminals.get(run.files.dir);
  if (existing) {
    existing.show(preserveFocus);
    return;
  }
  const write = new vscode.EventEmitter<string>();
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  const pump = () => {
    let text = "";
    try {
      const fd = fs.openSync(run.files.output, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > offset) {
          const buffer = Buffer.alloc(size - offset);
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          offset = size;
          text = buffer.toString("utf8");
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // not created yet
    }
    if (text) write.fire(text.replace(/\r?\n/g, "\r\n"));
    if (!isActive(run) && !text) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => {
      pump();
      timer = setInterval(pump, 500);
    },
    close: () => clearInterval(timer),
    handleInput: (data) => {
      // Ctrl+C stops the run, as it would in a shell
      if (data === "\x03" && isActive(run)) {
        vscode.commands.executeCommand("snakemake.positron.runs.stop", {
          kind: "run",
          run
        });
      }
    }
  };
  const terminal = vscode.window.createTerminal({
    name: `Snakemake: ${run.record.runName}`,
    pty,
    iconPath: new vscode.ThemeIcon("play-circle")
  });
  terminals.set(run.files.dir, terminal);
  terminal.show(preserveFocus);
}
