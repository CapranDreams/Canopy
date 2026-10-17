import * as vscode from 'vscode';

export function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** Builds the HTML shell for a webview that loads one script and the shared stylesheet from media/. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const n = nonce();
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${n}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('webview.css')}">
<title>${title}</title>
</head>
<body>
<div id="app" class="loading">Loading…</div>
<script nonce="${n}" src="${media(script)}"></script>
</body>
</html>`;
}
