import * as vscode from 'vscode';
import { ResourceInfo } from '../types';

export class ResourceProvider implements vscode.TreeDataProvider<ResourceItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ResourceItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private resources: ResourceInfo[] = [];

    update(resources: ResourceInfo[]) {
        this.resources = resources;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ResourceItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ResourceItem): ResourceItem[] {
        if (!element) {
            // Group by type
            const groups = new Map<string, ResourceInfo[]>();
            for (const r of this.resources) {
                const list = groups.get(r.type) || [];
                list.push(r);
                groups.set(r.type, list);
            }

            return Array.from(groups.entries()).map(([type, items]) =>
                new ResourceItem(
                    `${type}s (${items.length})`,
                    '',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    this.getIconForType(type),
                    undefined,
                    items
                )
            );
        }

        // Children of a group
        if (element.childResources) {
            return element.childResources.map(r => {
                let desc = '';
                if (r.type === 'Texture') {
                    desc = `${r.width}x${r.height} ${r.format}`;
                } else if (r.type === 'Buffer') {
                    desc = formatBytes(r.byteSize);
                } else if (r.type === 'Shader') {
                    desc = (r.shaderStages && r.shaderStages.length > 0)
                        ? r.shaderStages.join(' / ')
                        : (r.format || '');
                } else {
                    desc = r.format || '';
                }

                return new ResourceItem(
                    r.name || `Resource ${r.resourceId}`,
                    desc,
                    vscode.TreeItemCollapsibleState.None,
                    this.getIconForType(r.type),
                    r.resourceId,
                    undefined,
                    r.type.toLowerCase()
                );
            });
        }

        return [];
    }

    private getIconForType(type: string): vscode.ThemeIcon {
        switch (type) {
            case 'Texture': return new vscode.ThemeIcon('file-media');
            case 'Buffer': return new vscode.ThemeIcon('database');
            case 'Shader': return new vscode.ThemeIcon('code');
            default: return new vscode.ThemeIcon('symbol-misc');
        }
    }
}

class ResourceItem extends vscode.TreeItem {
    constructor(
        label: string,
        description: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        icon: vscode.ThemeIcon,
        public readonly resourceId?: string,
        public readonly childResources?: ResourceInfo[],
        public readonly resourceType?: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.iconPath = icon;

        if (resourceId) {
            this.command = {
                command: 'renderdoc.showResourceDetails',
                title: 'Show Details',
                arguments: [{ label, resourceId }]
            };
            this.tooltip = `${label}\n${description}\nID: ${resourceId}`;
        }

        // Context value for menus — set based on resource type
        if (resourceType) {
            this.contextValue = resourceType;
        }
    }
}

function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
