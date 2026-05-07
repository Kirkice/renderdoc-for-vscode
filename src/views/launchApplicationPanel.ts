import * as vscode from 'vscode';
import { CaptureLaunchTarget, LiveTargetInfo } from '../types';

export interface LaunchFormState {
    executable: string;
    workingDir: string;
    cmdLine: string;
}

type LaunchPanelMessage =
    | { type: 'ready' }
    | { type: 'browseExecutable' }
    | { type: 'browseAndroidPackage'; value: string }
  | { type: 'launch'; form: LaunchFormState }
  | { type: 'capture' };

export class LaunchApplicationPanel {
    public static currentPanel: LaunchApplicationPanel | undefined;
    private static readonly viewType = 'renderdoc-launch-application';

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private currentTarget: { kind: 'local' } | { kind: 'device'; target?: CaptureLaunchTarget } = { kind: 'local' };
    private currentForm: LaunchFormState;
    private liveTarget: LiveTargetInfo | undefined;

    public static createOrShow(
        context: vscode.ExtensionContext,
        initialForm: LaunchFormState,
        handlers: {
            onLaunch: (form: LaunchFormState) => Promise<void>;
          onCapture: () => Promise<void>;
            onBrowseExecutable: () => Promise<string | undefined>;
            onBrowseAndroidPackage: (value: string) => Promise<string | undefined>;
        },
    ) {
        const column = vscode.ViewColumn.Beside;
        if (LaunchApplicationPanel.currentPanel) {
            LaunchApplicationPanel.currentPanel.panel.reveal(column, true);
            LaunchApplicationPanel.currentPanel.setForm(initialForm);
            return LaunchApplicationPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            LaunchApplicationPanel.viewType,
            'Launch Application',
            { viewColumn: column, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true },
        );

        LaunchApplicationPanel.currentPanel = new LaunchApplicationPanel(panel, initialForm, handlers);
        return LaunchApplicationPanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        initialForm: LaunchFormState,
        private readonly handlers: {
            onLaunch: (form: LaunchFormState) => Promise<void>;
          onCapture: () => Promise<void>;
            onBrowseExecutable: () => Promise<string | undefined>;
            onBrowseAndroidPackage: (value: string) => Promise<string | undefined>;
        },
    ) {
        this.panel = panel;
        this.currentForm = initialForm;
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message: LaunchPanelMessage) => {
            void this.handleMessage(message);
        }, null, this.disposables);
    }

    public setTarget(target: { kind: 'local' } | { kind: 'device'; target?: CaptureLaunchTarget }) {
        this.currentTarget = target;
        void this.pushState();
    }

    public setForm(form: LaunchFormState) {
        this.currentForm = form;
        void this.pushState();
    }

    public setLiveTarget(target: LiveTargetInfo | undefined) {
      this.liveTarget = target;
      void this.pushState();
    }

    private async handleMessage(message: LaunchPanelMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.pushState();
                break;
            case 'browseExecutable': {
                const value = await this.handlers.onBrowseExecutable();
                if (value !== undefined) {
                    this.currentForm = { ...this.currentForm, executable: value };
                    await this.pushState();
                }
                break;
            }
            case 'browseAndroidPackage': {
                const value = await this.handlers.onBrowseAndroidPackage(message.value || '');
                if (value !== undefined) {
                    this.currentForm = { ...this.currentForm, executable: value };
                    await this.pushState();
                }
                break;
            }
            case 'launch':
                this.currentForm = message.form;
                await this.handlers.onLaunch(message.form);
                break;
            case 'capture':
              await this.handlers.onCapture();
              break;
        }
    }

    private async pushState(): Promise<void> {
        await this.panel.webview.postMessage({
            type: 'state',
            target: this.currentTarget,
            form: this.currentForm,
            liveTarget: this.liveTarget,
        });
    }

    private getHtml(): string {
        const nonce = String(Date.now());
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
      --bg-2: #202937;
      --card: rgba(22, 29, 38, 0.94);
      --card-strong: rgba(26, 35, 46, 0.98);
      --line: rgba(133, 152, 173, 0.18);
      --line-strong: rgba(112, 208, 198, 0.38);
      --accent: #70d0c6;
      --accent-warm: #c98b52;
      --text-dim: rgba(234, 240, 245, 0.66);
      --shadow: 0 24px 56px rgba(0, 0, 0, 0.3);
    }
    body {
      margin: 0;
      padding: 22px;
      font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
      color: #eff4f8;
      background:
        radial-gradient(circle at top left, rgba(112, 208, 198, 0.14), transparent 28%),
        radial-gradient(circle at right top, rgba(201, 139, 82, 0.12), transparent 24%),
        linear-gradient(180deg, var(--bg-1), var(--bg-0) 58%, #0e1217 100%);
    }
    .layout {
      display: grid;
      gap: 16px;
      max-width: 1040px;
      margin: 0 auto;
    }
    .hero,
    .card,
    .actionBar {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(29, 37, 48, 0.98), rgba(17, 23, 30, 0.98));
      box-shadow: var(--shadow);
    }
    .hero::after,
    .card::after,
    .actionBar::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(135deg, rgba(112, 208, 198, 0.07), transparent 34%, rgba(201, 139, 82, 0.08));
    }
    .hero {
      padding: 18px 20px;
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr);
      gap: 16px;
      align-items: end;
    }
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
    .heroText {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-dim);
      max-width: 58ch;
    }
    .metricGrid {
      display: grid;
      gap: 12px;
    }
    .card {
      padding: 14px;
      display: grid;
      gap: 8px;
    }
    .cardLabel {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--text-dim);
    }
    .cardValue {
      font-size: 17px;
      line-height: 1.2;
      font-weight: 700;
    }
    .cardMeta {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-dim);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid rgba(133, 152, 173, 0.2);
      background: rgba(133, 152, 173, 0.08);
      color: #d8dfe7;
      width: fit-content;
    }
    .badge.live {
      background: rgba(112, 208, 198, 0.12);
      border-color: rgba(112, 208, 198, 0.32);
      color: #def8f4;
    }
    .panel {
      display: grid;
      gap: 14px;
    }
    .section {
      position: relative;
      overflow: hidden;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(24, 31, 41, 0.98), rgba(17, 22, 29, 0.98));
      box-shadow: var(--shadow);
    }
    .section::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(135deg, rgba(112, 208, 198, 0.05), transparent 36%, rgba(201, 139, 82, 0.08));
    }
    .sectionHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .sectionTitle {
      font-size: 16px;
      font-weight: 700;
    }
    .sectionText {
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-dim);
      max-width: 62ch;
    }
    .fieldGrid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }
    .field {
      display: grid;
      gap: 8px;
      grid-column: span 12;
    }
    .field.compact {
      grid-column: span 7;
    }
    .field.sideAction {
      grid-column: span 5;
      align-content: end;
    }
    .field.full {
      grid-column: span 12;
    }
    label {
      font-size: 12px;
      font-weight: 600;
      color: #eef4f8;
    }
    .fieldNote {
      font-size: 11px;
      line-height: 1.45;
      color: var(--text-dim);
    }
    input {
      width: 100%;
      box-sizing: border-box;
      min-height: 42px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(133, 152, 173, 0.18);
      background: rgba(12, 16, 21, 0.6);
      color: #eef4f8;
      outline: none;
      transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
      font-family: inherit;
      font-size: 13px;
    }
    input:focus {
      border-color: rgba(112, 208, 198, 0.42);
      box-shadow: 0 0 0 3px rgba(112, 208, 198, 0.12);
      background: rgba(12, 18, 24, 0.88);
    }
    button {
      min-height: 42px;
      border-radius: 12px;
      border: 1px solid rgba(112, 208, 198, 0.12);
      background: linear-gradient(180deg, rgba(112, 208, 198, 0.22), rgba(57, 107, 114, 0.18));
      color: #effbf8;
      padding: 0 14px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      transition: transform 160ms ease, border-color 160ms ease, filter 160ms ease, opacity 160ms ease;
    }
    button:hover { transform: translateY(-1px); filter: brightness(1.04); }
    button:disabled { opacity: 0.45; cursor: default; transform: none; }
    button.secondary {
      background: rgba(133, 152, 173, 0.08);
      color: #dce5ed;
      border-color: rgba(133, 152, 173, 0.18);
    }
    .actionBar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
    }
    .actionMeta {
      display: grid;
      gap: 4px;
    }
    .actionTitle {
      font-size: 13px;
      font-weight: 700;
    }
    .actionHint {
      font-size: 11px;
      line-height: 1.45;
      color: var(--text-dim);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
    }
    .hint { font-size: 11px; line-height: 1.45; color: var(--text-dim); }
    .hidden { display: none; }
    @media (max-width: 840px) {
      body { padding: 14px; }
      .hero { grid-template-columns: 1fr; }
      .field.compact,
      .field.sideAction { grid-column: span 12; }
      .actionBar {
        align-items: stretch;
        flex-direction: column;
      }
      .actions { justify-content: stretch; }
      .actions button { flex: 1 1 180px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <div class="hero">
      <div>
        <div class="eyebrow">Launch Application</div>
        <div class="heroTitle">Configure the program once, then capture at exactly the right moment.</div>
        <div class="heroText">This panel keeps launch setup, target context, and live session state in one place. Launch starts the process only; capture remains a deliberate action after the target is ready.</div>
      </div>
      <div class="metricGrid">
        <div class="card">
          <div class="cardLabel">Capture Target</div>
          <div id="targetValue" class="cardValue">Local</div>
          <div id="targetMeta" class="cardMeta">Select Local or a connected device in the left sidebar.</div>
        </div>
        <div class="card">
          <div class="cardLabel">Live Session</div>
          <div id="sessionValue" class="cardValue">Not Connected</div>
          <div id="sessionMeta" class="cardMeta">Launch or attach first, then capture when ready.</div>
          <div id="sessionBadge" class="badge">Idle</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="section">
        <div class="sectionHeader">
          <div>
            <div class="sectionTitle">Launch Setup</div>
            <div class="sectionText">Set the executable or Android package, then adjust optional launch parameters before starting the target.</div>
          </div>
        </div>

        <div class="fieldGrid">
          <div class="field compact">
            <label id="programLabel" for="executable">Executable Path</label>
            <input id="executable" type="text" />
          </div>
          <div class="field sideAction">
            <label>&nbsp;</label>
            <button id="browseExecutable">Browse…</button>
          </div>

          <div class="field full hidden" id="androidRow">
            <label>Android Package Tools</label>
            <div class="fieldGrid">
              <div class="field compact">
                <div class="fieldNote">Browse installed packages through adb, then populate the launch target automatically.</div>
              </div>
              <div class="field sideAction">
                <button id="browseAndroidPackage" class="secondary">Browse Packages</button>
              </div>
            </div>
          </div>

          <div class="field full" id="workingDirRow">
            <label for="workingDir">Working Directory</label>
            <input id="workingDir" type="text" />
            <div class="fieldNote">Used for desktop launches only. Leave empty when the executable already resolves assets and dependencies correctly.</div>
          </div>

          <div class="field full">
            <label for="cmdLine">Command-Line Arguments</label>
            <input id="cmdLine" type="text" />
            <div class="fieldNote">Pass runtime flags, scene selectors, debug switches, or any startup parameters your program expects.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="actionBar">
      <div class="actionMeta">
        <div class="actionTitle">Live capture workflow</div>
        <div class="actionHint">Launch starts the application or package only. Capture becomes available after the live target connects.</div>
      </div>
      <div class="actions">
        <button id="captureButton" class="secondary">Capture Frame</button>
        <button id="launchButton">Launch Target</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = {
      targetValue: document.getElementById('targetValue'),
      targetMeta: document.getElementById('targetMeta'),
      sessionValue: document.getElementById('sessionValue'),
      sessionMeta: document.getElementById('sessionMeta'),
      sessionBadge: document.getElementById('sessionBadge'),
      programLabel: document.getElementById('programLabel'),
      executable: document.getElementById('executable'),
      workingDir: document.getElementById('workingDir'),
      cmdLine: document.getElementById('cmdLine'),
      browseExecutable: document.getElementById('browseExecutable'),
      browseAndroidPackage: document.getElementById('browseAndroidPackage'),
      captureButton: document.getElementById('captureButton'),
      launchButton: document.getElementById('launchButton'),
      workingDirRow: document.getElementById('workingDirRow'),
      androidRow: document.getElementById('androidRow'),
    };
    let currentTarget = { kind: 'local' };

    function applyState(payload) {
      currentTarget = payload.target || { kind: 'local' };
      const form = payload.form || {};
      const liveTarget = payload.liveTarget || null;
      const isLocal = currentTarget.kind === 'local';
      const targetName = isLocal ? 'Local' : (currentTarget.target?.name || currentTarget.target?.id || 'Remote Device');
      const targetMeta = isLocal ? 'Launch on this machine.' : (currentTarget.target?.url || 'Selected from the left sidebar.');
      const androidLike = !isLocal && /adb|android/i.test([currentTarget.target?.protocol, currentTarget.target?.url, currentTarget.target?.id, currentTarget.target?.name].join(' '));

      el.targetValue.textContent = targetName;
      el.targetMeta.textContent = targetMeta;
      el.programLabel.textContent = isLocal ? 'Executable Path' : 'Package / Activity';
      el.executable.value = form.executable || '';
      el.workingDir.value = form.workingDir || '';
      el.cmdLine.value = form.cmdLine || '';

      if (liveTarget) {
        el.sessionValue.textContent = liveTarget.target || 'Connected Target';
        el.sessionMeta.textContent = (liveTarget.local ? 'Local' : (liveTarget.url || 'Remote')) + (liveTarget.api ? ' · ' + liveTarget.api : '');
        el.sessionBadge.textContent = 'Connected';
        el.sessionBadge.className = 'badge live';
        el.captureButton.disabled = false;
      } else {
        el.sessionValue.textContent = 'Not Connected';
        el.sessionMeta.textContent = 'Launch or attach first, then capture when ready.';
        el.sessionBadge.textContent = 'Idle';
        el.sessionBadge.className = 'badge';
        el.captureButton.disabled = true;
      }

      el.browseExecutable.classList.toggle('hidden', !isLocal);
      el.workingDirRow.classList.toggle('hidden', !isLocal);
      el.androidRow.classList.toggle('hidden', !androidLike);
    }

    function collectForm() {
      return {
        executable: el.executable.value.trim(),
        workingDir: el.workingDir.value.trim(),
        cmdLine: el.cmdLine.value,
      };
    }

    el.browseExecutable.addEventListener('click', () => vscode.postMessage({ type: 'browseExecutable' }));
    el.browseAndroidPackage.addEventListener('click', () => vscode.postMessage({ type: 'browseAndroidPackage', value: el.executable.value }));
    el.captureButton.addEventListener('click', () => vscode.postMessage({ type: 'capture' }));
    el.launchButton.addEventListener('click', () => vscode.postMessage({ type: 'launch', form: collectForm() }));
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'state') {
        applyState(event.data);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }

    private dispose() {
        LaunchApplicationPanel.currentPanel = undefined;
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            disposable?.dispose();
        }
    }
}