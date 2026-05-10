import * as vscode from 'vscode';
import { CaptureInfo } from '../types';

type ReplayMode = 'none' | 'local' | 'remote';

interface ReplayDetails {
    mode: ReplayMode;
    hostUrl?: string;
    hint?: string;
    recommendRemote?: boolean;
}

export class CaptureInfoProvider implements vscode.TreeDataProvider<CaptureInfoItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CaptureInfoItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private captureInfo: CaptureInfo | undefined;
    private replayStatus: 'none' | 'active' | 'failed' | 'unavailable' = 'none';
    private replayDetails: ReplayDetails = { mode: 'none' };

    getCaptureInfo(): CaptureInfo | undefined {
        return this.captureInfo;
    }

    update(info: CaptureInfo | undefined) {
        this.captureInfo = info;
        if (!info) {
            this.replayStatus = 'none';
            this.replayDetails = { mode: 'none' };
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    setReplayStatus(status: 'none' | 'active' | 'failed' | 'unavailable') {
        this.replayStatus = status;
        vscode.commands.executeCommand('setContext', 'renderdoc.replayActive', status === 'active');
        this._onDidChangeTreeData.fire(undefined);
    }

    getReplayStatus(): 'none' | 'active' | 'failed' | 'unavailable' {
        return this.replayStatus;
    }

    setReplayDetails(details: Partial<ReplayDetails>) {
        this.replayDetails = {
            ...this.replayDetails,
            ...details,
        };
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

            // Replay status indicator
            if (this.replayStatus === 'active') {
                items.push(new CaptureInfoItem(
                    'Replay',
                    this.replayDetails.mode === 'remote'
                        ? 'Active — replaying on remote host'
                        : 'Active — replaying locally',
                    vscode.TreeItemCollapsibleState.None,
                    'debug-start'));
            } else if (this.replayStatus === 'failed') {
                items.push(new CaptureInfoItem('Replay', 'Failed — inspection features unavailable', vscode.TreeItemCollapsibleState.None, 'error'));
            } else if (this.replayStatus === 'unavailable') {
                items.push(new CaptureInfoItem('Replay', 'Replay not active yet', vscode.TreeItemCollapsibleState.None, 'warning'));
            }

            if (this.replayDetails.mode !== 'none') {
                items.push(new CaptureInfoItem(
                    'Replay Mode',
                    this.replayDetails.mode === 'remote' ? 'Remote' : 'Local',
                    vscode.TreeItemCollapsibleState.None,
                    this.replayDetails.mode === 'remote' ? 'vm-connect' : 'device-desktop'
                ));
            }

            if (this.replayDetails.hostUrl) {
                items.push(new CaptureInfoItem('Replay Host', this.replayDetails.hostUrl, vscode.TreeItemCollapsibleState.None, 'remote'));
            }

            if (this.replayDetails.hint) {
                items.push(new CaptureInfoItem('Replay Hint', this.replayDetails.hint, vscode.TreeItemCollapsibleState.None, 'info'));
            }

            if (this.replayDetails.recommendRemote) {
                items.push(new CaptureInfoItem(
                    'Action',
                    'Use Recommended Replay Host',
                    vscode.TreeItemCollapsibleState.None,
                    'vm-connect',
                    {
                        command: 'renderdoc.useRecommendedReplayHost',
                        title: 'Use Recommended Replay Host',
                    }
                ));
            }

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
        iconId: string,
        command?: vscode.Command,
    ) {
        super(label, collapsibleState);
        this.description = value;
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.tooltip = `${label}: ${value}`;
        this.command = command;
    }
}

function formatBytes(bytes: number): string {
    if (bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
