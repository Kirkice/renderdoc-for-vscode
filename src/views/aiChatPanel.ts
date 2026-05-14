import * as vscode from 'vscode';
import { RenderDocAiService, type RenderDocAiStatus } from '../ai/chatService';
import type { ExternalAiConversationMessage } from '../ai/modelRuntime';

type AiChatPanelInboundMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'sendPrompt'; prompt: string }
    | { type: 'setActiveProfile'; profileId: string }
    | { type: 'configureProvider' }
    | { type: 'setApiKey' }
    | { type: 'clearApiKey' }
    | { type: 'openSettings' }
    | { type: 'openCapture' }
    | { type: 'clearConversation' };

interface AiChatPanelMessage {
    role: 'user' | 'assistant';
    content: string;
    error?: boolean;
    pending?: boolean;
}

interface AiChatPanelState {
    status: RenderDocAiStatus;
    busy: boolean;
    statusText: string;
    messages: AiChatPanelMessage[];
}

export class AiChatPanel {
    public static currentPanel: AiChatPanel | undefined;
    private static readonly viewType = 'renderdoc-ai-chat';

    private readonly panel: vscode.WebviewPanel;
    private readonly aiService: RenderDocAiService;
    private messages: AiChatPanelMessage[] = [];
    private busy = false;
    private statusText = '';
    private initializing?: Promise<void>;
    private initialized = false;

    public static createOrShow(context: vscode.ExtensionContext, aiService: RenderDocAiService): AiChatPanel {
        const column = vscode.ViewColumn.Beside;
        if (AiChatPanel.currentPanel) {
            AiChatPanel.currentPanel.panel.reveal(column, true);
            void AiChatPanel.currentPanel.refresh();
            return AiChatPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            AiChatPanel.viewType,
            'RenderDoc AI',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        AiChatPanel.currentPanel = new AiChatPanel(panel, aiService);
        void AiChatPanel.currentPanel.refresh();
        return AiChatPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, aiService: RenderDocAiService) {
        this.panel = panel;
        this.aiService = aiService;

        this.panel.webview.onDidReceiveMessage((message: AiChatPanelInboundMessage) => {
            void this.handleMessage(message);
        });

        this.panel.onDidDispose(() => {
            if (AiChatPanel.currentPanel === this) {
                AiChatPanel.currentPanel = undefined;
            }
        });
    }

    public async refresh(): Promise<void> {
        await this.ensureInitialized();
        await this.pushState();
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return;
        }
        if (!this.initializing) {
            this.initializing = (async () => {
                const initialState = await this.buildState();
                this.panel.webview.html = this.getHtml(initialState);
                this.initialized = true;
            })();
        }
        await this.initializing;
    }

