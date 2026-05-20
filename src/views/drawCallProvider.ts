import * as vscode from 'vscode';
import { DrawCall } from '../types';

function normalizeFilterText(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

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

export class DrawCallProvider implements vscode.TreeDataProvider<DrawCall> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DrawCall | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private drawCalls: DrawCall[] = [];
    private visibleDrawCalls: DrawCall[] = [];
    private filterText = '';
    private filteredChildren = new WeakMap<DrawCall, DrawCall[]>();
    private matchCount = 0;

    update(drawCalls: DrawCall[]) {
        this.drawCalls = drawCalls;
        this.rebuildVisibleTree();
        this._onDidChangeTreeData.fire(undefined);
    }

    getFilterText(): string {
        return this.filterText;
    }

    hasActiveFilter(): boolean {
        return this.filterText.length > 0;
    }

    getSearchMatchCount(): number {
        return this.matchCount;
    }

    setFilterText(filterText: string): boolean {
        const nextFilterText = (filterText ?? '').trim();
        if (nextFilterText === this.filterText) {
            return false;
        }

        this.filterText = nextFilterText;
        this.rebuildVisibleTree();
        this._onDidChangeTreeData.fire(undefined);
        return true;
    }

    clearFilter(): boolean {
        return this.setFilterText('');
    }

    getFirstSearchResult(): DrawCall | undefined {
        if (!this.hasActiveFilter()) {
            return undefined;
        }
        return this.findFirstSearchResult(this.visibleDrawCalls);
    }

    getTreeItem(element: DrawCall): vscode.TreeItem {
        return this.toItem(element);
    }

    getChildren(element?: DrawCall): DrawCall[] {
        if (!element) {
            return this.visibleDrawCalls;
        }
        return this.getVisibleChildren(element);
    }

    private toItem(dc: DrawCall): DrawCallItem {
        const visibleChildren = this.getVisibleChildren(dc);
        const hasChildren = visibleChildren.length > 0;
        const state = hasChildren
            ? (this.hasActiveFilter()
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed)
            : vscode.TreeItemCollapsibleState.None;

        return new DrawCallItem(dc, state, this.filterText);
    }

    private getVisibleChildren(dc: DrawCall): DrawCall[] {
        if (!this.hasActiveFilter()) {
            return dc.children ?? [];
        }
        return this.filteredChildren.get(dc) ?? [];
    }

    private rebuildVisibleTree(): void {
        this.filteredChildren = new WeakMap<DrawCall, DrawCall[]>();
        this.matchCount = 0;

        if (!this.hasActiveFilter()) {
            this.visibleDrawCalls = this.drawCalls;
            return;
        }

        const filteredRoots: DrawCall[] = [];
        for (const drawCall of this.drawCalls) {
            if (this.filterDrawCall(drawCall)) {
                filteredRoots.push(drawCall);
            }
        }
        this.visibleDrawCalls = filteredRoots;
    }

    private filterDrawCall(dc: DrawCall): boolean {
        const children = dc.children ?? [];
        const filteredChildren: DrawCall[] = [];

        for (const child of children) {
            if (this.filterDrawCall(child)) {
                filteredChildren.push(child);
            }
        }

        const matchesSelf = this.matchesFilter(dc);
        if (matchesSelf) {
            this.matchCount += 1;
            if (children.length > 0) {
                this.filteredChildren.set(dc, children);
            }
            return true;
        }

        if (filteredChildren.length > 0) {
            this.filteredChildren.set(dc, filteredChildren);
            return true;
        }

        return false;
    }

    private matchesFilter(dc: DrawCall): boolean {
        const filterText = normalizeFilterText(this.filterText);
        if (!filterText) {
            return true;
        }

        return dc.name.toLowerCase().includes(filterText)
            || String(dc.eventId).includes(filterText)
            || String(dc.drawIndex).includes(filterText);
    }

    private findFirstSearchResult(drawCalls: DrawCall[]): DrawCall | undefined {
        for (const drawCall of drawCalls) {
            if (this.matchesFilter(drawCall)) {
                return drawCall;
            }

            const childResult = this.findFirstSearchResult(this.getVisibleChildren(drawCall));
            if (childResult) {
                return childResult;
            }
        }

        return undefined;
    }
}

class DrawCallItem extends vscode.TreeItem {
    constructor(
        public readonly drawCall: DrawCall,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        filterText: string
    ) {
        super(DrawCallItem.buildLabel(drawCall), collapsibleState);

        const label = DrawCallItem.buildLabel(drawCall);
        const normalizedFilter = normalizeFilterText(filterText);
        const highlightOffset = normalizedFilter ? label.toLowerCase().indexOf(normalizedFilter) : -1;
        if (highlightOffset >= 0) {
            this.label = {
                label,
                highlights: [[highlightOffset, highlightOffset + normalizedFilter.length]],
            };
        }

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