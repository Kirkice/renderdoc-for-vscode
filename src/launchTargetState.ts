import * as vscode from 'vscode';
import { RenderDocBridge } from './renderdocBridge';
import { CaptureLaunchTarget, LiveCaptureEntry, LiveTargetInfo, ReplayHostInfo } from './types';
import { withTimeout } from './util/async';
import { isValidSessionTransition } from './sessionTransitions';

const STATE_KEY = 'renderdoc.selectedLaunchTarget';

export type SelectedLaunchTarget =
    | { kind: 'local' }
    | { kind: 'device'; url: string };

export type LiveSessionPhase = 'idle' | 'checking' | 'ready' | 'launching' | 'running' | 'capturing' | 'completed' | 'failed';

export interface LiveSessionState {
    phase: LiveSessionPhase;
    platform: 'windows' | 'android' | 'unknown';
    target?: LiveTargetInfo;
    targetUrl?: string;
    application?: string;
    lastCapture?: LiveCaptureEntry;
    error?: { code?: string; message: string; recoverable: boolean };
    updatedAt: string;
}

export class LaunchTargetState {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private devices: CaptureLaunchTarget[] = [];
    private selected: SelectedLaunchTarget;
    private liveTarget: LiveTargetInfo | undefined;
    private replayHost: ReplayHostInfo | undefined;
    private recentCaptures: LiveCaptureEntry[] = [];
    private lastStatusNote: string | undefined;
    private bridgeVersion: string | undefined;
    private sessionHint: string | undefined;
    private refreshing = false;
    private lastRefreshError: string | undefined;
    private refreshGeneration = 0;
    private session: LiveSessionState = { phase: 'idle', platform: 'unknown', updatedAt: new Date().toISOString() };

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
        const selected = this.selected;
        if (selected.kind !== 'device') {
            return undefined;
        }
        return this.devices.find((target) => target.url === selected.url);
    }

    getLiveTarget(): LiveTargetInfo | undefined {
        return this.liveTarget;
    }

    getReplayHost(): ReplayHostInfo | undefined {
        return this.replayHost;
    }

    getRecentCaptures(): LiveCaptureEntry[] {
        return this.recentCaptures;
    }

    getRecentCapture(id: string): LiveCaptureEntry | undefined {
        return this.recentCaptures.find((capture) => capture.id === id);
    }

    getLastStatusNote(): string | undefined {
        return this.lastStatusNote;
    }

    getBridgeVersion(): string | undefined {
        return this.bridgeVersion;
    }

    getSessionHint(): string | undefined {
        return this.sessionHint;
    }

    isRefreshing(): boolean {
        return this.refreshing;
    }

    getLastRefreshError(): string | undefined {
        return this.lastRefreshError;
    }

    getSessionState(): LiveSessionState {
        return {
            ...this.session,
            target: this.liveTarget ?? this.session.target,
            lastCapture: this.session.lastCapture ?? this.recentCaptures[0],
        };
    }

    setSessionState(update: Partial<LiveSessionState>): void {
        const nextPhase = update.phase ?? this.session.phase;
        if (!isValidSessionTransition(this.session.phase, nextPhase)) {
            console.warn(`[RenderDoc] Ignoring invalid session transition ${this.session.phase} -> ${nextPhase}.`);
            return;
        }
        this.session = { ...this.session, ...update, updatedAt: new Date().toISOString() };
        this._onDidChange.fire();
    }

    setSessionError(code: string, message: string, recoverable = true): void {
        this.session = { ...this.session, phase: 'failed', error: { code, message, recoverable }, updatedAt: new Date().toISOString() };
        this._onDidChange.fire();
    }

    clearSession(): void {
        this.liveTarget = undefined;
        this.session = { phase: 'idle', platform: 'unknown', updatedAt: new Date().toISOString() };
        this._onDidChange.fire();
    }

    async refresh(bridge: RenderDocBridge): Promise<void> {
        const generation = ++this.refreshGeneration;
        this.refreshing = true;
        this.lastRefreshError = undefined;
        this._onDidChange.fire();

        let nextDevices: CaptureLaunchTarget[] = [];
        try {
            nextDevices = await withTimeout(
                bridge.nativeListCaptureTargets(),
                8000,
                'Timed out while enumerating capture targets.',
            );
        } catch (err: any) {
            console.warn('[RenderDoc] LaunchTargetState.refresh failed:', err?.message);
            this.lastRefreshError = err?.message || String(err);
        }

        if (generation !== this.refreshGeneration) {
            return;
        }

        this.devices = nextDevices;
        const selected = this.selected;
        if (selected.kind === 'device' && !this.devices.some((target) => target.url === selected.url)) {
            this.selected = { kind: 'local' };
            await this.context.workspaceState.update(STATE_KEY, undefined);
        }
        this.refreshing = false;
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

    async refreshReplayHost(bridge: RenderDocBridge): Promise<void> {
        try {
            this.replayHost = await bridge.nativeGetReplayHost();
        } catch (err: any) {
            console.warn('[RenderDoc] LaunchTargetState.refreshReplayHost failed:', err?.message);
            this.replayHost = undefined;
        }
        this._onDidChange.fire();
    }

    setLiveTarget(target: LiveTargetInfo | undefined): void {
        this.liveTarget = target;
        this.session = {
            ...this.session,
            phase: target ? 'running' : 'idle',
            platform: target?.local ? 'windows' : (target ? 'android' : 'unknown'),
            target,
            updatedAt: new Date().toISOString(),
        };
        this._onDidChange.fire();
    }

    setLastStatusNote(message: string | undefined): void {
        this.lastStatusNote = message;
        this._onDidChange.fire();
    }

    setBridgeVersion(version: string | undefined): void {
        this.bridgeVersion = version;
        this._onDidChange.fire();
    }

    setSessionHint(message: string | undefined): void {
        this.sessionHint = message;
        this._onDidChange.fire();
    }

    addRecentCapture(capture: LiveCaptureEntry): void {
        this.recentCaptures = [capture, ...this.recentCaptures.filter((entry) => entry.id !== capture.id)].slice(0, 12);
        this.session = { ...this.session, phase: 'completed', lastCapture: capture };
        this._onDidChange.fire();
    }

    updateRecentCapture(id: string, updates: Partial<LiveCaptureEntry>): void {
        this.recentCaptures = this.recentCaptures.map((entry) => entry.id === id ? { ...entry, ...updates } : entry);
        this._onDidChange.fire();
    }

    removeRecentCapture(id: string): void {
        this.recentCaptures = this.recentCaptures.filter((entry) => entry.id !== id);
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