    private async handleMessage(message: AiChatPanelInboundMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
            case 'refresh':
                await this.pushState();
                break;
            case 'setActiveProfile':
                await this.aiService.setActiveProfile(message.profileId);
                await this.pushState();
                break;
            case 'configureProvider':
                await this.aiService.configureProvider();
                await this.pushState();
                break;
            case 'setApiKey':
                await this.aiService.setApiKey();
                await this.pushState();
                break;
            case 'clearApiKey':
                await this.aiService.clearApiKey();
                await this.pushState();
                break;
            case 'openSettings':
                await this.aiService.openSettings();
                break;
            case 'openCapture':
                await vscode.commands.executeCommand('renderdoc.openCapture');
                await this.pushState();
                break;
            case 'clearConversation':
                this.messages = [];
                this.statusText = '';
                await this.pushState();
                break;
            case 'sendPrompt':
                await this.sendPrompt(message.prompt);
                break;
        }
    }

    private getConversationHistory(): ExternalAiConversationMessage[] {
        return this.messages
            .filter((message) => !message.pending && !message.error)
            .map((message) => ({
                role: message.role,
                content: message.content,
            }));
    }

    private async sendPrompt(prompt: string): Promise<void> {
        const trimmedPrompt = prompt.trim();
        if (!trimmedPrompt || this.busy) {
            return;
        }

        const history = this.getConversationHistory();
        this.messages.push({ role: 'user', content: trimmedPrompt });

        const assistantMessage: AiChatPanelMessage = {
            role: 'assistant',
            content: '',
            pending: true,
        };
        this.messages.push(assistantMessage);

        this.busy = true;
        this.statusText = 'Waiting for the model response…';
        await this.pushState();

        try {
            const reply = await this.aiService.sendMessage(history, trimmedPrompt, (event) => {
                this.statusText = event.message;
                void this.pushState();
            });
            assistantMessage.content = reply || 'No response returned by the model.';
            assistantMessage.pending = false;
        } catch (error: any) {
            assistantMessage.content = `Error: ${error?.message || String(error)}`;
            assistantMessage.pending = false;
            assistantMessage.error = true;
        } finally {
            this.busy = false;
            this.statusText = '';
            await this.pushState();
        }
    }

    private async buildState(): Promise<AiChatPanelState> {
        return {
            status: await this.aiService.getStatus(),
            busy: this.busy,
            statusText: this.statusText,
            messages: this.messages,
        };
    }

    private async pushState(): Promise<void> {
        const state = await this.buildState();

        try {
            await this.panel.webview.postMessage({ type: 'state', state });
        } catch {
            // Ignore postMessage failures if the panel is already disposed.
        }
    }

    private getHtml(initialState: AiChatPanelState): string {
        const nonce = String(Date.now());
        const initialStateJson = JSON.stringify(initialState)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            color-scheme: var(--vscode-color-scheme, dark);
            --surface-0: var(--vscode-editor-background);
            --surface-1: color-mix(in srgb, var(--vscode-sideBar-background) 76%, var(--vscode-editor-background));
            --surface-2: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, var(--vscode-editor-background));
            --surface-3: color-mix(in srgb, var(--vscode-editor-background) 92%, white 8%);
            --border: color-mix(in srgb, var(--vscode-panel-border, #3f3f46) 64%, transparent);
            --separator: color-mix(in srgb, var(--vscode-panel-border, #3f3f46) 36%, transparent);
            --border-strong: var(--vscode-focusBorder, #6aa6ff);
            --text: var(--vscode-foreground);
            --text-muted: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background, #0e639c);
            --accent-foreground: var(--vscode-button-foreground, #ffffff);
            --badge: color-mix(in srgb, var(--vscode-editorInfo-foreground, #4fc1ff) 16%, transparent);
            --warning: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 16%, transparent);
            --error: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 16%, transparent);
        }
        * { box-sizing: border-box; }
        html, body {
            height: 100%;
        }
        body {
            margin: 0;
            font-family: var(--vscode-font-family, "Segoe UI Variable Text", "Segoe UI", sans-serif);
            color: var(--text);
            background: var(--surface-0);
        }
        .app {
            height: 100%;
            display: flex;
            flex-direction: column;
            background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 82%, transparent), var(--surface-0) 14%);
        }
        .header {
            padding: 10px 22px;
            display: flex;
            align-items: center;
            border-bottom: 1px solid var(--border);
            background: color-mix(in srgb, var(--surface-1) 74%, transparent);
        }
        .headerTitle {
            font-size: 13px;
            line-height: 1;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--text);
        }
        .thread {
            flex: 1;
            overflow: auto;
            padding: 10px 22px 18px;
        }
        .threadInner {
            max-width: 760px;
            margin: 0 auto;
            display: grid;
            gap: 0;
        }
        .statusBanner {
            display: none;
            align-items: center;
            gap: 8px;
            min-height: 38px;
            padding: 10px 12px;
            border-radius: 12px;
            border: 1px solid var(--border);
            background: color-mix(in srgb, var(--surface-2) 92%, transparent);
            color: var(--text-muted);
            font-size: 12px;
            line-height: 1.45;
        }
        .statusBanner.visible {
            display: flex;
        }
        .statusBanner.warning {
            background: var(--warning);
        }
        .statusBanner.busy {
            background: var(--badge);
        }
        .button,
        .ghostButton,
        .select {
            min-height: 32px;
            padding: 0 14px;
            border-radius: 9px;
            border: 1px solid var(--border);
            font: inherit;
            cursor: pointer;
            transition: border-color 120ms ease, background 120ms ease;
        }
        .select {
            min-width: 240px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground, var(--text));
        }
        .button {
            background: color-mix(in srgb, var(--surface-2) 88%, transparent);
            color: var(--text);
        }
        .button.primary {
            border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
            background: color-mix(in srgb, var(--accent) 18%, transparent);
            color: var(--text);
        }
        .button:hover,
        .ghostButton:hover,
        .select:hover {
            border-color: var(--border-strong);
        }
        .ghostButton {
            background: transparent;
            color: var(--text-muted);
        }
        .button:disabled,
        .ghostButton:disabled,
        .select:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }
        .messageRow {
            display: grid;
            gap: 8px;
            padding: 16px 0;
            border-top: 1px solid var(--separator);
        }
        .messageRow:first-child {
            border-top: 0;
        }
        .messageMeta {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            font-size: 11px;
            line-height: 1;
            color: var(--text-muted);
        }
        .roleBadge {
            display: inline-flex;
            align-items: center;
            min-height: 22px;
            padding: 0 8px;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: color-mix(in srgb, var(--surface-2) 88%, transparent);
            color: var(--text);
            font-weight: 600;
        }
        .messageRow.user .roleBadge {
            background: color-mix(in srgb, var(--accent) 16%, transparent);
        }
        .messageRow.error .roleBadge {
            background: var(--error);
        }
        .messageLabel {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .messageStatus {
            color: var(--text-muted);
        }
        .messageBody {
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.6;
            font-size: 13px;
            color: var(--text);
        }
        .composerShell {
            padding: 16px 22px 20px;
            border-top: 1px solid var(--border);
            background: color-mix(in srgb, var(--surface-1) 88%, transparent);
        }
        .contextBar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 0;
            padding: 0 2px;
            width: 100%;
        }
        .attachment {
            min-width: 0;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            min-height: 22px;
            padding: 0 8px;
            border-radius: 999px;
            border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
            background: color-mix(in srgb, var(--surface-2) 60%, transparent);
            max-width: 100%;
        }
        .attachment.empty {
            opacity: 0.72;
        }
        .attachmentLabel {
            display: inline-flex;
            align-items: center;
            flex-shrink: 0;
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            color: var(--text-muted);
            line-height: 1;
            white-space: nowrap;
        }
        .attachmentValue {
            min-width: 0;
            font-size: 10px;
            line-height: 1;
            color: var(--text);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: min(150px, 20vw);
        }
        .composer {
            display: grid;
            width: min(100%, 760px);
            gap: 8px;
            margin: 0 auto;
        }
        .composerFrame {
            display: grid;
            gap: 5px;
            padding: 6px 10px 6px;
            border-radius: 12px;
            border: 1px solid color-mix(in srgb, var(--border-strong) 42%, var(--border));
            background: color-mix(in srgb, var(--surface-2) 88%, var(--surface-0));
        }
        .composerFrame:focus-within {
            border-color: var(--border-strong);
            box-shadow:
                0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
        }
        textarea {
            display: block;
            width: 100%;
            min-height: 22px;
            max-height: 144px;
            resize: none;
            overflow-y: hidden;
            padding: 2px 8px 1px;
            border-radius: 10px;
            border: 0;
            background: transparent;
            color: var(--vscode-input-foreground, var(--text));
            font: inherit;
            line-height: 1.4;
        }
        textarea:focus {
            outline: none;
        }
        .select:focus {
            outline: 1px solid var(--border-strong);
            outline-offset: 1px;
        }
        .composerFooter {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            flex-wrap: nowrap;
            padding: 0 2px 0 1px;
        }
        .footerLeft,
        .footerRight {
            display: flex;
            flex-wrap: nowrap;
            gap: 6px;
            align-items: center;
        }
        .footerLeft {
            min-width: 0;
            flex: 1 1 auto;
        }
        .footerRight {
            justify-content: flex-end;
            min-width: 0;
            flex: 0 0 auto;
        }
        .modelButton {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 280px;
            min-height: 24px;
            padding: 0 16px 0 0;
            border: 0;
            border-radius: 0;
            background: transparent;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23979db3' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 0 center;
            background-size: 12px 12px;
            color: var(--text);
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .modelButton:hover {
            background-color: transparent;
            color: var(--text);
        }
        .modelButton:focus {
            outline: none;
            color: var(--text);
        }
        .compactGhost {
            min-height: 24px;
            padding: 0 4px;
            border: 0;
            border-radius: 0;
            font-size: 12px;
        }
        .composerHint {
            font-size: 12px;
            color: var(--text-muted);
            line-height: 1.5;
            min-height: 18px;
            padding-left: 2px;
        }
        .sendButton {
            min-width: 28px;
            min-height: 28px;
            padding: 0;
            border-radius: 8px;
            font-size: 14px;
            line-height: 1;
        }
        @media (max-width: 760px) {
            .header,
            .thread,
            .composerShell {
                padding-left: 14px;
                padding-right: 14px;
            }
            .composerFooter,
            .footerRight {
                align-items: stretch;
            }
            .composerFooter {
                flex-direction: column;
                flex-wrap: wrap;
            }
            .footerLeft,
            .footerRight {
                flex-wrap: wrap;
            }
            .footerRight {
                justify-content: stretch;
            }
            .modelButton {
                min-width: 0;
                max-width: none;
                width: 100%;
            }
            .attachmentValue {
                max-width: calc(100vw - 108px);
            }
        }
    </style>
</head>
<body>
    <div class="app">
        <div class="header">
            <div class="headerTitle">RenderDoc AI</div>
        </div>

        <div class="thread" id="conversation"></div>

        <div class="composerShell">
            <div class="composer">
                <div class="composerFrame">
                    <div class="contextBar" id="contextAttachments"></div>
                    <textarea id="promptInput" rows="1" placeholder="Ask about the current frame, draw, pipeline state, resources, or shader behavior..."></textarea>
                    <div class="composerFooter">
                        <div class="footerLeft">
                            <button class="ghostButton modelButton" id="modelButton" title="Select model" aria-label="Select model"></button>
                            <button class="ghostButton compactGhost" id="clearConversationButton">Clear</button>
                        </div>
                        <div class="footerRight">
                            <button class="button primary sendButton" id="sendButton" title="Send" aria-label="Send">&#8593;</button>
                        </div>
                    </div>
                </div>
                <div class="composerHint" id="composerHint">Enter to send. Shift+Enter for a newline.</div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const MIN_PROMPT_HEIGHT = 22;
        const MAX_PROMPT_HEIGHT = 144;
        let state = ${initialStateJson};

        const composerHint = document.getElementById('composerHint');
        const conversation = document.getElementById('conversation');
        const contextAttachments = document.getElementById('contextAttachments');
    const modelButton = document.getElementById('modelButton');
        const promptInput = document.getElementById('promptInput');
        const sendButton = document.getElementById('sendButton');
        const clearConversationButton = document.getElementById('clearConversationButton');

        function post(type, payload = {}) {
            vscode.postMessage({ type, ...payload });
        }

        function resizePromptInput() {
            promptInput.style.height = 'auto';
            const nextHeight = Math.max(MIN_PROMPT_HEIGHT, Math.min(promptInput.scrollHeight, MAX_PROMPT_HEIGHT));
            promptInput.style.height = nextHeight + 'px';
            promptInput.style.overflowY = promptInput.scrollHeight > MAX_PROMPT_HEIGHT ? 'auto' : 'hidden';
        }

        function truncateMiddle(value, maxLength = 40) {
            if (!value || value.length <= maxLength) {
                return value;
            }
            const visible = Math.max(8, maxLength - 1);
            const head = Math.ceil(visible * 0.6);
            const tail = Math.max(6, visible - head);
            return value.slice(0, head) + '…' + value.slice(-tail);
        }

        function createAttachment(label, value, detail, isEmpty) {
            const attachment = document.createElement('span');
            attachment.className = 'attachment' + (isEmpty ? ' empty' : '');
            attachment.title = detail ? (label + ': ' + value + '\n' + detail) : (label + ': ' + value);

            const attachmentLabel = document.createElement('span');
            attachmentLabel.className = 'attachmentLabel';
            attachmentLabel.textContent = label;
            attachment.appendChild(attachmentLabel);

            const attachmentValue = document.createElement('span');
            attachmentValue.className = 'attachmentValue';
            attachmentValue.textContent = truncateMiddle(String(value || ''), 38);
            attachment.appendChild(attachmentValue);

            return attachment;
        }

        function renderModelButton() {
            const profiles = Array.isArray(state.status.availableProfiles) ? state.status.availableProfiles : [];
            const activeProfile = profiles.find((profile) => profile.id === state.status.activeProfileId);
            const buttonLabel = activeProfile?.model || state.status.model || state.status.activeProfileLabel || 'Select model';
            modelButton.textContent = truncateMiddle(buttonLabel, 42);
            modelButton.title = buttonLabel;
        }

        function submitPrompt() {
            if (state.busy) {
                return;
            }
            const prompt = promptInput.value.trim();
            if (!prompt) {
                return;
            }
            promptInput.value = '';
            resizePromptInput();
            renderState();
            post('sendPrompt', { prompt });
        }

        function createMessageElement(message) {
            const wrapper = document.createElement('div');
            wrapper.className = 'messageRow ' + message.role + (message.error ? ' error' : '');

            const meta = document.createElement('div');
            meta.className = 'messageMeta';

            const badge = document.createElement('div');
            badge.className = 'roleBadge';
            badge.textContent = message.role === 'user' ? 'You' : (message.error ? 'Error' : 'RenderDoc AI');
            meta.appendChild(badge);

            const label = document.createElement('div');
            label.className = 'messageLabel';
            label.textContent = message.role === 'user'
                ? 'Prompt'
                : (message.pending ? 'Working with the active capture…' : 'Response');
            meta.appendChild(label);

            if (message.pending) {
                const status = document.createElement('div');
                status.className = 'messageStatus';
                status.textContent = state.statusText || 'Waiting for the model response…';
                meta.appendChild(status);
            }

            wrapper.appendChild(meta);

            const body = document.createElement('div');
            body.className = 'messageBody';
            body.textContent = message.pending ? (state.statusText || 'Waiting for the model response…') : (message.content || '');
            wrapper.appendChild(body);
            return wrapper;
        }

        function renderConversation() {
            conversation.innerHTML = '';
            if (!state.messages.length) {
                return;
            }

            const threadInner = document.createElement('div');
            threadInner.className = 'threadInner';

            for (const message of state.messages) {
                threadInner.appendChild(createMessageElement(message));
            }
            conversation.appendChild(threadInner);
            conversation.scrollTop = conversation.scrollHeight;
        }

        function renderAttachments() {
            const context = state.status.context || {};
            const capture = context.capture;
            const draw = context.selectedDrawCall;
            const resource = context.selectedResource;
            const drawValue = draw
                ? ((typeof draw.eventId === 'number' ? 'EID ' + draw.eventId + ' ' : '') + draw.label)
                : 'No draw';
            const resourceDetail = resource
                ? [resource.resourceType, resource.resourceId].filter(Boolean).join(' · ')
                : '';

            contextAttachments.innerHTML = '';
            contextAttachments.appendChild(createAttachment('Capture', capture ? capture.label : 'None', capture ? capture.path : 'Open a capture to enable replay-backed analysis.', !capture));
            contextAttachments.appendChild(createAttachment('Draw', drawValue, draw ? 'Inspector selection is used as chat context.' : 'Pick a draw call to attach event context.', !draw));
            contextAttachments.appendChild(createAttachment('Resource', resource ? resource.label : 'None', resource ? resourceDetail : 'Choose a resource to expose it to the model.', !resource));
        }

        function renderState() {
            renderModelButton();
            renderAttachments();

            const canEdit = !state.busy;
            const hasProfiles = Array.isArray(state.status.availableProfiles) && state.status.availableProfiles.length > 0;
            const canSend = canEdit && hasProfiles;
            promptInput.disabled = !canEdit;
            promptInput.placeholder = state.status.ready
                ? 'Ask about the current frame, draw, pipeline state, resources, or shader behavior...'
                : ((state.status.missingReason || 'Configure an AI profile to start.') + ' You can still draft your prompt here.');
            resizePromptInput();
            const hintText = state.busy
                ? (state.statusText || 'Waiting for the model response…')
                : (!state.status.ready
                    ? (state.status.missingReason || 'Configure an AI profile to start.')
                    : '');
            composerHint.textContent = hintText;
            composerHint.style.visibility = hintText ? 'visible' : 'hidden';
            sendButton.disabled = !canSend || !promptInput.value.trim();
            modelButton.disabled = state.busy || !hasProfiles;
            clearConversationButton.disabled = state.busy || state.messages.length === 0;

            renderConversation();
        }

        sendButton.addEventListener('click', () => {
            submitPrompt();
        });

        promptInput.addEventListener('input', () => {
            resizePromptInput();
            renderState();
        });

        promptInput.addEventListener('keydown', (event) => {
            if ((event.isComposing || event.keyCode === 229)) {
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitPrompt();
            }
        });

        modelButton.addEventListener('click', () => post('configureProvider'));
        clearConversationButton.addEventListener('click', () => post('clearConversation'));

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message?.type === 'state') {
                state = message.state;
                renderState();
            }
        });

        renderState();
        post('ready');
    </script>
</body>
</html>`;
    }
}