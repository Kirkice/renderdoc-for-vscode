import * as vscode from 'vscode';
import { DrawCall } from '../types';

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
        super(drawCall.name, collapsibleState);

        this.description = `EID: ${drawCall.eventId}`;
        this.tooltip = this.buildTooltip();

        // Choose icon based on draw call flags
        if (drawCall.flags.includes('Drawcall')) {
            this.iconPath = new vscode.ThemeIcon('triangle-right', new vscode.ThemeColor('charts.green'));
        } else if (drawCall.flags.includes('Clear')) {
            this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
        } else if (drawCall.flags.includes('Dispatch')) {
            this.iconPath = new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.blue'));
        } else if (drawCall.flags.includes('PassBoundary')) {
            this.iconPath = new vscode.ThemeIcon('bracket', new vscode.ThemeColor('charts.purple'));
        } else if (drawCall.children && drawCall.children.length > 0) {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-outline');
        }

        // Context value for menus
        this.contextValue = 'drawcall';

        // Click to show details
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

    private buildTooltip(): string {
        const dc = this.drawCall;
        let tip = `${dc.name}\nEvent ID: ${dc.eventId}`;
        if (dc.numIndices > 0) { tip += `\nIndices: ${dc.numIndices}`; }
        if (dc.numInstances > 0) { tip += `\nInstances: ${dc.numInstances}`; }
        if (dc.flags) { tip += `\nFlags: ${dc.flags}`; }
        return tip;
    }
}
