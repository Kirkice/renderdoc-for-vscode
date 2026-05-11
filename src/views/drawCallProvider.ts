import * as vscode from 'vscode';
import { DrawCall } from '../types';

function computeEidRange(dc: DrawCall): { min: number; max: number } {
    let min = dc.eventId;
    let max = dc.eventId;
    const stack: DrawCall[] = [...(dc.children ?? [])];
    while (stack.length > 0) {
        const n = stack.pop()!;
        if (n.eventId < min) { min = n.eventId; }
        if (n.eventId > max) { max = n.eventId; }
        if (n.children && n.children.length > 0) { stack.push(...n.children); }
    }
    return { min, max };
}

function formatDuration(us: number): string {
    if (us >= 1_000_000) { return `${(us / 1_000_000).toFixed(2)} s`; }
    if (us >= 1_000)     { return `${(us / 1_000).toFixed(2)} ms`; }
    return `${us.toFixed(1)} µs`;
}

export class DrawCallProvider implements vscode.TreeDataProvider<DrawCallItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DrawCallItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private drawCalls: DrawCall[] = [];

    update(drawCalls: DrawCall[]) {
        this.drawCalls = drawCalls;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: DrawCallItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DrawCallItem): DrawCallItem[] {
        if (!element) {
            return this.drawCalls.map(dc => this.toItem(dc));
        }
        if (element.drawCall.children && element.drawCall.children.length > 0) {
            return element.drawCall.children.map(dc => this.toItem(dc));
        }
        return [];
    }

    private toItem(dc: DrawCall): DrawCallItem {
        const hasChildren = dc.children && dc.children.length > 0;
        const state = hasChildren
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        return new DrawCallItem(dc, state);
    }
}

class DrawCallItem extends vscode.TreeItem {
    constructor(
        public readonly drawCall: DrawCall,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(DrawCallItem.buildLabel(drawCall), collapsibleState);

        this.tooltip = this.buildTooltip();
        this.iconPath = this.pickIcon();
        this.contextValue = 'drawcall';

        if (drawCall.durationUs !== undefined) {
            this.description = formatDuration(drawCall.durationUs);
        }

        this.command = {
            command: 'renderdoc.showDrawCallDetails',
            title: 'Show Details',
            arguments: [{
                label: drawCall.name,
                eventId: drawCall.eventId,
                drawIndex: drawCall.drawIndex,
                numIndices: drawCall.numIndices,
                numInstances: drawCall.numInstances,
                flags: drawCall.flags
            }]
        };
    }

    private static buildLabel(dc: DrawCall): string {
        const hasChildren = dc.children && dc.children.length > 0;
        if (hasChildren) {
            const { min, max } = computeEidRange(dc);
            const eidStr = min === max ? `${min}` : `${min}-${max}`;
            return `${eidStr}  ${dc.name}`;
        }
        return `${dc.eventId}  ${dc.name}`;
    }

    private pickIcon(): vscode.ThemeIcon {
        const dc = this.drawCall;
        const hasChildren = dc.children && dc.children.length > 0;

        switch (dc.flags) {
            case 'Drawcall':
                return new vscode.ThemeIcon('triangle-right', new vscode.ThemeColor('charts.green'));
            case 'Dispatch':
                return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.blue'));
            case 'Clear':
                return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
            case 'Copy':
            case 'Resolve':
                return new vscode.ThemeIcon('references', new vscode.ThemeColor('charts.orange'));
            case 'GenMips':
                return new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.orange'));
            case 'Present':
                return new vscode.ThemeIcon('device-desktop', new vscode.ThemeColor('charts.purple'));
            case 'PassBoundary':
                return new vscode.ThemeIcon('bracket', new vscode.ThemeColor('charts.purple'));
            case 'Marker':
                return new vscode.ThemeIcon('bookmark', new vscode.ThemeColor('charts.purple'));
        }

        if (hasChildren) {
            return new vscode.ThemeIcon('folder');
        }
        return new vscode.ThemeIcon('circle-outline');
    }

    private buildTooltip(): string {
        const dc = this.drawCall;
        const hasChildren = dc.children && dc.children.length > 0;
        let tip: string;
        if (hasChildren) {
            const { min, max } = computeEidRange(dc);
            tip = `${dc.name}\nEID range: ${min}-${max}\nChildren: ${dc.children!.length}`;
        } else {
            tip = `${dc.name}\nEID: ${dc.eventId}`;
        }
        if (dc.numIndices > 0) { tip += `\nIndices: ${dc.numIndices}`; }
        if (dc.numInstances > 0) { tip += `\nInstances: ${dc.numInstances}`; }
        if (dc.flags) { tip += `\nFlags: ${dc.flags}`; }
        if (dc.durationUs !== undefined) { tip += `\nGPU time: ${formatDuration(dc.durationUs)}`; }
        return tip;
    }
}