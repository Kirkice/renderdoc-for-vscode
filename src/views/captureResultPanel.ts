import * as vscode from 'vscode';

type CaptureResultDecision = 'save' | 'openTemporary' | 'delete' | 'dismiss';

type CaptureResultMessage =
    | { type: 'ready' }
    | { type: 'save' }
    | { type: 'openTemporary' }
    | { type: 'delete' };

export class CaptureResultPanel {
  private static currentPanel: vscode.WebviewPanel | undefined;

    public static async show(capturePath: string): Promise<CaptureResultDecision> {
    CaptureResultPanel.closeCurrent();
        const panel = vscode.window.createWebviewPanel(
            'renderdoc-capture-result',
            'Captured Frame',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: false },
        );
    CaptureResultPanel.currentPanel = panel;

        return await new Promise<CaptureResultDecision>((resolve) => {
            let settled = false;
            const settle = (decision: CaptureResultDecision) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (CaptureResultPanel.currentPanel === panel) {
                  CaptureResultPanel.currentPanel = undefined;
                }
                resolve(decision);
                panel.dispose();
            };

            panel.webview.html = getHtml(capturePath);
            panel.webview.onDidReceiveMessage((message: CaptureResultMessage) => {
                switch (message.type) {
                    case 'ready':
                        break;
                    case 'save':
                        settle('save');
                        break;
                    case 'openTemporary':
                        settle('openTemporary');
                        break;
                    case 'delete':
                        settle('delete');
                        break;
                }
            });
            panel.onDidDispose(() => settle('dismiss'));
        });
    }

        public static closeCurrent() {
          if (CaptureResultPanel.currentPanel) {
            const panel = CaptureResultPanel.currentPanel;
            CaptureResultPanel.currentPanel = undefined;
            panel.dispose();
          }
        }
}

function getHtml(capturePath: string): string {
    const nonce = String(Date.now());
    const fileName = escapeHtml(capturePath.split(/[\\/]/).pop() || capturePath);
    const filePath = escapeHtml(capturePath);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark;
      --bg-0: #10151c;
      --bg-1: #171e27;
      --line: rgba(133, 152, 173, 0.18);
      --text-dim: rgba(234, 240, 245, 0.66);
      --shadow: 0 24px 56px rgba(0, 0, 0, 0.3);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
      color: #eef4f8;
      background:
        radial-gradient(circle at top left, rgba(112, 208, 198, 0.14), transparent 28%),
        radial-gradient(circle at top right, rgba(201, 139, 82, 0.12), transparent 24%),
        linear-gradient(180deg, var(--bg-1), var(--bg-0) 60%, #0d1217 100%);
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 16px;
    }
    .hero,
    .surface,
    .choice {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(29, 37, 48, 0.98), rgba(18, 24, 31, 0.98));
      box-shadow: var(--shadow);
    }
    .hero::after,
    .surface::after,
    .choice::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(135deg, rgba(112, 208, 198, 0.07), transparent 34%, rgba(201, 139, 82, 0.08));
    }
    .hero,
    .surface { padding: 18px 20px; }
    .eyebrow {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--text-dim);
    }
    .heroTitle {
      margin-top: 8px;
      font-size: 28px;
      line-height: 1.08;
      font-weight: 760;
      max-width: 18ch;
    }
    .heroText,
    .meta,
    .choiceText {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-dim);
    }
    .surfaceTitle {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .mono {
      font-family: Consolas, "Cascadia Code", monospace;
      color: #dbe6ee;
      word-break: break-all;
    }
    .choices {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .choice {
      padding: 16px;
      display: grid;
      gap: 10px;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, filter 160ms ease;
    }
    .choice:hover {
      transform: translateY(-2px);
      border-color: rgba(112, 208, 198, 0.34);
      filter: brightness(1.03);
    }
    .choiceTitle {
      font-size: 16px;
      font-weight: 700;
    }
    .choiceSave .pill,
    .choiceOpen .pill,
    .choiceDelete .pill {
      display: inline-flex;
      width: fit-content;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid rgba(133, 152, 173, 0.2);
      background: rgba(133, 152, 173, 0.08);
      color: #d8dfe7;
    }
    .choiceSave .pill {
      border-color: rgba(112, 208, 198, 0.28);
      background: rgba(112, 208, 198, 0.12);
      color: #def8f4;
    }
    .choiceDelete .pill {
      border-color: rgba(223, 115, 115, 0.26);
      background: rgba(223, 115, 115, 0.12);
      color: #ffd6d6;
    }
    @media (max-width: 760px) {
      .shell { padding: 14px; }
      .choices { grid-template-columns: 1fr; }
      .heroTitle { font-size: 22px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div class="eyebrow">Captured Frame Ready</div>
      <div class="heroTitle">Choose what to do with the new RenderDoc capture.</div>
      <div class="heroText">The frame was captured successfully. You can save it to a permanent location, inspect the temporary file right away, or delete it now.</div>
    </div>
    <div class="surface">
      <div class="surfaceTitle">Temporary Capture</div>
      <div class="meta mono">${fileName}</div>
      <div class="meta mono">${filePath}</div>
    </div>
    <div class="choices">
      <div class="choice choiceSave" data-action="save">
        <div class="pill">Recommended</div>
        <div class="choiceTitle">Save</div>
        <div class="choiceText">Pick a final path and move this capture there. The file will be tracked by the extension for later cleanup.</div>
      </div>
      <div class="choice choiceOpen" data-action="openTemporary">
        <div class="pill">Temporary</div>
        <div class="choiceTitle">Open Temporary</div>
        <div class="choiceText">Inspect the capture immediately without moving it. It stays in the temporary live-captures location.</div>
      </div>
      <div class="choice choiceDelete" data-action="delete">
        <div class="pill">Remove</div>
        <div class="choiceTitle">Delete</div>
        <div class="choiceText">Discard this capture now and remove the temporary file from disk.</div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.choice').forEach((choice) => {
      choice.addEventListener('click', () => {
        const action = choice.getAttribute('data-action');
        if (action === 'save') {
          vscode.postMessage({ type: 'save' });
        } else if (action === 'openTemporary') {
          vscode.postMessage({ type: 'openTemporary' });
        } else if (action === 'delete') {
          vscode.postMessage({ type: 'delete' });
        }
      });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}