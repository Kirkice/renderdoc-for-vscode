import * as vscode from 'vscode';
import { DrawCall } from '../types';

type EventBrowserMessage =
    | { type: 'ready' }
    | { type: 'activateEvent'; eventId: number }
    | { type: 'openShaderSource'; eventId: number }
    | { type: 'openPipelineState'; eventId: number };

function generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let index = 0; index < 32; index += 1) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

function findDrawCallByEventId(eventId: number, drawCalls: DrawCall[]): DrawCall | undefined {
    for (const drawCall of drawCalls) {
        if (drawCall.eventId === eventId) {
            return drawCall;
        }
        if (drawCall.children?.length) {
            const found = findDrawCallByEventId(eventId, drawCall.children);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

export class EventBrowserViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private drawCalls: DrawCall[] = [];
    private selectedEventId: number | undefined;

    constructor(
        private readonly onActivateEvent: (drawCall: DrawCall) => Promise<void>,
        private readonly onOpenShaderSource: (drawCall: DrawCall) => Promise<void>,
        private readonly onOpenPipelineState: (drawCall: DrawCall) => Promise<void>,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage((message: EventBrowserMessage) => {
            void this.handleMessage(message);
        });
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });
        void this.pushState();
    }

    update(drawCalls: DrawCall[]): void {
        this.drawCalls = drawCalls;
        if (this.selectedEventId !== undefined && !findDrawCallByEventId(this.selectedEventId, drawCalls)) {
            this.selectedEventId = undefined;
        }
        void this.pushState();
    }

    setSelectedEvent(eventId: number | undefined): void {
        this.selectedEventId = eventId;
        void this.pushState();
    }

    private async handleMessage(message: EventBrowserMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.pushState();
                break;
            case 'activateEvent': {
                const drawCall = findDrawCallByEventId(message.eventId, this.drawCalls);
                if (!drawCall) {
                    return;
                }
                this.selectedEventId = drawCall.eventId;
                await this.onActivateEvent(drawCall);
                await this.pushState();
                break;
            }
            case 'openShaderSource': {
                const drawCall = findDrawCallByEventId(message.eventId, this.drawCalls);
                if (!drawCall) {
                    return;
                }
                this.selectedEventId = drawCall.eventId;
                await this.onOpenShaderSource(drawCall);
                await this.pushState();
                break;
            }
            case 'openPipelineState': {
                const drawCall = findDrawCallByEventId(message.eventId, this.drawCalls);
                if (!drawCall) {
                    return;
                }
                this.selectedEventId = drawCall.eventId;
                await this.onOpenPipelineState(drawCall);
                await this.pushState();
                break;
            }
        }
    }

    private async pushState(): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }

        try {
            await view.webview.postMessage({
                type: 'state',
                drawCalls: this.drawCalls,
                selectedEventId: this.selectedEventId,
            });
        } catch (error: any) {
            if (this.view === view) {
                this.view = undefined;
            }
            console.warn('[RenderDoc] EventBrowserViewProvider pushState failed:', error?.message ?? String(error));
        }
    }

    private getHtml(): string {
        const nonce = generateNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            color-scheme: dark;
        }
        * {
            box-sizing: border-box;
        }
        html, body {
            margin: 0;
            padding: 0;
            height: 100%;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
        }
        .shell {
            height: 100%;
            display: grid;
            grid-template-rows: auto auto minmax(0, 1fr);
            gap: 8px;
            padding: 8px;
        }
        .searchCard,
        .summary,
        .empty,
        .row {
            border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            background: color-mix(in srgb, var(--vscode-sideBar-background) 84%, var(--vscode-editor-background));
            border-radius: 10px;
        }
        .searchCard {
            position: sticky;
            top: 0;
            z-index: 5;
            display: grid;
            gap: 8px;
            padding: 8px;
        }
        .searchTitle {
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }
        .searchRow {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 8px;
        }
        .searchInput {
            width: 100%;
            min-width: 0;
            min-height: 32px;
            padding: 0 10px;
            border-radius: 8px;
            border: 1px solid var(--vscode-input-border, transparent);
            outline: none;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        .searchInput:focus {
            border-color: var(--vscode-focusBorder);
        }
        .clearButton,
        .actionButton,
        .toggleButton {
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 8px;
            background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
            cursor: pointer;
            font: inherit;
        }
        .clearButton {
            min-width: 56px;
            padding: 0 10px;
        }
        .clearButton:hover,
        .actionButton:hover,
        .toggleButton:hover {
            filter: brightness(1.08);
        }
        .summary,
        .empty {
            padding: 8px 10px;
            font-size: 11px;
            line-height: 1.4;
            color: var(--vscode-descriptionForeground);
        }
        .summary strong,
        .empty strong {
            color: var(--vscode-foreground);
        }
        .list {
            min-height: 0;
            overflow-y: auto;
            display: grid;
            gap: 4px;
            padding-bottom: 10px;
        }
        .row {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto;
            align-items: center;
            gap: 8px;
            min-height: 34px;
            padding: 4px 6px;
            cursor: pointer;
        }
        .row:hover {
            border-color: color-mix(in srgb, var(--vscode-focusBorder) 40%, transparent);
            background: color-mix(in srgb, var(--vscode-list-hoverBackground) 85%, transparent);
        }
        .row.selected {
            border-color: color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .prefix {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .toggleButton {
            width: 22px;
            height: 22px;
            padding: 0;
            background: transparent;
            color: inherit;
        }
        .toggleButton.hidden {
            visibility: hidden;
        }
        .flagDot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            flex: 0 0 auto;
            background: var(--vscode-descriptionForeground);
        }
        .labelWrap {
            min-width: 0;
            display: grid;
            gap: 2px;
        }
        .label {
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 12px;
        }
        .label mark {
            padding: 0 1px;
            border-radius: 3px;
            background: color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground) 90%, transparent);
            color: inherit;
        }
        .meta {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .row.selected .meta {
            color: inherit;
            opacity: 0.8;
        }
        .actions {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
        }
        .row:hover .actions,
        .row.selected .actions {
            opacity: 1;
            pointer-events: auto;
        }
        .actionButton {
            min-height: 24px;
            padding: 0 8px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
    </style>
</head>
<body>
    <div class="shell">
        <div class="searchCard">
            <div class="searchTitle">Event Browser Search</div>
            <div class="searchRow">
                <input id="searchInput" class="searchInput" type="text" placeholder="Search by event name, EID, or draw index" />
                <button id="clearButton" class="clearButton" type="button">Clear</button>
            </div>
        </div>
        <div id="summary" class="summary"></div>
        <div id="list" class="list"></div>
    </div>
    <script id="initial-state" type="application/json">${safeJson({ drawCalls: [], selectedEventId: undefined })}</script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const initialState = JSON.parse(document.getElementById('initial-state').textContent || '{}');
        const searchInput = document.getElementById('searchInput');
        const clearButton = document.getElementById('clearButton');
        const summary = document.getElementById('summary');
        const list = document.getElementById('list');
        const expandedEventIds = new Set();
        let drawCalls = Array.isArray(initialState.drawCalls) ? initialState.drawCalls : [];
        let selectedEventId = typeof initialState.selectedEventId === 'number' ? initialState.selectedEventId : undefined;
        let filterText = '';

        function normalizeText(value) {
            return String(value || '').trim().toLowerCase();
        }

        function formatDuration(us) {
            if (typeof us !== 'number') {
                return '';
            }
            if (us >= 1000000) {
                return (us / 1000000).toFixed(2) + ' s';
            }
            if (us >= 1000) {
                return (us / 1000).toFixed(2) + ' ms';
            }
            return us.toFixed(1) + ' µs';
        }

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function escapeRegex(value) {
            return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
        }

        function flagColor(flag) {
            switch (flag) {
                case 'Drawcall': return '#64c896';
                case 'Dispatch': return '#66a8ff';
                case 'Clear': return '#d9c55d';
                case 'Copy':
                case 'Resolve':
                case 'GenMips': return '#d89b58';
                case 'Present':
                case 'PassBoundary':
                case 'Marker': return '#b38df6';
                default: return 'var(--vscode-descriptionForeground)';
            }
        }

        function getRowLabel(drawCall) {
            return drawCall.children && drawCall.children.length > 0
                ? drawCall.eventId + '  ' + drawCall.name
                : drawCall.eventId + '  ' + drawCall.name;
        }

        function highlightText(label, filter) {
            const normalizedFilter = normalizeText(filter);
            if (!normalizedFilter) {
                return escapeHtml(label);
            }
            const regex = new RegExp('(' + escapeRegex(normalizedFilter) + ')', 'ig');
            return escapeHtml(label).replace(regex, '<mark>$1</mark>');
        }

        function cloneFullTree(drawCall) {
            return {
                drawCall,
                selfMatch: false,
                children: Array.isArray(drawCall.children) ? drawCall.children.map(cloneFullTree) : [],
            };
        }

        function matchesFilter(drawCall, filter) {
            const normalizedFilter = normalizeText(filter);
            if (!normalizedFilter) {
                return true;
            }
            return normalizeText(drawCall.name).includes(normalizedFilter)
                || String(drawCall.eventId).includes(normalizedFilter)
                || String(drawCall.drawIndex).includes(normalizedFilter);
        }

        function filterDrawCall(drawCall, filter) {
            const normalizedFilter = normalizeText(filter);
            if (!normalizedFilter) {
                return cloneFullTree(drawCall);
            }

            const visibleChildren = [];
            const children = Array.isArray(drawCall.children) ? drawCall.children : [];
            for (const child of children) {
                const filteredChild = filterDrawCall(child, filter);
                if (filteredChild) {
                    visibleChildren.push(filteredChild);
                }
            }

            const selfMatch = matchesFilter(drawCall, filter);
            if (selfMatch) {
                return {
                    drawCall,
                    selfMatch: true,
                    children: children.map(cloneFullTree),
                };
            }

            if (visibleChildren.length > 0) {
                return {
                    drawCall,
                    selfMatch: false,
                    children: visibleChildren,
                };
            }

            return null;
        }

        function buildVisibleTree(source, filter) {
            return source.map((drawCall) => filterDrawCall(drawCall, filter)).filter(Boolean);
        }

        function countMatches(nodes) {
            let count = 0;
            for (const node of nodes) {
                if (node.selfMatch) {
                    count += 1;
                }
                count += countMatches(node.children || []);
            }
            return count;
        }

        function isExpanded(node, filterActive) {
            return filterActive || expandedEventIds.has(node.drawCall.eventId);
        }

        function render() {
            const visibleTree = buildVisibleTree(drawCalls, filterText);
            const filterActive = normalizeText(filterText).length > 0;
            const matchCount = filterActive ? countMatches(visibleTree) : drawCalls.length;

            if (drawCalls.length === 0) {
                summary.innerHTML = '<strong>No capture loaded.</strong> Open a frame capture to browse events here.';
                list.innerHTML = '<div class="empty">The Event Browser will appear here after draw calls are loaded.</div>';
                return;
            }

            if (filterActive) {
                summary.innerHTML = matchCount > 0
                    ? '<strong>' + matchCount + '</strong> matching event' + (matchCount === 1 ? '' : 's') + ' for <strong>' + escapeHtml(filterText) + '</strong>.'
                    : 'No events match <strong>' + escapeHtml(filterText) + '</strong>.';
            } else {
                summary.innerHTML = '<strong>' + drawCalls.length + '</strong> root event group' + (drawCalls.length === 1 ? '' : 's') + '. Use the search box above to filter inside this pane.';
            }

            if (visibleTree.length === 0) {
                list.innerHTML = '<div class="empty">Try another keyword, event ID, or draw index.</div>';
                return;
            }

            const fragments = [];
            renderNodes(visibleTree, 0, filterActive, fragments);
            list.innerHTML = fragments.join('');
            attachHandlers(filterActive);
        }

        function renderNodes(nodes, depth, filterActive, fragments) {
            for (const node of nodes) {
                const drawCall = node.drawCall;
                const children = Array.isArray(node.children) ? node.children : [];
                const hasChildren = children.length > 0;
                const expanded = isExpanded(node, filterActive);
                const label = getRowLabel(drawCall);
                const metaParts = [];
                if (drawCall.flags) {
                    metaParts.push(drawCall.flags);
                }
                if (drawCall.numIndices > 0) {
                    metaParts.push('Indices ' + drawCall.numIndices);
                }
                if (drawCall.numInstances > 0) {
                    metaParts.push('Instances ' + drawCall.numInstances);
                }
                if (typeof drawCall.durationUs === 'number') {
                    metaParts.push('GPU ' + formatDuration(drawCall.durationUs));
                }
                const rowClasses = ['row'];
                if (selectedEventId === drawCall.eventId) {
                    rowClasses.push('selected');
                }
                fragments.push(
                    '<div class="' + rowClasses.join(' ') + '" data-event-id="' + drawCall.eventId + '">' +
                        '<div class="prefix" style="padding-left:' + (depth * 14) + 'px">' +
                            '<button class="toggleButton ' + (hasChildren ? '' : 'hidden') + '" type="button" data-toggle-event-id="' + drawCall.eventId + '">' + (hasChildren ? (expanded ? '▾' : '▸') : '•') + '</button>' +
                            '<span class="flagDot" style="background:' + flagColor(drawCall.flags) + '"></span>' +
                        '</div>' +
                        '<div class="labelWrap">' +
                            '<div class="label">' + highlightText(label, filterText) + '</div>' +
                            '<div class="meta">' + escapeHtml(metaParts.join(' · ')) + '</div>' +
                        '</div>' +
                        '<div class="actions">' +
                            '<button class="actionButton" type="button" data-action="shader" data-event-id="' + drawCall.eventId + '">Shader</button>' +
                            '<button class="actionButton" type="button" data-action="pipeline" data-event-id="' + drawCall.eventId + '">Pipeline</button>' +
                        '</div>' +
                    '</div>'
                );
                if (hasChildren && expanded) {
                    renderNodes(children, depth + 1, filterActive, fragments);
                }
            }
        }

        function attachHandlers(filterActive) {
            for (const toggle of list.querySelectorAll('[data-toggle-event-id]')) {
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (filterActive) {
                        return;
                    }
                    const eventId = Number(toggle.getAttribute('data-toggle-event-id'));
                    if (!Number.isFinite(eventId)) {
                        return;
                    }
                    if (expandedEventIds.has(eventId)) {
                        expandedEventIds.delete(eventId);
                    } else {
                        expandedEventIds.add(eventId);
                    }
                    render();
                });
            }

            for (const row of list.querySelectorAll('.row')) {
                row.addEventListener('click', () => {
                    const eventId = Number(row.getAttribute('data-event-id'));
                    if (!Number.isFinite(eventId)) {
                        return;
                    }
                    selectedEventId = eventId;
                    render();
                    vscode.postMessage({ type: 'activateEvent', eventId });
                });
            }

            for (const button of list.querySelectorAll('[data-action]')) {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const action = button.getAttribute('data-action');
                    const eventId = Number(button.getAttribute('data-event-id'));
                    if (!Number.isFinite(eventId)) {
                        return;
                    }
                    selectedEventId = eventId;
                    render();
                    if (action === 'shader') {
                        vscode.postMessage({ type: 'openShaderSource', eventId });
                    } else if (action === 'pipeline') {
                        vscode.postMessage({ type: 'openPipelineState', eventId });
                    }
                });
            }
        }

        searchInput.addEventListener('input', () => {
            filterText = searchInput.value;
            render();
        });

        clearButton.addEventListener('click', () => {
            searchInput.value = '';
            filterText = '';
            render();
            searchInput.focus();
        });

        window.addEventListener('message', (event) => {
            const message = event.data || {};
            if (message.type !== 'state') {
                return;
            }
            drawCalls = Array.isArray(message.drawCalls) ? message.drawCalls : [];
            selectedEventId = typeof message.selectedEventId === 'number' ? message.selectedEventId : undefined;
            render();
        });

        render();
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
