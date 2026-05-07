import * as vscode from 'vscode';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureLaunchTarget, LiveTargetInfo } from './types';

const STATE_KEY = 'renderdoc.selectedLaunchTarget';

export type SelectedLaunchTarget =
    | { kind: 'local' }
    | { kind: 'device'; url: string };

export class LaunchTargetState {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private devices: CaptureLaunchTarget[] = [];
    private selected: SelectedLaunchTarget;
    private liveTarget: LiveTargetInfo | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        const persisted = context.workspaceState.get<string>(STATE_KEY);
        this.selected = persisted ? { kind: 'device', url: persisted } : { kind: 'local' };
    }

    getDevices(): CaptureLaunchTarget[] {
        return this.devices;
    }

    getSelected(): SelectedLaunchTarget {
        return this.selected;
    }

    getSelectedTarget(): CaptureLaunchTarget | undefined {
        if (this.selected.kind !== 'device') {
            return undefined;
        }
        return this.devices.find((target) => target.url === this.selected.url);
    }

    getLiveTarget(): LiveTargetInfo | undefined {
        return this.liveTarget;
    }

    async refresh(bridge: RenderDocBridge): Promise<void> {
        let nextDevices: CaptureLaunchTarget[] = [];
        try {
            nextDevices = await bridge.nativeListCaptureTargets();
        } catch (err: any) {
            console.warn('[RenderDoc] LaunchTargetState.refresh failed:', err?.message);
        }

        this.devices = nextDevices;
        if (this.selected.kind === 'device' && !this.devices.some((target) => target.url === this.selected.url)) {
            this.selected = { kind: 'local' };
            await this.context.workspaceState.update(STATE_KEY, undefined);
        }
        this._onDidChange.fire();
    }

    async refreshLiveTarget(bridge: RenderDocBridge): Promise<void> {
        try {
            this.liveTarget = await bridge.nativeGetLiveTarget();
        } catch (err: any) {
            console.warn('[RenderDoc] LaunchTargetState.refreshLiveTarget failed:', err?.message);
            this.liveTarget = undefined;
        }
        this._onDidChange.fire();
    }

    setLiveTarget(target: LiveTargetInfo | undefined): void {
        this.liveTarget = target;
        this._onDidChange.fire();
    }

    async selectLocal(): Promise<void> {
        this.selected = { kind: 'local' };
        await this.context.workspaceState.update(STATE_KEY, undefined);
        this._onDidChange.fire();
    }

    async selectDevice(url: string): Promise<void> {
        this.selected = { kind: 'device', url };
        await this.context.workspaceState.update(STATE_KEY, url);
        this._onDidChange.fire();
    }
}