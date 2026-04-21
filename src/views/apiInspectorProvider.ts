import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';

export interface ApiChunk {
    eventId: number;
    name: string;
    params: string;
}

/**
 * Sidebar TreeView mirroring RenderDoc's "API Inspector" — when the user
 * clicks a draw call in the Event Browser, this pane lists the underlying
 * API calls (glBindBuffer, glDrawElements, vkCmdDraw, …) that make up that
 * event, rendered as a flat sequence sorted by their own EID.
 *
 * Data is fetched lazily via `RenderDocBridge.nativeGetEventChunks`; if the
 * native bridge isn't available we just show a welcome message.
 */
export class ApiInspectorProvider implements vscode.TreeDataProvider<ApiCallItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ApiCallItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private chunks: ApiChunk[] = [];
    private currentEventId: number | undefined;
    private currentLabel: string | undefined;
    private loading = false;
    private errorText: string | undefined;

    constructor(private readonly bridge: RenderDocBridge) {}

    /** Called when the user selects a draw call in the Event Browser. */
    async setEvent(eventId: number, label?: string): Promise<void> {
        this.currentEventId = eventId;
        this.currentLabel = label;
        this.chunks = [];
        this.errorText = undefined;
        this.loading = true;
        this._onDidChangeTreeData.fire(undefined);

        if (!this.bridge.hasNativeBridge()) {
            this.loading = false;
            this.errorText = 'Native replay required for API inspection.';
            this._onDidChangeTreeData.fire(undefined);
            return;
        }

        try {
            const res = await this.bridge.nativeGetEventChunks(eventId);
            // Sort by eventId to give a deterministic RenderDoc-style order
            // (the native side already returns them in action-order but the
            // user expects strict ascending EID).
            this.chunks = (res.chunks || []).slice().sort((a, b) => a.eventId - b.eventId);
        } catch (e: any) {
            this.errorText = e?.message || String(e);
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    /** Forget the current selection (e.g. when a capture is closed). */
    clear(): void {
        this.currentEventId = undefined;
        this.currentLabel = undefined;
        this.chunks = [];
        this.errorText = undefined;
        this.loading = false;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ApiCallItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ApiCallItem): ApiCallItem[] {
        if (element) { return []; }
        if (this.currentEventId === undefined) {
            const item = new ApiCallItem('Select an event to inspect its API calls', '', undefined);
            item.iconPath = new vscode.ThemeIcon('info');
            return [item];
        }
        if (this.loading) {
            const item = new ApiCallItem('Loading…', '', undefined);
            item.iconPath = new vscode.ThemeIcon('loading~spin');
            return [item];
        }
        if (this.errorText) {
            const item = new ApiCallItem(this.errorText, '', undefined);
            item.iconPath = new vscode.ThemeIcon('warning');
            return [item];
        }
        if (this.chunks.length === 0) {
            const item = new ApiCallItem('No API calls recorded for this event', '', undefined);
            item.iconPath = new vscode.ThemeIcon('circle-slash');
            return [item];
        }
        return this.chunks.map(c => new ApiCallItem(
            `${c.eventId}  ${c.name}`,
            c.params,
            c.eventId,
        ));
    }
}

class ApiCallItem extends vscode.TreeItem {
    constructor(label: string, params: string, public readonly eventId: number | undefined) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (params) {
            this.description = params;
            this.tooltip = `${label}\n${params}`;
        } else {
            this.tooltip = label;
        }
        if (eventId !== undefined) {
            this.iconPath = new vscode.ThemeIcon('symbol-method');
            this.command = {
                command: 'renderdoc.showDrawCallDetails',
                title: 'Jump to Event',
                arguments: [{ label, eventId }],
            };
        }
    }
}
