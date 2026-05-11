import * as vscode from 'vscode';
import { CaptureLaunchTarget, LiveCaptureEntry, LiveTargetInfo, ReplayHostInfo } from '../types';

export interface LaunchFormState {
    executable: string;
    workingDir: string;
    cmdLine: string;
}

type LaunchPanelTarget =
    | { kind: 'local' }
    | { kind: 'device'; target?: CaptureLaunchTarget };

type LaunchPanelMessage =
    | { type: 'ready' }
    | { type: 'browseExecutable' }
    | { type: 'browseAndroidPackage'; value: string }
    | { type: 'launch'; form: LaunchFormState }
    | { type: 'attach' }
    | { type: 'capture' }
    | { type: 'disconnect' }
    | { type: 'clearSavedCaptures' }
    | { type: 'openCapture'; captureId: string }
    | { type: 'saveCapture'; captureId: string }
    | { type: 'deleteCapture'; captureId: string };

interface LaunchPanelViewState {
    target: LaunchPanelTarget;
    form: LaunchFormState;
    liveTarget?: LiveTargetInfo;
    recentCaptures: LiveCaptureEntry[];
    replayHost?: ReplayHostInfo;
    statusNote?: string;
    bridgeVersion?: string;
    sessionHint?: string;
}

export class LaunchApplicationPanel {
    public static currentPanel: LaunchApplicationPanel | undefined;
    private static readonly viewType = 'renderdoc-launch-application';

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private state: LaunchPanelViewState;

