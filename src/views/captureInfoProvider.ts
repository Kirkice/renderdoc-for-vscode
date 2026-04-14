import * as vscode from 'vscode';
import { CaptureInfo } from '../types';

export class CaptureInfoProvider implements vscode.TreeDataProvider<CaptureInfoItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CaptureInfoItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private captureInfo: CaptureInfo | undefined;

    getCaptureInfo(): CaptureInfo | undefined {
        return this.captureInfo;
    }

    update(info: CaptureInfo) {
        this.captureInfo = info;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CaptureInfoItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CaptureInfoItem): CaptureInfoItem[] {
        if (!this.captureInfo) {
            return [];
        }

        // Root level
        if (!element) {
            const items: CaptureInfoItem[] = [
                new CaptureInfoItem('File', this.captureInfo.filePath, vscode.TreeItemCollapsibleState.None, 'file'),
                new CaptureInfoItem('API', this.captureInfo.api, vscode.TreeItemCollapsibleState.None, 'symbol-interface'),
                new CaptureInfoItem('Driver', this.captureInfo.driver, vscode.TreeItemCollapsibleState.None, 'circuit-board'),
                new CaptureInfoItem('RenderDoc Version', this.captureInfo.rdocVersion, vscode.TreeItemCollapsibleState.None, 'tag'),
                new CaptureInfoItem('Machine', this.captureInfo.machineIdent, vscode.TreeItemCollapsibleState.None, 'device-desktop'),
                new CaptureInfoItem('Timestamp', this.captureInfo.timestamp, vscode.TreeItemCollapsibleState.None, 'calendar'),
            ];
            if (this.captureInfo.sections && this.captureInfo.sections.length > 0) {
                items.push(new CaptureInfoItem(
                    'Sections',
                    `${this.captureInfo.sectionCount} sections`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'list-tree'
                ));
            }
            return items;
        }

        // Sections children
        if (element.label === 'Sections' && this.captureInfo.sections) {
            return this.captureInfo.sections.map(s =>
                new CaptureInfoItem(
                    s.name,
                    `${s.type} | ${formatBytes(s.size)}`,
                    vscode.TreeItemCollapsibleState.None,
                    'file-binary'
                )
            );
        }

        return [];
    }
}

class CaptureInfoItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        private value: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        iconId: string
    ) {
        super(label, collapsibleState);
        this.description = value;
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.tooltip = `${label}: ${value}`;
    }
}

function formatBytes(bytes: number): string {
    if (bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
