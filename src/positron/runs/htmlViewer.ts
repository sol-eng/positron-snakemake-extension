// Shows an HTML file in a Viewer panel of the extension's own, with a button
// back to the dashboard it was opened from (Snakemake's report, or a job's
// HTML output). Positron's `previewHtml` shows a
// file as is, and cannot tell the extension when to go back.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi, PreviewPanel } from "@posit-dev/positron";

import { pageWithBackButton } from "./htmlPage";

export type HtmlPage = {
  file: string;
  title: string;
  backLabel: string;
  onBack: () => unknown;
};

export class HtmlViewer implements vscode.Disposable {
  private panel: PreviewPanel | undefined;
  private onBack: (() => unknown) | undefined;
  private roots: string[] = [];

  constructor(
    private readonly api: PositronApi,
    private readonly media: vscode.Uri
  ) {}

  show(page: HtmlPage) {
    const dir = path.dirname(page.file);
    // the panel can only load files from its roots, set when it is made
    const roots = [dir, this.media.fsPath];
    if (this.panel && roots.some((r) => !this.roots.includes(r))) {
      this.panel.dispose();
    }
    this.onBack = page.onBack;
    if (!this.panel) {
      this.roots = roots;
      this.panel = this.api.window.createPreviewPanel(
        "snakemake.htmlPage",
        page.title,
        true,
        {
          enableScripts: true,
          localResourceRoots: roots.map((r) => vscode.Uri.file(r))
        }
      );
      this.panel.webview.onDidReceiveMessage((message) => {
        if (message?.type !== "back") return;
        const back = this.onBack;
        this.panel?.dispose();
        back?.();
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.onBack = undefined;
        this.roots = [];
      });
    } else {
      this.panel.title = page.title;
      this.panel.reveal(true);
    }
    const webview = this.panel.webview;
    webview.html = pageWithBackButton(fs.readFileSync(page.file, "utf8"), {
      backLabel: page.backLabel,
      resolve: (relative) => {
        const target = path.resolve(dir, decodeURI(relative.split(/[?#]/)[0]));
        return webview.asWebviewUri(vscode.Uri.file(target)).toString();
      },
      mermaidSrc: webview
        .asWebviewUri(vscode.Uri.joinPath(this.media, "mermaid.min.js"))
        .toString()
    });
  }

  dispose() {
    this.panel?.dispose();
  }
}