    public static createOrShow(
        context: vscode.ExtensionContext,
        initialForm: LaunchFormState,
        handlers: {
            onLaunch: (form: LaunchFormState) => Promise<void>;
            onAttach: () => Promise<void>;
            onCapture: () => Promise<void>;
            onDisconnect: () => Promise<void>;
            onBrowseExecutable: () => Promise<string | undefined>;
            onBrowseAndroidPackage: (value: string) => Promise<string | undefined>;
            onOpenCapture: (captureId: string) => Promise<void>;
            onSaveCapture: (captureId: string) => Promise<void>;
            onDeleteCapture: (captureId: string) => Promise<void>;
            onClearSavedCaptures: () => Promise<void>;
        },
    ) {
        const column = vscode.ViewColumn.Beside;
        if (LaunchApplicationPanel.currentPanel) {
            LaunchApplicationPanel.currentPanel.panel.reveal(column, true);
            LaunchApplicationPanel.currentPanel.updateState({ form: initialForm });
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
            onAttach: () => Promise<void>;
            onCapture: () => Promise<void>;
            onDisconnect: () => Promise<void>;
            onBrowseExecutable: () => Promise<string | undefined>;
            onBrowseAndroidPackage: (value: string) => Promise<string | undefined>;
            onOpenCapture: (captureId: string) => Promise<void>;
            onSaveCapture: (captureId: string) => Promise<void>;
            onDeleteCapture: (captureId: string) => Promise<void>;
            onClearSavedCaptures: () => Promise<void>;
        },
    ) {
        this.panel = panel;
        this.state = {
            target: { kind: 'local' },
            form: initialForm,
            recentCaptures: [],
        };

        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message: LaunchPanelMessage) => {
            void this.handleMessage(message);
        }, null, this.disposables);
    }

    public updateState(partial: Partial<LaunchPanelViewState>) {
        this.state = {
            ...this.state,
            ...partial,
            form: partial.form ?? this.state.form,
            recentCaptures: partial.recentCaptures ?? this.state.recentCaptures,
        };
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
                    this.updateState({
                        form: { ...this.state.form, executable: value },
                    });
                }
                break;
            }
            case 'browseAndroidPackage': {
                const value = await this.handlers.onBrowseAndroidPackage(message.value || '');
                if (value !== undefined) {
                    this.updateState({
                        form: { ...this.state.form, executable: value },
                    });
                }
                break;
            }
            case 'launch':
                this.updateState({ form: message.form });
                await this.handlers.onLaunch(message.form);
                break;
            case 'attach':
                await this.handlers.onAttach();
                break;
            case 'capture':
                await this.handlers.onCapture();
                break;
            case 'disconnect':
                await this.handlers.onDisconnect();
                break;
            case 'clearSavedCaptures':
                await this.handlers.onClearSavedCaptures();
                break;
            case 'openCapture':
                await this.handlers.onOpenCapture(message.captureId);
                break;
            case 'saveCapture':
                await this.handlers.onSaveCapture(message.captureId);
                break;
            case 'deleteCapture':
                await this.handlers.onDeleteCapture(message.captureId);
                break;
        }
    }

    private async pushState(): Promise<void> {
        try {
            await this.panel.webview.postMessage({
                type: 'state',
                ...this.state,
            });
        } catch (error: any) {
            console.warn('[RenderDoc] LaunchApplicationPanel pushState failed:', error?.message ?? String(error));
        }
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
      --line: rgba(133, 152, 173, 0.18);
      --line-strong: rgba(112, 208, 198, 0.38);
      --accent: #70d0c6;
      --accent-warm: #c98b52;
      --panel: rgba(24, 31, 41, 0.98);
      --panel-soft: rgba(19, 25, 34, 0.82);
      --text-dim: rgba(234, 240, 245, 0.66);
      --shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 20px;
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
      max-width: 1080px;
      margin: 0 auto;
    }
    .hero,
    .metricCard,
    .section,
    .captureItem,
    .summaryCard,
    .advanced {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(29, 37, 48, 0.98), rgba(17, 23, 30, 0.98));
      box-shadow: var(--shadow);
    }
    .hero,
    .section,
    .advancedBody {
      padding: 18px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 16px;
      align-items: end;
    }
    .eyebrow,
    .sectionTag,
    .metricLabel,
    .summaryLabel,
    .chip {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
    }
    .eyebrow,
    .sectionTag,
    .metricLabel,
    .summaryLabel,
    .sectionText,
    .metricMeta,
    .fieldNote,
    .hint,
    .empty,
    .notice,
    .summaryMeta,
    .meta {
      color: var(--text-dim);
    }
    .heroTitle {
      margin-top: 8px;
      font-size: 26px;
      line-height: 1.08;
      font-weight: 760;
      max-width: 20ch;
    }
    .heroText,
    .sectionText,
    .metricMeta,
    .fieldNote,
    .hint,
    .empty,
    .notice,
    .summaryMeta,
    .meta {
      font-size: 12px;
      line-height: 1.55;
    }
    .heroText {
      margin-top: 10px;
      max-width: 58ch;
    }
    .heroCards,
    .fieldGrid,
    .actionGrid,
    .captureList,
    .summaryGrid,
    .advancedBody {
      display: grid;
      gap: 12px;
    }
    .heroCards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .metricCard,
    .summaryCard,
    .captureItem,
    .statusCard {
      padding: 14px;
      border-radius: 14px;
      background: var(--panel-soft);
    }
    .metricCard,
    .summaryCard,
    .statusCard {
      display: grid;
      gap: 8px;
    }
    .metricValue,
    .summaryValue,
    .sectionTitle,
    .captureTitle {
      font-size: 16px;
      line-height: 1.2;
      font-weight: 700;
      color: #eff4f8;
    }
    .sectionHeader,
    .captureHeader,
    .advancedSummary {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .sectionHeader {
      margin-bottom: 14px;
    }
    .sectionTitle {
      font-size: 17px;
    }
    .fieldGrid {
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
    input {
      width: 100%;
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
      border: 1px solid rgba(112, 208, 198, 0.16);
      background: linear-gradient(180deg, rgba(112, 208, 198, 0.22), rgba(57, 107, 114, 0.18));
      color: #effbf8;
      padding: 0 14px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      transition: transform 160ms ease, border-color 160ms ease, filter 160ms ease, opacity 160ms ease;
    }
    button:hover {
      transform: translateY(-1px);
      filter: brightness(1.04);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
      transform: none;
    }
    button.secondary {
      background: rgba(133, 152, 173, 0.08);
      color: #dce5ed;
      border-color: rgba(133, 152, 173, 0.18);
    }
    button.danger {
      border-color: rgba(211, 123, 123, 0.28);
      background: rgba(211, 123, 123, 0.12);
      color: #ffe5e5;
    }
    .badge,
    .chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid rgba(133, 152, 173, 0.2);
      background: rgba(133, 152, 173, 0.08);
      color: #d8dfe7;
      width: fit-content;
    }
    .badge.live,
    .chip.good {
      background: rgba(112, 208, 198, 0.12);
      border-color: rgba(112, 208, 198, 0.32);
      color: #def8f4;
    }
    .chip.warn {
      background: rgba(201, 139, 82, 0.14);
      border-color: rgba(201, 139, 82, 0.32);
      color: #ffe7ce;
    }
    .statusCard,
    .notice,
    .empty {
      border: 1px solid rgba(133, 152, 173, 0.18);
      border-radius: 14px;
      background: var(--panel-soft);
      padding: 12px 14px;
    }
    .notice {
      border-color: rgba(112, 208, 198, 0.18);
      color: #eff4f8;
      background: rgba(112, 208, 198, 0.08);
    }
    .actionGrid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .captureList {
      gap: 10px;
    }
    .captureMeta,
    .captureActions,
    .summaryChips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .captureActions button,
    .sectionHeader button {
      min-height: 36px;
      font-size: 12px;
    }
    .advanced {
      overflow: hidden;
    }
    .advancedSummary {
      list-style: none;
      cursor: pointer;
      padding: 18px;
    }
    .advancedSummary::-webkit-details-marker {
      display: none;
    }
    .advanced[open] .advancedSummary {
      border-bottom: 1px solid rgba(133, 152, 173, 0.18);
    }
    .hidden {
      display: none;
    }
    @media (max-width: 900px) {
      body {
        padding: 14px;
      }
      .hero {
        grid-template-columns: 1fr;
      }
      .heroCards {
        grid-template-columns: 1fr;
      }
      .field.compact,
      .field.sideAction {
        grid-column: span 12;
      }
      .actionGrid {
        grid-template-columns: 1fr;
      }
      .sectionHeader,
      .captureHeader,
      .advancedSummary {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <div class="hero">
      <div>
        <div class="eyebrow">Launch Application</div>
        <div class="heroTitle">Launch, attach, capture, and manage session files in one place.</div>
        <div class="heroText">Capture Target only decides where commands run. This panel handles launch setup, live session control, session captures, and replay diagnostics.</div>
      </div>
      <div class="heroCards">
        <div class="metricCard">
          <div class="metricLabel">Current Target</div>
          <div id="targetValue" class="metricValue">Local Workspace</div>
          <div id="targetMeta" class="metricMeta">Select Local or a connected device in Capture Target.</div>
        </div>
        <div class="metricCard">
          <div class="metricLabel">Live Session</div>
          <div id="sessionValue" class="metricValue">Not Connected</div>
          <div id="sessionMeta" class="metricMeta">Launch or attach first, then capture when ready.</div>
          <div id="sessionBadge" class="badge">Idle</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="sectionHeader">
        <div>
          <div class="sectionTag">Setup</div>
          <div class="sectionTitle">Launch Setup</div>
          <div class="sectionText">Choose the executable or Android package, then adjust optional startup parameters before launching the target.</div>
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

    <div class="section">
      <div class="sectionHeader">
        <div>
          <div class="sectionTag">Session</div>
          <div class="sectionTitle">Session Controls</div>
          <div class="sectionText">Launch or attach on the selected target, then capture a frame when the live session is ready.</div>
        </div>
      </div>
      <div id="statusArea"></div>
      <div class="actionGrid">
        <button id="launchButton">Launch Target</button>
        <button id="attachButton" class="secondary">Attach To Process</button>
        <button id="captureButton" class="secondary">Capture Frame</button>
        <button id="disconnectButton" class="secondary danger">Disconnect</button>
      </div>
    </div>

    <div class="section">
      <div class="sectionHeader">
        <div>
          <div class="sectionTag">Captures</div>
          <div class="sectionTitle">Current Session Captures</div>
          <div class="sectionText">Open, keep, or delete RDC files captured in this session.</div>
        </div>
        <button id="clearSavedCaptures" class="secondary">Delete Saved Files</button>
      </div>
      <div id="capturesList" class="captureList"></div>
    </div>

    <details class="advanced">
      <summary class="advancedSummary">
        <div>
          <div class="sectionTag">Advanced</div>
          <div class="sectionTitle">Replay and Bridge Status</div>
          <div class="sectionText">Extra diagnostics and replay host information.</div>
        </div>
      </summary>
      <div id="advancedGrid" class="advancedBody"></div>
    </details>
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
      launchButton: document.getElementById('launchButton'),
      attachButton: document.getElementById('attachButton'),
      captureButton: document.getElementById('captureButton'),
      disconnectButton: document.getElementById('disconnectButton'),
      clearSavedCaptures: document.getElementById('clearSavedCaptures'),
      workingDirRow: document.getElementById('workingDirRow'),
      androidRow: document.getElementById('androidRow'),
      statusArea: document.getElementById('statusArea'),
      capturesList: document.getElementById('capturesList'),
      advancedGrid: document.getElementById('advancedGrid'),
    };

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function chip(label, tone) {
      return '<span class="chip' + (tone ? ' ' + tone : '') + '">' + escapeHtml(label) + '</span>';
    }

    function captureActionButton(action, id, label, variant) {
      return '<button type="button" class="' + (variant || '') + '" data-action="' + action + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';
    }

    function collectForm() {
      return {
        executable: el.executable.value.trim(),
        workingDir: el.workingDir.value.trim(),
        cmdLine: el.cmdLine.value,
      };
    }

    function bindCaptureButtons() {
      el.capturesList.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => {
          const type = button.getAttribute('data-action');
          const captureId = button.getAttribute('data-id');
          if (type && captureId) {
            vscode.postMessage({ type, captureId });
          }
        });
      });
    }

    function applyState(payload) {
      const target = payload.target || { kind: 'local' };
      const form = payload.form || {};
      const liveTarget = payload.liveTarget || null;
      const recentCaptures = Array.isArray(payload.recentCaptures) ? payload.recentCaptures : [];
      const replayHost = payload.replayHost || null;
      const statusNote = typeof payload.statusNote === 'string' ? payload.statusNote : '';
      const bridgeVersion = typeof payload.bridgeVersion === 'string' ? payload.bridgeVersion : '';
      const sessionHint = typeof payload.sessionHint === 'string' ? payload.sessionHint : '';

      const isLocal = target.kind === 'local';
      const targetName = isLocal ? 'Local Workspace' : (target.target?.name || target.target?.id || 'Remote Device');
      const targetMeta = isLocal ? 'Launch and attach on this machine.' : (target.target?.url || 'Selected from Capture Target.');
      const androidLike = !isLocal && /adb|android/i.test([target.target?.protocol, target.target?.url, target.target?.id, target.target?.name].join(' '));

      el.targetValue.textContent = targetName;
      el.targetMeta.textContent = targetMeta;
      el.programLabel.textContent = isLocal ? 'Executable Path' : 'Package / Activity';
      el.executable.value = form.executable || '';
      el.workingDir.value = form.workingDir || '';
      el.cmdLine.value = form.cmdLine || '';

      el.browseExecutable.classList.toggle('hidden', !isLocal);
      el.workingDirRow.classList.toggle('hidden', !isLocal);
      el.androidRow.classList.toggle('hidden', !androidLike);

      if (liveTarget) {
        el.sessionValue.textContent = liveTarget.target || 'Connected Target';
        el.sessionMeta.textContent = (liveTarget.local ? 'Local' : (liveTarget.url || 'Remote')) + (liveTarget.api ? ' · ' + liveTarget.api : '');
        el.sessionBadge.textContent = 'Connected';
        el.sessionBadge.className = 'badge live';
      } else {
        el.sessionValue.textContent = 'Not Connected';
        el.sessionMeta.textContent = 'Launch or attach first, then capture when ready.';
        el.sessionBadge.textContent = 'Idle';
        el.sessionBadge.className = 'badge';
      }

      el.captureButton.disabled = !liveTarget;
      el.disconnectButton.disabled = !liveTarget;

      el.statusArea.innerHTML = statusNote
        ? '<div class="notice">' + escapeHtml(statusNote) + '</div>'
        : '<div class="empty">' + escapeHtml(liveTarget
            ? 'Capture Frame grabs a frame from the current live session.'
            : 'Launch or attach first, then Capture Frame becomes available.') + '</div>';

      if (recentCaptures.length) {
        el.capturesList.innerHTML = recentCaptures.map((capture) => {
          const savedChip = capture.saved ? chip('Saved', 'good') : chip('Temporary');
          const apiChip = capture.api ? chip(capture.api, '') : '';
          const frameChip = typeof capture.frameNumber === 'number' ? chip('Frame ' + capture.frameNumber, '') : '';
          const sourceChip = capture.sourceUrl ? chip(capture.sourceUrl, '') : chip('Local', '');
          const saveButton = capture.saved ? '' : captureActionButton('saveCapture', capture.id, 'Save As', 'secondary');
          return '<div class="captureItem">'
            + '<div class="captureHeader">'
            + '<div><div class="captureTitle">' + escapeHtml(capture.displayName) + '</div><div class="meta">' + escapeHtml(capture.filePath) + '</div></div>'
            + '<div class="captureMeta">' + savedChip + apiChip + frameChip + sourceChip + '</div>'
            + '</div>'
            + '<div class="captureActions">'
            + captureActionButton('openCapture', capture.id, 'Open', '')
            + saveButton
            + captureActionButton('deleteCapture', capture.id, 'Delete', 'secondary danger')
            + '</div>'
            + '</div>';
        }).join('');
      } else {
        el.capturesList.innerHTML = '<div class="empty">No capture files yet.</div>';
      }
      bindCaptureButtons();

      const bridgeChip = bridgeVersion ? chip('RenderDoc ' + bridgeVersion, 'good') : chip('RenderDoc version unknown', '');
      const replayCard = replayHost && replayHost.connected
        ? '<div class="summaryCard"><div class="summaryLabel">Replay Host</div><div class="summaryValue">' + escapeHtml(replayHost.url || 'Remote Replay Host') + '</div><div class="summaryChips">' + (replayHost.protocol ? chip(replayHost.protocol, 'good') : '') + '</div><div class="summaryMeta">Replay queries will prefer this host while remote replay is active.</div></div>'
        : '<div class="summaryCard"><div class="summaryLabel">Replay Host</div><div class="summaryValue">Local replay by default</div><div class="summaryMeta">No remote replay host is selected.</div></div>';

      el.advancedGrid.innerHTML = '<div class="summaryGrid">'
        + '<div class="summaryCard"><div class="summaryLabel">Bridge Status</div><div class="summaryValue">RenderDoc integration</div><div class="summaryChips">' + bridgeChip + '</div><div class="summaryMeta">' + escapeHtml(sessionHint || 'Open this section only when you need extra diagnostics.') + '</div></div>'
        + replayCard
        + '</div>';
    }

    el.browseExecutable.addEventListener('click', () => vscode.postMessage({ type: 'browseExecutable' }));
    el.browseAndroidPackage.addEventListener('click', () => vscode.postMessage({ type: 'browseAndroidPackage', value: el.executable.value }));
    el.launchButton.addEventListener('click', () => vscode.postMessage({ type: 'launch', form: collectForm() }));
    el.attachButton.addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
    el.captureButton.addEventListener('click', () => vscode.postMessage({ type: 'capture' }));
    el.disconnectButton.addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
    el.clearSavedCaptures.addEventListener('click', () => vscode.postMessage({ type: 'clearSavedCaptures' }));

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