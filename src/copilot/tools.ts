import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RenderDocBridge } from '../renderdocBridge';
import { CaptureInfo, CaptureLaunchTarget, DrawCall, ResourceInfo, TriggerCaptureOptions, TriggerCaptureResult } from '../types';
import { InspectorPanel } from '../views/inspectorPanel';

// Shared state — set by extension.ts after bridge/providers are initialized
let _bridge: RenderDocBridge;
let _getCurrentCapturePath: () => string | undefined;
let _getSelectionContext: () => { selectedDrawCall: any; selectedResource: any };
let _getCurrentDrawCalls: () => DrawCall[];
let _openCaptureForChat: ((filePath?: string) => Promise<OpenCaptureResult>) | undefined;
let _getReplayState: (() => ReplayStateInfo) | undefined;
let _listCaptureTargets: (() => Promise<CaptureLaunchTarget[]>) | undefined;
let _launchRemoteApplication: ((input: LaunchRemoteApplicationInput) => Promise<unknown>) | undefined;
let _triggerRemoteCapture: ((input: TriggerRemoteCaptureInput) => Promise<TriggerCaptureResult>) | undefined;
let _checkAndroidReadiness: ((input: AndroidReadinessInput) => Promise<unknown>) | undefined;
let _launchWindowsApplication: ((input: WindowsLaunchInput) => Promise<unknown>) | undefined;
let _getSessionState: (() => unknown) | undefined;
let _closeSession: (() => Promise<unknown>) | undefined;
let _launchApplication: ((input: LaunchApplicationInput) => Promise<unknown>) | undefined;
let _captureFrame: ((input: TriggerRemoteCaptureInput) => Promise<unknown>) | undefined;
let _diagnoseEnvironment: (() => Promise<unknown>) | undefined;
let _getMcpStatus: (() => unknown) | undefined;
let _bookmarks: Bookmark[] = [];
let _updateBookmarks: ((bookmarks: Bookmark[]) => Promise<void>) | undefined;

interface ReplayStateInfo {
    captureLoaded: boolean;
    capturePath: string | null;
    replayStatus: 'none' | 'active' | 'failed' | 'unavailable';
    replayMode: 'none' | 'local' | 'remote';
    nativeBridgeRunning: boolean;
}

interface OpenCaptureResult {
    captureLoaded: boolean;
    capturePath: string | null;
    loadedNow: boolean;
    requestedPath: string | null;
    candidatePaths: string[];
    message: string;
}

export interface LaunchApplicationInput {
    platform?: 'windows' | 'android';
    app: string;
    targetUrl?: string;
    targetQuery?: string;
    workingDir?: string;
    commandLine?: string;
}

export interface Bookmark {
    id: string;
    capturePath?: string;
    eventId?: number;
    title: string;
    note?: string;
    conclusion?: string;
    analysis?: string;
    screenshotPath?: string;
    createdAt: string;
}

export function initTools(
    bridge: RenderDocBridge,
    getCurrentCapturePath: () => string | undefined,
    getSelectionContext: () => { selectedDrawCall: any; selectedResource: any },
    getCurrentDrawCalls?: () => DrawCall[],
    openCaptureForChat?: (filePath?: string) => Promise<OpenCaptureResult>,
    getReplayState?: () => ReplayStateInfo,
    listCaptureTargets?: () => Promise<CaptureLaunchTarget[]>,
    launchRemoteApplication?: (input: LaunchRemoteApplicationInput) => Promise<unknown>,
    triggerRemoteCapture?: (input: TriggerRemoteCaptureInput) => Promise<TriggerCaptureResult>,
    checkAndroidReadiness?: (input: AndroidReadinessInput) => Promise<unknown>,
    launchWindowsApplication?: (input: WindowsLaunchInput) => Promise<unknown>,
    launchApplication?: (input: LaunchApplicationInput) => Promise<unknown>,
    getSessionState?: () => unknown,
    closeSession?: () => Promise<unknown>,
    captureFrame?: (input: TriggerRemoteCaptureInput) => Promise<unknown>,
    diagnoseEnvironment?: () => Promise<unknown>,
    getMcpStatus?: () => unknown,
    initialBookmarks?: Bookmark[],
    updateBookmarks?: (bookmarks: Bookmark[]) => Promise<void>,
) {
    _bridge = bridge;
    _getCurrentCapturePath = getCurrentCapturePath;
    _getSelectionContext = getSelectionContext;
    _getCurrentDrawCalls = getCurrentDrawCalls ?? (() => []);
    _openCaptureForChat = openCaptureForChat;
    _getReplayState = getReplayState;
    _listCaptureTargets = listCaptureTargets;
    _launchRemoteApplication = launchRemoteApplication;
    _triggerRemoteCapture = triggerRemoteCapture;
    _checkAndroidReadiness = checkAndroidReadiness;
    _launchWindowsApplication = launchWindowsApplication;
    _getSessionState = getSessionState;
    _closeSession = closeSession;
    _launchApplication = launchApplication;
    _captureFrame = captureFrame;
    _diagnoseEnvironment = diagnoseEnvironment;
    _getMcpStatus = getMcpStatus;
    _bookmarks = initialBookmarks ?? [];
    _updateBookmarks = updateBookmarks;
}

interface BookmarkInput { eventId?: number; title: string; note?: string; conclusion?: string; analysis?: string; screenshotPath?: string }
export class AddBookmarkTool implements vscode.LanguageModelTool<BookmarkInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BookmarkInput>): Promise<vscode.LanguageModelToolResult> {
        const bookmark: Bookmark = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, capturePath: _getCurrentCapturePath(), eventId: options.input.eventId, title: options.input.title, note: options.input.note, conclusion: options.input.conclusion, analysis: options.input.analysis, screenshotPath: options.input.screenshotPath, createdAt: new Date().toISOString() };
        _bookmarks = [bookmark, ..._bookmarks].slice(0, 200);
        await _updateBookmarks?.(_bookmarks);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(bookmark, null, 2))]);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BookmarkInput>): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: `Adding RenderDoc bookmark ${options.input?.title ?? ''}…` }; }
}
export class ListBookmarksTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(): Promise<vscode.LanguageModelToolResult> { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ count: _bookmarks.length, bookmarks: _bookmarks }, null, 2))]); }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Loading RenderDoc investigation bookmarks…' }; }
}
export class RemoveBookmarkTool implements vscode.LanguageModelTool<{ id: string }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ id: string }>): Promise<vscode.LanguageModelToolResult> { _bookmarks = _bookmarks.filter((bookmark) => bookmark.id !== options.input.id); await _updateBookmarks?.(_bookmarks); return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ok: true, id: options.input.id }, null, 2))]); }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Removing RenderDoc bookmark…' }; }
}

interface UpdateBookmarkInput { id: string; title?: string; note?: string; eventId?: number; conclusion?: string; analysis?: string; screenshotPath?: string }
export class UpdateBookmarkTool implements vscode.LanguageModelTool<UpdateBookmarkInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<UpdateBookmarkInput>): Promise<vscode.LanguageModelToolResult> {
        const index = _bookmarks.findIndex((bookmark) => bookmark.id === options.input.id);
        if (index < 0) throw new Error(`Bookmark ${options.input.id} was not found.`);
        const current = _bookmarks[index];
        _bookmarks[index] = {
            ...current,
            ...(options.input.title !== undefined ? { title: options.input.title } : {}),
            ...(options.input.note !== undefined ? { note: options.input.note } : {}),
            ...(options.input.eventId !== undefined ? { eventId: options.input.eventId } : {}),
            ...(options.input.conclusion !== undefined ? { conclusion: options.input.conclusion } : {}),
            ...(options.input.analysis !== undefined ? { analysis: options.input.analysis } : {}),
            ...(options.input.screenshotPath !== undefined ? { screenshotPath: options.input.screenshotPath } : {}),
        };
        await _updateBookmarks?.(_bookmarks);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(_bookmarks[index], null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Updating RenderDoc investigation bookmark…' }; }
}

interface InvestigationReportInput { format?: 'markdown' | 'json'; outputPath?: string; timingLimit?: number }
export class ExportInvestigationReportTool implements vscode.LanguageModelTool<InvestigationReportInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<InvestigationReportInput>): Promise<vscode.LanguageModelToolResult> {
        const capturePath = requireCapturePath();
        const [captureInfo, drawCalls, resources] = await Promise.all([
            _bridge.getCaptureInfo(capturePath),
            _bridge.getDrawCalls(capturePath),
            _bridge.getResources(capturePath),
        ]);
        const timings = _bridge.hasNativeBridge() ? await _bridge.getDrawTimings() : new Map<number, number>();
        const hotspots: Array<{ eventId: number; name: string; durationUs: number }> = [];
        const visit = (items: DrawCall[]) => items.forEach((item) => {
            if (item.children?.length) visit(item.children);
            else {
                const durationUs = timings.get(item.eventId) ?? item.durationUs ?? 0;
                if (durationUs > 0) hotspots.push({ eventId: item.eventId, name: item.name, durationUs });
            }
        });
        visit(drawCalls);
        hotspots.sort((a, b) => b.durationUs - a.durationUs);
        const totalBytes = resources.reduce((sum, resource) => sum + Number(resource.byteSize ?? 0), 0);
        const report = {
            generatedAt: new Date().toISOString(),
            capturePath,
            captureInfo,
            session: _getSessionState?.() ?? { phase: 'idle' },
            bookmarks: _bookmarks.filter((bookmark) => !bookmark.capturePath || bookmark.capturePath === capturePath),
            performance: { timingAvailable: timings.size > 0, hottestEvents: hotspots.slice(0, Math.max(1, Math.min(options.input?.timingLimit ?? 20, 200))) },
            resources: { count: resources.length, totalBytes, totalMiB: totalBytes / (1024 * 1024), largest: [...resources].sort((a, b) => Number(b.byteSize ?? 0) - Number(a.byteSize ?? 0)).slice(0, 25) },
            limitations: ['Resource byteSize is a capture footprint estimate.', 'Performance conclusions require available GPU timing evidence.'],
        };
        const format = options.input?.format ?? 'markdown';
        const content = format === 'json' ? JSON.stringify(report, null, 2) : [
            '# RenderDoc Investigation Report',
            '',
            `- Generated: ${report.generatedAt}`,
            `- Capture: ${capturePath}`,
            `- API: ${captureInfo.api ?? 'unknown'}`,
            `- Resources: ${resources.length} (${(totalBytes / (1024 * 1024)).toFixed(2)} MiB)`,
            '',
            '## Bookmarks',
            ...(report.bookmarks.length ? report.bookmarks.map((bookmark) => `- **${bookmark.title}**${bookmark.eventId !== undefined ? ` (EID ${bookmark.eventId})` : ''}${bookmark.note ? ` — ${bookmark.note}` : ''}`) : ['- None']),
            '',
            '## Performance hotspots',
            ...(report.performance.timingAvailable ? report.performance.hottestEvents.map((event) => `- EID ${event.eventId}: ${event.name} — ${event.durationUs.toFixed(2)} µs`) : ['- GPU timings unavailable; treat performance conclusions as hypotheses.']),
            '',
            '## Limitations',
            ...report.limitations.map((note) => `- ${note}`),
        ].join('\n');
        const outputPath = options.input?.outputPath ? path.resolve(options.input.outputPath) : undefined;
        if (outputPath) {
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.writeFile(outputPath, content, 'utf8');
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ok: true, format, outputPath: outputPath ?? null, report, content: outputPath ? undefined : content }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Exporting the RenderDoc investigation report…' }; }
}

interface WaitForSessionInput { timeoutMs?: number; pollMs?: number }
async function waitForSessionState(predicate: (state: any) => boolean, input?: WaitForSessionInput): Promise<any> {
    const timeoutMs = Math.max(100, Math.min(input?.timeoutMs ?? 10000, 60000));
    const pollMs = Math.max(50, Math.min(input?.pollMs ?? 250, 2000));
    const deadline = Date.now() + timeoutMs;
    let state = _getSessionState?.() ?? { phase: 'idle' };
    while (!predicate(state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        state = _getSessionState?.() ?? { phase: 'idle' };
    }
    return { ok: predicate(state), timedOut: !predicate(state), timeoutMs, state };
}

export class WaitForLiveTargetTool implements vscode.LanguageModelTool<WaitForSessionInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WaitForSessionInput>): Promise<vscode.LanguageModelToolResult> {
        const result = await waitForSessionState((state) => ['ready', 'running', 'capturing', 'completed'].includes(state.phase) && !!state.target, options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Waiting for the RenderDoc live target to become ready…' }; }
}

export class WaitForCaptureTool implements vscode.LanguageModelTool<WaitForSessionInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WaitForSessionInput>): Promise<vscode.LanguageModelToolResult> {
        const result = await waitForSessionState((state) => ['completed'].includes(state.phase) && !!state.lastCapture, options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Waiting for the RenderDoc capture to complete…' }; }
}

export class LaunchApplicationTool implements vscode.LanguageModelTool<LaunchApplicationInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<LaunchApplicationInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_launchApplication) throw new Error('Application launch workflow is not initialized.');
        const result = await _launchApplication(options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<LaunchApplicationInput>): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Launching ${options.input?.platform ?? 'the requested platform'} application ${options.input?.app ?? ''}…` };
    }
}

interface PerformanceReportInput { limit?: number; format?: 'json' | 'markdown'; outputPath?: string }
export class GeneratePerformanceReportTool implements vscode.LanguageModelTool<PerformanceReportInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PerformanceReportInput>): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const drawCalls = _getCurrentDrawCalls().length ? _getCurrentDrawCalls() : await _bridge.getDrawCalls(filePath);
        const timings = _bridge.hasNativeBridge() ? await _bridge.getDrawTimings() : new Map<number, number>();
        const rows: Array<{ eventId: number; name: string; durationUs: number }> = [];
        const visit = (items: DrawCall[]) => items.forEach((item) => {
            if (item.children?.length) visit(item.children);
            else {
                const durationUs = timings.get(item.eventId) ?? item.durationUs ?? 0;
                if (durationUs > 0) rows.push({ eventId: item.eventId, name: item.name, durationUs });
            }
        });
        visit(drawCalls);
        rows.sort((a, b) => b.durationUs - a.durationUs);
        const passTotals = new Map<string, number>();
        const aggregate = (items: DrawCall[], marker = 'Frame') => items.forEach((item) => {
            const durationUs = timings.get(item.eventId) ?? item.durationUs ?? 0;
            const name = item.children?.length ? item.name : marker;
            if (durationUs > 0) passTotals.set(name, (passTotals.get(name) ?? 0) + durationUs);
            if (item.children?.length) aggregate(item.children, item.name);
        });
        aggregate(drawCalls);
        const hottestPasses = Array.from(passTotals, ([name, durationUs]) => ({ name, durationUs })).sort((a, b) => b.durationUs - a.durationUs).slice(0, Math.max(1, Math.min(options.input?.limit ?? 20, 200)));
        const limit = Math.max(1, Math.min(options.input?.limit ?? 20, 200));
        const hottestEvents = await Promise.all(rows.slice(0, limit).map(async (event) => {
            const evidence: any = { event: { eventId: event.eventId, name: event.name, durationUs: event.durationUs }, resource: undefined, shader: undefined, mesh: undefined };
            try {
                const details = await _bridge.nativeGetPipelineState(event.eventId);
                evidence.shader = details?.shaders ? Object.fromEntries(Object.entries(details.shaders as Record<string, any>).map(([stage, shader]) => [stage, { resourceId: (shader as any)?.resourceId, name: (shader as any)?.name, entryPoint: (shader as any)?.entryPoint }])) : undefined;
                const bindings = details?.stageResources ?? {};
                const resourceIds = Object.values(bindings).flatMap((stage: any) => [...(stage?.textures ?? []), ...(stage?.constantBlocks ?? [])].map((item: any) => item?.resourceId ?? item?.resourceName).filter(Boolean)).slice(0, 12);
                evidence.resource = resourceIds;
            } catch (error: any) { evidence.pipelineError = error?.message ?? String(error); }
            try { evidence.mesh = await _bridge.nativeGetMeshData(event.eventId, 'vsin', { maxVertices: 0 }); } catch (error: any) { evidence.mesh = { available: false, reason: error?.message ?? String(error) }; }
            return { ...event, evidence: { capturePath: filePath, ...evidence } };
        }));
        const report = {
            capturePath: filePath,
            timingAvailable: timings.size > 0,
            hottestPasses,
            hottestEvents,
            totalTimedEvents: rows.length,
            conclusions: timings.size > 0
                ? { confirmed: ['Hotspot ranking is based on captured GPU timing values.'], inferred: [], toVerify: ['Inspect pipeline, shader, mesh, and resource bindings for the top EIDs.'] }
                : { confirmed: [], inferred: [], toVerify: ['Collect GPU timings before making performance conclusions.'] },
            evidence: timings.size ? 'Hotspots are based on GPU timing evidence.' : 'GPU timings are unavailable; treat performance conclusions as hypotheses.',
        };
        const format = options.input?.format ?? 'json';
        const content = format === 'json' ? JSON.stringify(report, null, 2) : [
            '# RenderDoc Performance Report',
            '',
            `- Capture: ${filePath}`,
            `- GPU timings available: ${report.timingAvailable ? 'yes' : 'no'}`,
            `- Timed events: ${report.totalTimedEvents}`,
            '',
            '## Hottest passes',
            ...(hottestPasses.length ? hottestPasses.map((pass) => `- ${pass.name}: ${pass.durationUs.toFixed(2)} µs`) : ['- None']),
            '',
            '## Hottest events',
            ...(hottestEvents.length ? hottestEvents.map((event) => `- EID ${event.eventId}: ${event.name} — ${event.durationUs.toFixed(2)} µs`) : ['- None']),
            '',
            '## Evidence and limitations',
            `- ${report.evidence}`,
            ...report.conclusions.toVerify.map((item) => `- Follow-up: ${item}`),
        ].join('\n');
        const outputPath = options.input?.outputPath ? path.resolve(options.input.outputPath) : undefined;
        if (outputPath) {
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.writeFile(outputPath, content, 'utf8');
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ok: true, format, outputPath: outputPath ?? null, report, content: outputPath ? undefined : content }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Generating an evidence-based RenderDoc performance report…' }; }
}

export class ResourceMemoryAuditTool implements vscode.LanguageModelTool<{ limit?: number }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ limit?: number }>): Promise<vscode.LanguageModelToolResult> {
        const resources = await _bridge.getResources(requireCapturePath());
        const limit = Math.max(1, Math.min(options.input?.limit ?? 25, 200));
        const rows = resources.map((resource) => ({
            resourceId: resource.resourceId,
            type: resource.type,
            name: resource.name,
            byteSize: Number(resource.byteSize ?? 0),
            width: resource.width,
            height: resource.height,
            format: resource.format,
        })).sort((a, b) => b.byteSize - a.byteSize);
        const totalBytes = rows.reduce((sum, row) => sum + row.byteSize, 0);
        const textures = rows.filter((row) => row.type.toLowerCase().includes('texture'));
        const byFormat = textures.reduce<Record<string, { count: number; bytes: number }>>((result, row) => { const key = row.format || 'unknown'; result[key] = result[key] ?? { count: 0, bytes: 0 }; result[key].count += 1; result[key].bytes += row.byteSize; return result; }, {});
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ totalResources: rows.length, totalBytes, totalMiB: totalBytes / (1024 * 1024), largestResources: rows.slice(0, limit), textureAudit: { count: textures.length, byFormat, mipLevelsAvailable: textures.filter((row: any) => row.mipLevels > 1).length, dimensions: textures.slice(0, limit).map((row) => ({ resourceId: row.resourceId, width: row.width, height: row.height, format: row.format, byteSize: row.byteSize })) } , notes: ['byteSize is reported by RenderDoc resource metadata.', 'This is a capture resource footprint audit, not a full runtime allocation/leak proof.'] }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Auditing the largest captured textures and buffers…' }; }
}

interface ResourceLifetimeInput { resourceId?: string; limit?: number }
export class ResourceLifetimeTool implements vscode.LanguageModelTool<ResourceLifetimeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ResourceLifetimeInput>): Promise<vscode.LanguageModelToolResult> {
        const resources = await _bridge.getResources(requireCapturePath());
        const drawCalls = _getCurrentDrawCalls().length ? _getCurrentDrawCalls() : await _bridge.getDrawCalls(requireCapturePath());
        const eventIds = new Set<number>();
        const visit = (items: DrawCall[]) => items.forEach((item) => { eventIds.add(item.eventId); if (item.children?.length) visit(item.children); });
        visit(drawCalls);
        const filtered = options.input?.resourceId ? resources.filter((resource) => resource.resourceId === options.input.resourceId) : resources;
        const rows = filtered.slice(0, Math.max(1, Math.min(options.input?.limit ?? 100, 500))).map((resource) => ({
            resourceId: resource.resourceId,
            name: resource.name,
            type: resource.type,
            byteSize: resource.byteSize,
            observedEventCount: eventIds.size,
            evidence: 'Capture metadata exposes resource identity and footprint, but not full create/destroy lifetime intervals.',
        }));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, rows }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Analyzing captured resource lifetime evidence…' }; }
}

export class FindUnusedResourcesTool implements vscode.LanguageModelTool<{ limit?: number }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ limit?: number }>): Promise<vscode.LanguageModelToolResult> {
        const resources = await _bridge.getResources(requireCapturePath());
        const drawCalls = _getCurrentDrawCalls().length ? _getCurrentDrawCalls() : await _bridge.getDrawCalls(requireCapturePath());
        const names = new Set<string>();
        const visit = (items: DrawCall[]) => items.forEach((item) => { const match = item.name.match(/[0-9a-f]{8,}/i); if (match) names.add(match[0].toLowerCase()); if (item.children?.length) visit(item.children); });
        visit(drawCalls);
        const candidates = resources.filter((resource) => resource.type !== 'Shader' && !names.has(resource.resourceId.toLowerCase())).slice(0, Math.max(1, Math.min(options.input?.limit ?? 100, 500)));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, candidates, confidence: 'low', limitation: 'This is a conservative heuristic; definitive unused-resource analysis requires binding/lifetime usage data.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Finding resources with no direct capture usage evidence…' }; }
}

interface FindResourceLeaksInput { baselinePath: string; candidatePath: string; limit?: number }
export class FindResourceLeaksTool implements vscode.LanguageModelTool<FindResourceLeaksInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<FindResourceLeaksInput>): Promise<vscode.LanguageModelToolResult> {
        const [baseline, candidate] = await Promise.all([_bridge.getResources(options.input.baselinePath), _bridge.getResources(options.input.candidatePath)]);
        const before = new Map(baseline.map((resource) => [resource.resourceId, resource]));
        const retained = candidate.filter((resource) => before.has(resource.resourceId)).sort((a, b) => Number(b.byteSize ?? 0) - Number(a.byteSize ?? 0)).slice(0, Math.max(1, Math.min(options.input.limit ?? 100, 500)));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, retainedResources: retained, candidateOnlyCount: candidate.filter((resource) => !before.has(resource.resourceId)).length, confidence: 'low', limitation: 'Persistent resource identity across captures is only a leak candidate signal, not proof of a runtime leak.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Finding persistent resource allocation candidates across captures…' }; }
}

interface CompareResourceMemoryInput { baselinePath: string; candidatePath: string; limit?: number }
export class CompareResourceMemoryTool implements vscode.LanguageModelTool<CompareResourceMemoryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CompareResourceMemoryInput>): Promise<vscode.LanguageModelToolResult> {
        const [baseline, candidate] = await Promise.all([_bridge.getResources(options.input.baselinePath), _bridge.getResources(options.input.candidatePath)]);
        const before = new Map(baseline.map((resource) => [resource.resourceId, resource]));
        const changed = candidate.map((resource) => { const previous = before.get(resource.resourceId); return previous && previous.byteSize !== resource.byteSize ? { resourceId: resource.resourceId, name: resource.name, beforeBytes: previous.byteSize, afterBytes: resource.byteSize, deltaBytes: Number(resource.byteSize ?? 0) - Number(previous.byteSize ?? 0) } : undefined; }).filter(Boolean).sort((a: any, b: any) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes)).slice(0, Math.max(1, Math.min(options.input.limit ?? 100, 500)));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ baselineBytes: baseline.reduce((sum, resource) => sum + Number(resource.byteSize ?? 0), 0), candidateBytes: candidate.reduce((sum, resource) => sum + Number(resource.byteSize ?? 0), 0), changedResources: changed }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Comparing resource memory footprints across captures…' }; }
}

interface CompareEventTimingsInput { baselinePath: string; candidatePath: string; limit?: number }
export class CompareEventTimingsTool implements vscode.LanguageModelTool<CompareEventTimingsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CompareEventTimingsInput>): Promise<vscode.LanguageModelToolResult> {
        const [baselineCalls, candidateCalls] = await Promise.all([_bridge.getDrawCalls(options.input.baselinePath), _bridge.getDrawCalls(options.input.candidatePath)]);
        const flatten = (items: DrawCall[], result = new Map<number, DrawCall>()) => { items.forEach((item) => { result.set(item.eventId, item); if (item.children?.length) flatten(item.children, result); }); return result; };
        const before = flatten(baselineCalls); const after = flatten(candidateCalls);
        const changes = Array.from(after.values()).map((item) => { const previous = before.get(item.eventId); const beforeUs = previous?.durationUs ?? 0; const afterUs = item.durationUs ?? 0; return previous && beforeUs !== afterUs ? { eventId: item.eventId, name: item.name, beforeUs, afterUs, deltaUs: afterUs - beforeUs } : undefined; }).filter(Boolean).sort((a: any, b: any) => Math.abs(b.deltaUs) - Math.abs(a.deltaUs)).slice(0, Math.max(1, Math.min(options.input.limit ?? 100, 500)));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, matchedEvents: changes.length, changes, limitation: 'Only timings already attached to draw-call metadata are compared; cross-capture replay timing is not fabricated.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Comparing event timing evidence across captures…' }; }
}

export class CompareCapturesTool implements vscode.LanguageModelTool<{ baselinePath: string; candidatePath: string; limit?: number }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ baselinePath: string; candidatePath: string; limit?: number }>): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;
        const [baselineInfo, candidateInfo] = await Promise.all([_bridge.getCaptureInfo(input.baselinePath), _bridge.getCaptureInfo(input.candidatePath)]);
        const [baselineResources, candidateResources, baselineDraws, candidateDraws] = await Promise.all([_bridge.getResources(input.baselinePath), _bridge.getResources(input.candidatePath), _bridge.getDrawCalls(input.baselinePath), _bridge.getDrawCalls(input.candidatePath)]);
        const byType = (resources: ResourceInfo[]) => resources.reduce<Record<string, { count: number; bytes: number }>>((result, resource) => {
            const current = result[resource.type] ?? { count: 0, bytes: 0 };
            current.count += 1;
            current.bytes += Number(resource.byteSize ?? 0);
            result[resource.type] = current;
            return result;
        }, {});
        const flattenCount = (items: DrawCall[]): number => items.reduce((sum, item) => sum + 1 + (item.children?.length ? flattenCount(item.children) : 0), 0);
        const baselineById = new Map(baselineResources.map((resource) => [resource.resourceId, resource]));
        const candidateById = new Map(candidateResources.map((resource) => [resource.resourceId, resource]));
        const changedResources = candidateResources.map((resource) => {
            const before = baselineById.get(resource.resourceId);
            return before && (before.byteSize !== resource.byteSize || before.width !== resource.width || before.height !== resource.height || before.format !== resource.format)
                ? { resourceId: resource.resourceId, name: resource.name, before: { byteSize: before.byteSize, width: before.width, height: before.height, format: before.format }, after: { byteSize: resource.byteSize, width: resource.width, height: resource.height, format: resource.format }, deltaBytes: Number(resource.byteSize ?? 0) - Number(before.byteSize ?? 0), percentChange: Number(before.byteSize ?? 0) ? ((Number(resource.byteSize ?? 0) - Number(before.byteSize ?? 0)) / Number(before.byteSize ?? 0)) * 100 : null }
                : undefined;
        }).filter(Boolean).slice(0, Math.max(1, Math.min(input.limit ?? 50, 200)));
        const baselineBytes = baselineResources.reduce((sum, resource) => sum + Number(resource.byteSize ?? 0), 0);
        const candidateBytes = candidateResources.reduce((sum, resource) => sum + Number(resource.byteSize ?? 0), 0);
        const baselineDrawCount = flattenCount(baselineDraws);
        const candidateDrawCount = flattenCount(candidateDraws);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ baseline: { path: input.baselinePath, api: baselineInfo.api, resources: baselineResources.length, bytes: baselineBytes, drawCalls: baselineDrawCount, byType: byType(baselineResources) }, candidate: { path: input.candidatePath, api: candidateInfo.api, resources: candidateResources.length, bytes: candidateBytes, drawCalls: candidateDrawCount, byType: byType(candidateResources) }, deltas: { resourceCount: candidateResources.length - baselineResources.length, drawCalls: candidateDrawCount - baselineDrawCount, addedResources: candidateResources.filter((resource) => !baselineById.has(resource.resourceId)).length, removedResources: baselineResources.filter((resource) => !candidateById.has(resource.resourceId)).length, bytesDelta: candidateBytes - baselineBytes, bytesPercentChange: baselineBytes ? ((candidateBytes - baselineBytes) / baselineBytes) * 100 : null, changedResources: changedResources }, limitation: 'Cross-capture event timing comparison requires both captures to be replayed and timed separately.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Comparing RenderDoc capture metadata and resource footprint…' }; }
}

export class FindShaderVariantsTool implements vscode.LanguageModelTool<{ shaderName: string; limit?: number }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ shaderName: string; limit?: number }>): Promise<vscode.LanguageModelToolResult> {
        const needle = options.input.shaderName.toLowerCase();
        const resources = await _bridge.getResources(requireCapturePath());
        const variants = resources.filter((resource) => resource.type.toLowerCase() === 'shader' && [resource.name, resource.resourceId].some((value) => value.toLowerCase().includes(needle))).slice(0, Math.max(1, Math.min(options.input.limit ?? 50, 200)));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ query: options.input.shaderName, matchCount: variants.length, variants: variants.map((resource) => ({ resourceId: resource.resourceId, name: resource.name, format: resource.format, byteSize: resource.byteSize })) }, null, 2))]);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ shaderName: string; limit?: number }>): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: `Finding shader variants matching ${options.input?.shaderName ?? ''}…` }; }
}

interface CompareShadersInput { leftEventId: number; rightEventId: number; stage?: string }
export class CompareShadersTool implements vscode.LanguageModelTool<CompareShadersInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CompareShadersInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: false, reason: 'Shader comparison requires the native replay bridge.' }, null, 2))]);
        const [left, right] = await Promise.all([_bridge.nativeGetShaderSource(options.input.leftEventId, options.input.stage), _bridge.nativeGetShaderSource(options.input.rightEventId, options.input.stage)]);
        const normalize = (payload: any) => JSON.stringify(payload ?? null, Object.keys(payload ?? {}).sort());
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, leftEventId: options.input.leftEventId, rightEventId: options.input.rightEventId, stage: options.input.stage ?? null, equivalentPayload: normalize(left) === normalize(right), left, right, note: 'Comparison is structural JSON evidence; compiler-level semantic equivalence is not inferred.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Comparing shader payloads between two events…' }; }
}

interface ShaderCompileDiagnosticsInput { eventId: number; stage?: string; includeSource?: boolean }
export class GetShaderCompileDiagnosticsTool implements vscode.LanguageModelTool<ShaderCompileDiagnosticsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ShaderCompileDiagnosticsInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: false, reason: 'Shader compile diagnostics require the native replay bridge.' }, null, 2))]);
        const payload = await _bridge.nativeGetShaderSource(options.input.eventId, options.input.stage);
        const shaders = payload?.shaders ?? {};
        const diagnostics = Object.entries(shaders).map(([stage, shader]: [string, any]) => ({ stage, resourceId: shader?.resourceId, compiler: shader?.compiler, entryPoint: shader?.entryPoint, compileFlags: shader?.compileFlags, sourceFiles: shader?.sourceFiles?.map((file: any) => file.filename ?? file.name ?? file) ?? [], hasSource: !!(shader?.source || shader?.sourceFiles?.length) }));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, eventId: options.input.eventId, requestedStage: options.input.stage ?? null, diagnostics, analysisWorkflow: { source: 'Call renderdoc_getShaderInfo for source, bindings, and constant buffers; call renderdoc_getActionTimings for EID timing; call renderdoc_validateShaderEdit before applying changes.' }, limitation: 'This reports captured compiler metadata and source availability; it does not recompile unless an explicit shader edit workflow is used.' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Reading captured shader compiler diagnostics…' }; }
}

interface ValidateShaderEditInput { resourceId: string; shaderStage: number; sourceEncoding: number; entryPoint: string; entryFileIndex?: number; compileFlags?: Array<{ name: string; value: string }>; files: Array<{ filename: string; contents: string }> }
export class ValidateShaderEditTool implements vscode.LanguageModelTool<ValidateShaderEditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ValidateShaderEditInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: false, reason: 'Shader edit validation requires the native replay bridge.' }, null, 2))]);
        const input = options.input;
        try {
            const result = await _bridge.nativeCompileShaderEdit({ resourceId: input.resourceId, shaderStage: input.shaderStage, sourceEncoding: input.sourceEncoding, entryPoint: input.entryPoint, entryFileIndex: input.entryFileIndex ?? 0, compileFlags: input.compileFlags ?? [], files: input.files });
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, valid: !!result?.compiled && !(result?.errors), resourceId: input.resourceId, result, sideEffect: 'Validation invokes compilation but does not apply or persist a replacement.' }, null, 2))]);
        } catch (error: any) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, valid: false, resourceId: input.resourceId, diagnostics: error?.message ?? String(error), sideEffect: 'No shader replacement was applied.' }, null, 2))]);
        }
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Validating shader edit without applying it…' }; }
}

export class ApplyShaderEditTool implements vscode.LanguageModelTool<ValidateShaderEditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ValidateShaderEditInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: false, reason: 'Applying a shader edit requires the native replay bridge.' }, null, 2))]);
        const input = options.input;
        try {
            const applied = await _bridge.nativeApplyShaderEdit({ resourceId: input.resourceId, shaderStage: input.shaderStage, sourceEncoding: input.sourceEncoding, entryPoint: input.entryPoint, entryFileIndex: input.entryFileIndex ?? 0, compileFlags: input.compileFlags ?? [], files: input.files });
            const replay = applied.applied ? await _bridge.nativeTryReplay() : undefined;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, resourceId: input.resourceId, applied: applied.applied, applyResult: applied, replay: replay ? { ok: replay.replay, remote: replay.replayRemote, host: replay.replayHost, error: replay.replayError } : null, sideEffect: 'The replacement was applied to the active replay session. It is not written to the capture file.' }, null, 2))]);
        } catch (error: any) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ available: true, applied: false, resourceId: input.resourceId, error: error?.message ?? String(error), sideEffect: 'The shader replacement was not confirmed as applied.' }, null, 2))]);
        }
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Applying shader edit and validating the active replay…' }; }
}

export class GetSessionStateTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(): Promise<vscode.LanguageModelToolResult> {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(_getSessionState?.() ?? { phase: 'idle' }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Reading the current RenderDoc application session…' };
    }
}

export class CloseSessionTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(): Promise<vscode.LanguageModelToolResult> {
        if (!_closeSession) throw new Error('Session control is not initialized.');
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(await _closeSession(), null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Closing the active RenderDoc application session…' };
    }
}

export class CaptureFrameTool implements vscode.LanguageModelTool<TriggerRemoteCaptureInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TriggerRemoteCaptureInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_captureFrame) throw new Error('Capture workflow is not initialized.');
        const result = await _captureFrame(options.input ?? {});
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Capturing a frame from the active RenderDoc session…' }; }
}

interface EnvironmentDiagnosticsInput { format?: 'json' | 'markdown'; outputPath?: string }
export class DiagnoseEnvironmentTool implements vscode.LanguageModelTool<EnvironmentDiagnosticsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<EnvironmentDiagnosticsInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_diagnoseEnvironment) throw new Error('Environment diagnostics are not initialized.');
        const report = { generatedAt: new Date().toISOString(), environment: await _diagnoseEnvironment(), mcp: _getMcpStatus?.() ?? { available: false, reason: 'MCP status provider is not initialized.' } };
        const format = options.input?.format ?? 'json';
        const content = format === 'json' ? JSON.stringify(report, null, 2) : [
            '# RenderDoc Environment Diagnostics',
            '',
            `- Generated: ${report.generatedAt}`,
            '',
            '## Environment',
            '```json',
            JSON.stringify(report.environment, null, 2),
            '```',
            '',
            '## MCP',
            '```json',
            JSON.stringify(report.mcp, null, 2),
            '```',
        ].join('\n');
        const outputPath = options.input?.outputPath ? path.resolve(options.input.outputPath) : undefined;
        if (outputPath) {
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.writeFile(outputPath, content, 'utf8');
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ok: true, format, outputPath: outputPath ?? null, report, content: outputPath ? undefined : content }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Diagnosing RenderDoc, replay, MCP, and Android environment…' }; }
}

export class CheckAndroidLaunchReadinessTool implements vscode.LanguageModelTool<AndroidReadinessInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<AndroidReadinessInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_checkAndroidReadiness) throw new Error('Android readiness support is not initialized.');
        const result = await _checkAndroidReadiness(options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Checking adb, Android devices, package installation, and RenderDoc target readiness…' };
    }
}

export class LaunchWindowsApplicationTool implements vscode.LanguageModelTool<WindowsLaunchInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<WindowsLaunchInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_launchWindowsApplication) throw new Error('Windows launch support is not initialized.');
        const result = await _launchWindowsApplication(options.input);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WindowsLaunchInput>): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Launching Windows application ${path.basename(options.input?.executablePath ?? '')}…` };
    }
}

export class ListCaptureTargetsTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(): Promise<vscode.LanguageModelToolResult> {
        const targets = _listCaptureTargets ? await _listCaptureTargets() : [];
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({ targets }, null, 2)),
        ]);
    }

    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Listing connected RenderDoc capture targets…' };
    }
}

export class LaunchRemoteApplicationTool implements vscode.LanguageModelTool<LaunchRemoteApplicationInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<LaunchRemoteApplicationInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_launchRemoteApplication) {
            throw new Error('Remote launch support is not initialized.');
        }
        const result = await _launchRemoteApplication(options.input);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<LaunchRemoteApplicationInput>): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Launching Android application ${options.input?.packageActivity ?? ''}…` };
    }
}

export class TriggerRemoteCaptureTool implements vscode.LanguageModelTool<TriggerRemoteCaptureInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<TriggerRemoteCaptureInput>): Promise<vscode.LanguageModelToolResult> {
        if (!_triggerRemoteCapture) {
            throw new Error('Remote capture support is not initialized.');
        }
        const result = await _triggerRemoteCapture(options.input ?? {});
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Capturing a frame from the active remote application…' };
    }
}

function requireCapturePath(): string {
    const p = _getCurrentCapturePath();
    if (!p) {
        throw new Error(
            'No capture file is currently loaded. Call renderdoc_openCapture with no filePath to resolve an already open .rdc tab in this VS Code window, or provide filePath to load a specific capture.',
        );
    }
    return p;
}

interface OpenCaptureInput {
    filePath?: string;
}

export class OpenCaptureTool implements vscode.LanguageModelTool<OpenCaptureInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenCaptureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const result = _openCaptureForChat
            ? await _openCaptureForChat(options.input?.filePath)
            : {
                captureLoaded: false,
                capturePath: null,
                loadedNow: false,
                requestedPath: options.input?.filePath ?? null,
                candidatePaths: [],
                message: 'RenderDoc capture bootstrap is not initialized in this session.',
            };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<OpenCaptureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const requestedPath = options.input?.filePath?.trim();
        return {
            invocationMessage: requestedPath
                ? `Loading RenderDoc capture ${path.basename(requestedPath)}…`
                : 'Resolving the current RenderDoc capture…',
        };
    }
}

// ─── Tool: Get Capture Info ─────────────────────────────────────────────────
export class GetCaptureInfoTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const info = await _bridge.getCaptureInfo(filePath);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(info, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Reading capture file metadata…',
        };
    }
}

// ─── Tool: Get Draw Calls ───────────────────────────────────────────────────
interface GetDrawCallsInput {
    filter?: string;
    /** Only include draw calls whose ancestor marker name contains this string (case-insensitive). */
    markerFilter?: string;
    /** Exclude marker/group nodes; return only leaf events. */
    excludeMarkers?: boolean;
    /** Only return actual GPU draw operations (Drawcall, Dispatch, MeshDispatch flags). */
    onlyDrawCalls?: boolean;
    /** Only include events with eventId >= this value. */
    eventIdMin?: number;
    /** Only include events with eventId <= this value. */
    eventIdMax?: number;
    sortByDuration?: boolean;
    excludeDebugMarkers?: boolean;
    excludeEmptyOperations?: boolean;
}

interface GetActionTimingsInput {
    /** Optional list of specific event IDs to query. If omitted, returns all matching leaf actions. */
    eventIds?: number[];
    /** Only include actions inside a marker group whose name contains this string (case-insensitive). */
    markerFilter?: string;
    /** Exclude actions inside marker groups whose names contain any of these strings (case-insensitive). */
    excludeMarkers?: string[];
    /** Only include actual draw/dispatch/mesh-dispatch leaf actions. */
    onlyDrawCalls?: boolean;
    /** Maximum timing rows to return. Defaults to 200. Set to 0 for unlimited. */
    limit?: number;
}

export class GetDrawCallsTool implements vscode.LanguageModelTool<GetDrawCallsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDrawCallsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        // Prefer the in-memory draw calls (may contain durationUs from fetchTimings).
        // Fall back to re-fetching from the bridge if nothing is cached yet.
        let drawCalls = _getCurrentDrawCalls();
        if (drawCalls.length === 0) {
            drawCalls = await _bridge.getDrawCalls(filePath);
        }

        const filter = options.input?.filter?.toLowerCase();
        if (filter) {
            drawCalls = filterDrawCalls(drawCalls, filter);
        }

        // Apply new filter options
        const { markerFilter, excludeMarkers, onlyDrawCalls, eventIdMin, eventIdMax } = options.input ?? {};
        if (markerFilter || excludeMarkers || onlyDrawCalls || eventIdMin !== undefined || eventIdMax !== undefined) {
            drawCalls = filterDrawCallsAdvanced(drawCalls, { markerFilter, excludeMarkers, onlyDrawCalls, eventIdMin, eventIdMax });
        }

        // Summarize to avoid overwhelming context
        const summary = summarizeDrawCalls(drawCalls);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetDrawCallsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading draw calls…' };
    }
}

export class BuildEventBrowserContextTool implements vscode.LanguageModelTool<GetDrawCallsInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<GetDrawCallsInput>): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        let drawCalls = _getCurrentDrawCalls().length ? _getCurrentDrawCalls() : await _bridge.getDrawCalls(filePath);
        const input = options.input ?? {};
        drawCalls = filterDrawCallsAdvanced(drawCalls, { markerFilter: input.markerFilter, excludeMarkers: input.excludeMarkers, onlyDrawCalls: input.onlyDrawCalls, eventIdMin: input.eventIdMin, eventIdMax: input.eventIdMax, excludeDebugMarkers: input.excludeDebugMarkers, excludeEmptyOperations: input.excludeEmptyOperations });
        if (input.filter) drawCalls = filterDrawCalls(drawCalls, input.filter.toLowerCase());
        const rows: any[] = [];
        const flatten = (items: DrawCall[]) => items.forEach((item) => { rows.push({ eventId: item.eventId, name: item.name, flags: item.flags, durationUs: item.durationUs ?? null, numIndices: item.numIndices, numInstances: item.numInstances }); if (item.children?.length) flatten(item.children); });
        flatten(drawCalls);
        if (input.sortByDuration) rows.sort((a, b) => (b.durationUs ?? -1) - (a.durationUs ?? -1));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ capturePath: filePath, filters: input, matchedEvents: rows.length, events: rows.slice(0, 500), aiContext: `RenderDoc event context: ${rows.length} filtered events. Focus on EIDs, flags, names, GPU duration, indices, and instances; request pipeline/shader/resource evidence before inferring a cause.` }, null, 2))]);
    }
    async prepareInvocation(): Promise<vscode.PreparedToolInvocation> { return { invocationMessage: 'Building filtered Event Browser context for analysis…' }; }
}

export class GetActionTimingsTool implements vscode.LanguageModelTool<GetActionTimingsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetActionTimingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        requireCapturePath();

        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'GPU timings require an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        let timings: Map<number, number>;
        try {
            timings = await _bridge.getDrawTimings();
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: err.message,
                }, null, 2)),
            ]);
        }

        let drawCalls = _getCurrentDrawCalls();
        if (drawCalls.length === 0) {
            drawCalls = await _bridge.getDrawCalls(requireCapturePath());
        }

        applyTimingsToDrawCallTree(drawCalls, timings);

        const limit = Math.min(2000, Math.max(1, options.input?.limit ?? 200));
        const eventIdSet = options.input?.eventIds?.length ? new Set(options.input.eventIds) : undefined;
        const entries = collectActionTimingEntries(drawCalls, {
            eventIdSet,
            markerFilter: options.input?.markerFilter,
            excludeMarkers: options.input?.excludeMarkers,
            onlyDrawCalls: options.input?.onlyDrawCalls,
        }).sort((a, b) => b.durationUs - a.durationUs);

        const truncated = entries.length > limit;
        const returned = entries.slice(0, limit);
        const missingEventIds = eventIdSet
            ? Array.from(eventIdSet).filter((eventId) => !entries.some((entry) => entry.eventId === eventId))
            : [];

        const payload = {
            available: true,
            unit: 'microseconds',
            fetchedEventCount: timings.size,
            returned: returned.length,
            totalMatched: entries.length,
            truncated,
            missingEventIds: missingEventIds.length > 0 ? missingEventIds : undefined,
            timings: returned,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetActionTimingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const scope = options.input?.eventIds?.length
            ? `${options.input.eventIds.length} selected events`
            : 'the current capture';
        return { invocationMessage: `Fetching GPU timings for ${scope}…` };
    }
}

// ─── Tool: Get Resources ────────────────────────────────────────────────────
interface GetResourcesInput {
    type?: string;
    /** Max entries to return. Defaults to 500. Set to 0 for unlimited (discouraged for large captures). */
    limit?: number;
    /** Offset for pagination. Defaults to 0. */
    offset?: number;
}

/** Default cap — prevents dumping thousands of entries into a tool response. */
const RESOURCES_DEFAULT_LIMIT = 500;

export class GetResourcesTool implements vscode.LanguageModelTool<GetResourcesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        let resources = await _bridge.getResources(filePath);

        if (options.input?.type) {
            const t = options.input.type.toLowerCase();
            resources = resources.filter(r => r.type.toLowerCase() === t);
        }

        const total = resources.length;
        const offset = Math.max(0, options.input?.offset ?? 0);
        const limit = Math.min(RESOURCES_DEFAULT_LIMIT, Math.max(1, options.input?.limit ?? RESOURCES_DEFAULT_LIMIT));
        const page = resources.slice(offset, offset + limit);
        const truncated = page.length < total - offset;

        const payload = {
            total,
            offset,
            limit,
            returned: page.length,
            truncated,
            nextOffset: truncated ? offset + page.length : null,
            resources: page,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading resources…' };
    }
}

// ─── Tool: Get Resource Detail ──────────────────────────────────────────────
interface GetResourceDetailInput { resourceId: string }

export class GetResourceDetailTool implements vscode.LanguageModelTool<GetResourceDetailInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetResourceDetailInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const detail = await _bridge.getResourceDetail(filePath, options.input.resourceId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(detail, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetResourceDetailInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading resource details…' };
    }
}

// ─── Tool: Get Event Details ────────────────────────────────────────────────
interface GetEventDetailsInput { eventId: number }

export class GetEventDetailsTool implements vscode.LanguageModelTool<GetEventDetailsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetEventDetailsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const drawCalls = await _bridge.getDrawCalls(filePath);
        const eventId = options.input.eventId;

        // Find the draw call with this eventId
        const found = findDrawCallByEventId(drawCalls, eventId);
        if (!found) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No draw call found with eventId ${eventId}`),
            ]);
        }

        // Try to get pipeline state from native bridge if available
        let pipelineState: any = null;
        if (_bridge.hasNativeBridge()) {
            try {
                pipelineState = await _bridge.nativeGetPipelineState(eventId);
            } catch { /* native bridge not available yet */ }
        }

        const result: any = {
            event: found,
            pipelineState: pipelineState ?? 'Native bridge required for pipeline state. Currently using CLI-only mode.',
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetEventDetailsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Looking up event #${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Pipeline State ───────────────────────────────────────────────
interface GetPipelineStateInput { eventId: number }

export class GetPipelineStateTool implements vscode.LanguageModelTool<GetPipelineStateInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Pipeline state inspection requires an active local replay via the RenderDoc native bridge.',
                ),
            ]);
        }
        const state = await _bridge.nativeGetPipelineState(options.input.eventId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(state, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Getting pipeline state at event #${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Shader Source ────────────────────────────────────────────────
interface GetShaderSourceInput { eventId: number; stage?: string }

export class GetShaderSourceTool implements vscode.LanguageModelTool<GetShaderSourceInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetShaderSourceInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Shader source requires an active local replay. The RenderDoc native bridge is not running.'
                ),
            ]);
        }

        const result = await _bridge.nativeGetShaderSource(options.input.eventId, options.input.stage);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetShaderSourceInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Retrieving shader source code…' };
    }
}

interface GetShaderInfoInput {
    /** Event ID to inspect. */
    eventId: number;
    /** Optional shader stage filter, e.g. vertex, fragment, pixel, compute. */
    stage?: string;
    /** Include full source files / disassembly when available. Defaults to true when stage is specified. */
    includeSource?: boolean;
    /** Include decoded constant buffer contents. Defaults to true. */
    includeConstantBuffers?: boolean;
}

export class GetShaderInfoTool implements vscode.LanguageModelTool<GetShaderInfoInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetShaderInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Shader inspection requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const includeSource = options.input.includeSource ?? !!options.input.stage;
        const includeConstantBuffers = options.input.includeConstantBuffers ?? true;

        const [shaderPayload, pipelineState] = await Promise.all([
            _bridge.nativeGetShaderSource(options.input.eventId),
            _bridge.nativeGetPipelineState(options.input.eventId),
        ]);

        const shaderStages = (shaderPayload && typeof shaderPayload === 'object' && shaderPayload.shaders)
            ? shaderPayload.shaders as Record<string, any>
            : {};
        const stageResources = (pipelineState && typeof pipelineState === 'object' && pipelineState.stageResources)
            ? pipelineState.stageResources as Record<string, any>
            : {};

        const availableStages = collectAvailableShaderStages(shaderStages, stageResources);
        const resolvedStages = resolveRequestedShaderStages(options.input.stage, availableStages);

        if (resolvedStages.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId: options.input.eventId,
                    requestedStage: options.input.stage ?? null,
                    availableStages,
                    reason: options.input.stage
                        ? `Requested shader stage "${options.input.stage}" is not bound at this event.`
                        : 'No shaders are bound at this event.',
                }, null, 2)),
            ]);
        }

        const stages: Record<string, any> = {};
        for (const stageKey of resolvedStages) {
            const shader = shaderStages[stageKey] ?? null;
            const resources = stageResources[stageKey] ?? {};
            const stageSummary: any = {
                shader: summarizeShaderStage(shader, includeSource),
                bindings: {
                    textures: summarizeShaderTextures(resources.textures),
                    samplers: summarizeShaderSamplers(resources.samplers),
                    constantBlocks: summarizeConstantBlockMetadata(resources.constantBlocks),
                },
            };

            if (includeConstantBuffers) {
                const blockEntries = Array.isArray(resources.constantBlocks) ? resources.constantBlocks : [];
                stageSummary.constantBuffers = await Promise.all(blockEntries.map(async (block: any) => {
                    try {
                        const details = await _bridge.nativeGetPipelineConstantBufferContents({
                            eventId: options.input.eventId,
                            stage: stageKey,
                            cbufferIndex: Number(block.cbufferIndex ?? 0),
                            arrayElement: Number(block.arrayElement ?? 0),
                        });
                        return summarizeConstantBufferDetails(details);
                    } catch (err: any) {
                        return {
                            name: block?.name ?? `Constant Buffer ${block?.cbufferIndex ?? '?'}`,
                            cbufferIndex: block?.cbufferIndex,
                            arrayElement: block?.arrayElement ?? 0,
                            error: err.message,
                        };
                    }
                }));
            }

            stages[stageKey] = stageSummary;
        }

        const payload = {
            available: true,
            eventId: options.input.eventId,
            api: pipelineState?.api ?? shaderPayload?.api ?? null,
            requestedStage: options.input.stage ?? null,
            availableStages,
            evidenceWorkflow: {
                timing: 'Call renderdoc_getActionTimings with this EID before attributing GPU cost.',
                bindings: 'The stages.*.bindings fields summarize textures, samplers, and constant-buffer metadata.',
                constantBuffers: includeConstantBuffers ? 'Decoded constant-buffer contents were requested where supported.' : 'Constant-buffer contents were omitted by request.',
                source: includeSource ? 'Captured source or disassembly was included where available.' : 'Call renderdoc_getShaderSource for source or disassembly detail.',
                mali: 'Mali/offline compiler analysis is not inferred from capture data; use the configured Mali workflow when available.',
            },
            sourceIncluded: includeSource,
            constantBuffersIncluded: includeConstantBuffers,
            stages,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetShaderInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const stage = options.input?.stage ? ` (${options.input.stage})` : '';
        return { invocationMessage: `Gathering shader info at EID ${options.input?.eventId}${stage}…` };
    }
}

interface FindProjectImplementationInput {
    /** Optional event ID. If omitted, the tool falls back to the focused inspector/sidebar event. */
    eventId?: number;
    /** Optional explicit shader name or shader file name to search in the project. */
    shaderName?: string;
    /** Optional explicit pass or marker name to search in C# project code. */
    passName?: string;
    /** Additional free-form search terms to include in both shader/C# project searches. */
    additionalTerms?: string[];
    /** Maximum results to return per category. Defaults to 12. */
    limit?: number;
}

export class FindProjectImplementationTool implements vscode.LanguageModelTool<FindProjectImplementationInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindProjectImplementationInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        if (workspaceFolders.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    compatibility: {
                        status: 'noWorkspace',
                        likelyProjectWorkspace: false,
                        summary: 'No project workspace is open, so source mapping cannot search shader or C# implementation files.',
                        shaderFileCount: 0,
                        csharpFileCount: 0,
                        suggestions: [
                            'Open the game or rendering project folder in this VS Code workspace.',
                            'If only the capture is open, provide an explicit shaderName or passName after opening the project.',
                        ],
                    },
                }, null, 2)),
            ]);
        }

        const eventId = resolveFocusedEventId(options.input.eventId);
        const limit = Math.max(1, options.input.limit ?? 12);
        const notes: string[] = [];
        const shaderTerms = new Map<string, ProjectSearchTerm>();
        const passTerms = new Map<string, ProjectSearchTerm>();
        const markerTerms = new Map<string, ProjectSearchTerm>();
        const drawTerms = new Map<string, ProjectSearchTerm>();
        const additionalTerms = new Map<string, ProjectSearchTerm>();

        collectProjectSearchTerms(
            shaderTerms,
            options.input.shaderName,
            inferShaderSearchSource(options.input.shaderName),
            'input.shaderName',
        );
        collectProjectSearchTerms(passTerms, options.input.passName, 'passName', 'input.passName');
        for (const term of options.input.additionalTerms ?? []) {
            collectProjectSearchTerms(additionalTerms, term, 'additional', 'input.additionalTerms');
        }

        if (eventId !== undefined) {
            if (_bridge.hasNativeBridge()) {
                try {
                    const shaderPayload = await _bridge.nativeGetShaderSource(eventId);
                    collectShaderTermsFromPayload(shaderPayload, shaderTerms);
                } catch (err: any) {
                    notes.push(`Could not derive shader names from EID ${eventId}: ${err.message}`);
                }
            } else if (!options.input.shaderName) {
                notes.push('Native bridge is unavailable, so shader names can only come from explicit input.');
            }

            try {
                const drawCalls = await getCachedOrLoadedDrawCalls();
                const trace = findDrawCallTraceByEventId(drawCalls, eventId);
                if (trace) {
                    collectTraceTerms(trace, passTerms, markerTerms, drawTerms);
                } else {
                    notes.push(`Could not resolve draw hierarchy for EID ${eventId}.`);
                }
            } catch (err: any) {
                notes.push(`Could not derive pass names from EID ${eventId}: ${err.message}`);
            }
        } else if (options.input.shaderName === undefined && options.input.passName === undefined) {
            notes.push('No event is focused, so project mapping can only use explicit shaderName, passName, or additionalTerms input.');
        }

        const shaderSearchTerms = mergeProjectSearchTerms(shaderTerms, passTerms, additionalTerms);
        const csharpSearchTerms = mergeProjectSearchTerms(passTerms, markerTerms, shaderTerms, drawTerms, additionalTerms);

        if (shaderSearchTerms.length === 0 && csharpSearchTerms.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId: eventId ?? null,
                    reason: 'No usable shader name, pass name, or additional project search term was available.',
                    derivedTerms: {
                        shaderTerms: serializeProjectSearchTerms(shaderTerms),
                        passTerms: serializeProjectSearchTerms(passTerms),
                        markerTerms: serializeProjectSearchTerms(markerTerms),
                        drawTerms: serializeProjectSearchTerms(drawTerms),
                        additionalTerms: serializeProjectSearchTerms(additionalTerms),
                    },
                    notes: notes.length > 0 ? notes : undefined,
                }, null, 2)),
            ]);
        }

        const [shaderSearch, csharpSearch] = await Promise.all([
            searchWorkspaceImplementationCandidates(shaderSearchTerms, PROJECT_SHADER_FILE_GLOB, PROJECT_SHADER_FILE_LIMIT, limit, 'shader'),
            searchWorkspaceImplementationCandidates(csharpSearchTerms, PROJECT_CSHARP_FILE_GLOB, PROJECT_CSHARP_FILE_LIMIT, limit, 'csharp'),
        ]);

        const prioritizedMatches = [...shaderSearch.matches, ...csharpSearch.matches]
            .sort(compareProjectImplementationMatches)
            .slice(0, limit * 2);
        const compatibility = assessWorkspaceCompatibility(
            workspaceFolders,
            shaderSearch,
            csharpSearch,
            prioritizedMatches,
        );

        const payload = {
            available: true,
            eventId: eventId ?? null,
            workspaceFolders: workspaceFolders.map((folder) => folder.uri.fsPath),
            compatibility,
            derivedTerms: {
                shaderTerms: serializeProjectSearchTerms(shaderTerms),
                passTerms: serializeProjectSearchTerms(passTerms),
                markerTerms: serializeProjectSearchTerms(markerTerms),
                drawTerms: serializeProjectSearchTerms(drawTerms),
                additionalTerms: serializeProjectSearchTerms(additionalTerms),
            },
            prioritizedMatches,
            shaderMatches: shaderSearch.matches,
            csharpMatches: csharpSearch.matches,
            searchedFiles: {
                shaderFiles: shaderSearch.searchedFileCount,
                csharpFiles: csharpSearch.searchedFileCount,
            },
            notes: notes.length > 0 ? notes : undefined,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindProjectImplementationInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const eventId = options.input?.eventId;
        if (eventId !== undefined) {
            return { invocationMessage: `Searching project code for implementation candidates related to EID ${eventId}…` };
        }
        return { invocationMessage: 'Searching project code for shader/pass implementation candidates…' };
    }
}

// ─── Tool: Get Texture Info ─────────────────────────────────────────────────
interface GetTextureInfoInput { textureId?: string }

export class GetTextureInfoTool implements vscode.LanguageModelTool<GetTextureInfoInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTextureInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const resources = await _bridge.getResources(filePath);
        let textures = resources.filter(r => r.type === 'Texture');

        if (options.input?.textureId) {
            textures = textures.filter(r => r.resourceId === options.input!.textureId);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(textures, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetTextureInfoInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Looking up texture info…' };
    }
}

// ─── Tool: Analyze Frame Performance ────────────────────────────────────────
export class AnalyzeFrameTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = requireCapturePath();
        const [info, drawCalls, resources] = await Promise.all([
            _bridge.getCaptureInfo(filePath),
            _bridge.getDrawCalls(filePath),
            _bridge.getResources(filePath),
        ]);

        const analysis = buildFrameAnalysis(info, drawCalls, resources);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(analysis, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Analyzing frame performance…' };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function filterDrawCalls(drawCalls: DrawCall[], filter: string): DrawCall[] {
    const result: DrawCall[] = [];
    for (const dc of drawCalls) {
        if (dc.name.toLowerCase().includes(filter)) {
            result.push(dc);
        }
        if (dc.children?.length) {
            const filtered = filterDrawCalls(dc.children, filter);
            result.push(...filtered);
        }
    }
    return result;
}

function applyTimingsToDrawCallTree(calls: DrawCall[], timings: Map<number, number>): number {
    let aggregatedTotal = 0;

    for (const dc of calls) {
        let nodeDuration = timings.get(dc.eventId);
        let childrenTotal = 0;

        if (dc.children && dc.children.length > 0) {
            childrenTotal = applyTimingsToDrawCallTree(dc.children, timings);
        }

        if ((nodeDuration === undefined || nodeDuration < 0.0) && childrenTotal > 0) {
            nodeDuration = childrenTotal;
        }

        if (nodeDuration !== undefined && nodeDuration > 0) {
            dc.durationUs = nodeDuration;
            aggregatedTotal += nodeDuration;
        } else if (childrenTotal > 0) {
            aggregatedTotal += childrenTotal;
        }
    }

    return aggregatedTotal;
}

interface ActionTimingEntry {
    eventId: number;
    name: string;
    flags: string;
    durationUs: number;
    durationMs: number;
    fullPath: string;
    markerPath: string[];
    numIndices: number;
    numInstances: number;
}

interface CollectActionTimingOptions {
    eventIdSet?: Set<number>;
    markerFilter?: string;
    excludeMarkers?: string[];
    onlyDrawCalls?: boolean;
}

function collectActionTimingEntries(
    drawCalls: DrawCall[],
    options: CollectActionTimingOptions,
    markerPath: string[] = [],
    inMarkerScope = !options.markerFilter,
): ActionTimingEntry[] {
    const entries: ActionTimingEntry[] = [];
    const markerFilterLower = options.markerFilter?.toLowerCase();
    const excludedLower = (options.excludeMarkers ?? []).map(value => value.toLowerCase());

    for (const dc of drawCalls) {
        const markerNode = isMarkerGroup(dc);
        const nextMarkerPath = markerNode ? [...markerPath, dc.name] : markerPath;
        const excluded = excludedLower.some((needle) => nextMarkerPath.some((name) => name.toLowerCase().includes(needle)));
        if (excluded) {
            continue;
        }

        const nextInMarkerScope = !markerFilterLower
            ? true
            : inMarkerScope || (markerNode && dc.name.toLowerCase().includes(markerFilterLower));

        if (dc.children?.length) {
            entries.push(...collectActionTimingEntries(dc.children, options, nextMarkerPath, nextInMarkerScope));
            continue;
        }

        if (!nextInMarkerScope) {
            continue;
        }
        if (options.onlyDrawCalls && !isRealDrawCall(dc.flags)) {
            continue;
        }
        if (options.eventIdSet && !options.eventIdSet.has(dc.eventId)) {
            continue;
        }
        if (typeof dc.durationUs !== 'number' || dc.durationUs <= 0) {
            continue;
        }

        entries.push({
            eventId: dc.eventId,
            name: dc.name,
            flags: dc.flags,
            durationUs: dc.durationUs,
            durationMs: dc.durationUs / 1000.0,
            fullPath: nextMarkerPath.length > 0 ? `${nextMarkerPath.join(' -> ')} -> ${dc.name}` : dc.name,
            markerPath: nextMarkerPath,
            numIndices: dc.numIndices,
            numInstances: dc.numInstances,
        });
    }

    return entries;
}

interface AdvancedFilterOptions {
    markerFilter?: string;
    excludeMarkers?: boolean;
    onlyDrawCalls?: boolean;
    eventIdMin?: number;
    eventIdMax?: number;
    excludeDebugMarkers?: boolean;
    excludeEmptyOperations?: boolean;
}

/** Returns true if the flags string indicates a real GPU operation (not a marker/group). */
function isRealDrawCall(flags: string): boolean {
    const f = flags.toLowerCase();
    return f.includes('drawcall') || f.includes('dispatch') || f.includes('meshdispatch') || f.includes('clear');
}

/** Returns true if this draw call is a marker/group (has children and no GPU operation flags). */
function isMarkerGroup(dc: DrawCall): boolean {
    return !!(dc.children?.length) && !isRealDrawCall(dc.flags);
}

function collectAvailableShaderStages(shaderStages: Record<string, any>, stageResources: Record<string, any>): string[] {
    const preferredOrder = ['vertex', 'hull', 'tessControl', 'domain', 'tessEval', 'geometry', 'pixel', 'fragment', 'compute'];
    const seen = new Set<string>();
    for (const key of Object.keys(shaderStages ?? {})) {
        seen.add(key);
    }
    for (const key of Object.keys(stageResources ?? {})) {
        seen.add(key);
    }

    const ordered: string[] = [];
    for (const stage of preferredOrder) {
        if (seen.has(stage)) {
            ordered.push(stage);
            seen.delete(stage);
        }
    }
    for (const stage of seen) {
        ordered.push(stage);
    }
    return ordered;
}

function shaderStageAliases(stage?: string): string[] {
    if (!stage) {
        return [];
    }

    switch (stage.toLowerCase()) {
    case 'fragment':
    case 'pixel':
        return ['fragment', 'pixel'];
    case 'hull':
    case 'tesscontrol':
    case 'tesc':
        return ['hull', 'tesscontrol'];
    case 'domain':
    case 'tesseval':
    case 'tese':
        return ['domain', 'tesseval'];
    default:
        return [stage.toLowerCase()];
    }
}

function resolveRequestedShaderStages(requestedStage: string | undefined, availableStages: string[]): string[] {
    if (!requestedStage) {
        return availableStages;
    }

    const aliases = shaderStageAliases(requestedStage);
    return availableStages.filter(stage => aliases.includes(stage.toLowerCase()));
}

function summarizeShaderStage(stage: any, includeSource: boolean): any {
    if (!stage || typeof stage !== 'object') {
        return null;
    }

    const summary: any = {
        resourceId: stage.resourceId,
        name: stage.name,
        entryPoint: stage.entryPoint,
        shaderStage: stage.shaderStage,
        editable: stage.editable,
        hasReplacement: stage.hasReplacement,
        compiler: stage.compiler,
        sourceEncoding: stage.sourceEncoding,
        entrySourceName: stage.entrySourceName,
        compileFlags: Array.isArray(stage.compileFlags)
            ? stage.compileFlags.map((flag: any) => `${flag.name}=${flag.value}`)
            : undefined,
    };

    if (includeSource) {
        if (Array.isArray(stage.sourceFiles)) {
            summary.sourceFiles = stage.sourceFiles;
        }
        if (typeof stage.source === 'string') {
            summary.source = stage.source;
        }
        if (typeof stage.disassembly === 'string') {
            summary.disassembly = stage.disassembly;
            summary.disassemblyTarget = stage.disassemblyTarget;
        }
    } else {
        if (Array.isArray(stage.sourceFiles)) {
            summary.sourceFiles = stage.sourceFiles.map((file: any, index: number) => ({
                filename: file.filename,
                isEntry: stage.entryFileIndex === index,
                lineCount: typeof file.contents === 'string' ? file.contents.split(/\r?\n/).length : 0,
                byteLength: typeof file.contents === 'string' ? file.contents.length : 0,
            }));
        }
        summary.hasDisassembly = typeof stage.disassembly === 'string' && stage.disassembly.length > 0;
    }

    return summary;
}

function summarizeShaderTextures(entries: any): any[] {
    const textures = Array.isArray(entries) ? entries : [];
    return textures.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        byteOffset: entry.byteOffset,
        byteSize: entry.byteSize,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function summarizeShaderSamplers(entries: any): any[] {
    const samplers = Array.isArray(entries) ? entries : [];
    return samplers.map((entry) => ({
        name: entry.name,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        minFilter: entry.minFilter,
        magFilter: entry.magFilter,
        mipFilter: entry.mipFilter,
        addressU: entry.addressU,
        addressV: entry.addressV,
        addressW: entry.addressW,
        compareEnable: entry.compareEnable,
        compareFunc: entry.compareFunc,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function summarizeConstantBlockMetadata(entries: any): any[] {
    const blocks = Array.isArray(entries) ? entries : [];
    return blocks.map((entry) => ({
        name: entry.name,
        cbufferIndex: entry.cbufferIndex,
        slot: entry.slot,
        space: entry.space,
        arrayElement: entry.arrayElement,
        byteSize: entry.byteSize,
        boundByteSize: entry.boundByteSize,
        bufferBacked: entry.bufferBacked,
        compileConstants: entry.compileConstants,
        inlineDataBytes: entry.inlineDataBytes,
        variablesCount: entry.variablesCount,
        bufferResourceId: entry.bufferResourceId,
        bufferResourceName: entry.bufferResourceName,
        staticallyUnused: entry.staticallyUnused,
    }));
}

function formatShaderVariableValue(row: unknown): string {
    if (Array.isArray(row)) {
        return row.map((cell) => String(cell)).join(', ');
    }
    return row == null ? '—' : String(row);
}

function flattenShaderVariablesForAi(variables: any, prefix = '', rows: Array<{ name: string; type: string; value: string }> = []): Array<{ name: string; type: string; value: string }> {
    const list = Array.isArray(variables) ? variables : [];
    for (const variable of list) {
        const variableName = String(variable?.name ?? 'var');
        const fullName = prefix ? `${prefix}.${variableName}` : variableName;
        const type = String(variable?.type ?? variable?.baseType ?? '—');
        const members = Array.isArray(variable?.members) ? variable.members : [];
        const displayRows = Array.isArray(variable?.displayRows) ? variable.displayRows : [];

        if (members.length > 0) {
            flattenShaderVariablesForAi(members, fullName, rows);
            continue;
        }

        if (displayRows.length <= 1) {
            rows.push({
                name: fullName,
                type,
                value: displayRows.length > 0 ? formatShaderVariableValue(displayRows[0]) : '—',
            });
            continue;
        }

        displayRows.forEach((row: unknown, index: number) => {
            rows.push({
                name: `${fullName}[${index}]`,
                type,
                value: formatShaderVariableValue(row),
            });
        });
    }
    return rows;
}

function summarizeConstantBufferDetails(details: any): any {
    const rows = flattenShaderVariablesForAi(details?.variables ?? []);
    const previewLimit = 64;
    return {
        name: details?.name,
        cbufferIndex: details?.cbufferIndex,
        slot: details?.slot,
        space: details?.space,
        arrayElement: details?.arrayElement ?? 0,
        entryPoint: details?.entryPoint,
        shaderResourceId: details?.shaderResourceId,
        byteSize: details?.byteSize,
        boundByteSize: details?.boundByteSize,
        bufferBacked: details?.bufferBacked,
        compileConstants: details?.compileConstants,
        inlineDataBytes: details?.inlineDataBytes,
        staticallyUnused: details?.staticallyUnused,
        bufferResourceId: details?.bufferResourceId,
        bufferResourceName: details?.bufferResourceName,
        variableRows: rows.slice(0, previewLimit),
        totalVariableRows: rows.length,
        truncated: rows.length > previewLimit,
    };
}

const PROJECT_SHADER_FILE_GLOB = '**/*.{shader,hlsl,hlsli,glsl,vert,frag,geom,tesc,tese,comp,compute,cginc,fx,fxh,shadergraph}';
const PROJECT_CSHARP_FILE_GLOB = '**/*.cs';
const PROJECT_SEARCH_EXCLUDE_GLOB = '**/{.git,node_modules,Library,Temp,Obj,obj,Bin,bin,Logs,build,dist,out,Packages/package-cache}/**';
const PROJECT_SHADER_FILE_LIMIT = 400;
const PROJECT_CSHARP_FILE_LIMIT = 800;
const PROJECT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const PROJECT_SHADER_EXTENSIONS = new Set(['.shader', '.hlsl', '.hlsli', '.glsl', '.vert', '.frag', '.geom', '.tesc', '.tese', '.comp', '.compute', '.cginc', '.fx', '.fxh', '.shadergraph']);

type ProjectSearchTermSource = 'shaderFile' | 'shaderName' | 'passName' | 'markerPath' | 'drawName' | 'additional';

interface DrawCallTrace {
    event: DrawCall;
    markerPath: string[];
    fullPath: string[];
}

interface ProjectSearchTerm {
    value: string;
    source: ProjectSearchTermSource;
    origin: string;
}

interface ProjectImplementationMatch {
    category: 'shader' | 'csharp';
    matchKind: 'fileName' | 'content';
    term: string;
    termSource: ProjectSearchTermSource;
    origin: string;
    file: string;
    line?: number;
    preview?: string;
    score: number;
    scoreLabel: 'high' | 'medium' | 'low';
    reasons: string[];
}

interface ProjectImplementationSearchResult {
    category: 'shader' | 'csharp';
    relevantFileCount: number;
    searchedFileCount: number;
    matches: ProjectImplementationMatch[];
}

interface WorkspaceCompatibility {
    status: 'ready' | 'partial' | 'weakMatch' | 'noRelevantFiles' | 'noWorkspace';
    likelyProjectWorkspace: boolean;
    summary: string;
    shaderFileCount: number;
    csharpFileCount: number;
    suggestions: string[];
}

function resolveFocusedEventId(explicitEventId?: number): number | undefined {
    if (explicitEventId !== undefined) {
        return explicitEventId;
    }

    const inspector = InspectorPanel.currentPanel;
    const inspectorEventId = inspector?.getCurrentEventId();
    if (inspectorEventId !== undefined && inspectorEventId !== null) {
        return inspectorEventId;
    }

    const selection = _getSelectionContext();
    return selection.selectedDrawCall?.eventId;
}

async function getCachedOrLoadedDrawCalls(): Promise<DrawCall[]> {
    let drawCalls = _getCurrentDrawCalls();
    if (drawCalls.length > 0) {
        return drawCalls;
    }

    const capturePath = _getCurrentCapturePath();
    if (!capturePath) {
        return [];
    }

    drawCalls = await _bridge.getDrawCalls(capturePath);
    return drawCalls;
}

function inferShaderSearchSource(value: unknown): ProjectSearchTermSource {
    if (typeof value === 'string' && PROJECT_SHADER_EXTENSIONS.has(path.extname(value).toLowerCase())) {
        return 'shaderFile';
    }
    return 'shaderName';
}

function projectSearchTermPriority(source: ProjectSearchTermSource): number {
    switch (source) {
    case 'shaderFile':
        return 6;
    case 'shaderName':
        return 5;
    case 'passName':
        return 4;
    case 'markerPath':
        return 3;
    case 'drawName':
        return 2;
    case 'additional':
    default:
        return 1;
    }
}

function collectProjectSearchTerms(
    target: Map<string, ProjectSearchTerm>,
    value: unknown,
    source: ProjectSearchTermSource,
    origin: string,
): void {
    if (typeof value !== 'string') {
        return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return;
    }

    const rawVariants = new Set<string>([trimmed]);
    const basename = path.basename(trimmed).trim();
    if (basename) {
        rawVariants.add(basename);
        const basenameWithoutExt = basename.replace(/\.[^.]+$/, '').trim();
        if (basenameWithoutExt) {
            rawVariants.add(basenameWithoutExt);
        }
    }

    for (const variant of rawVariants) {
        const normalized = normalizeProjectSearchTerm(variant);
        if (normalized && isUsefulProjectSearchTerm(normalized)) {
            const key = normalized.toLowerCase();
            const next: ProjectSearchTerm = { value: normalized, source, origin };
            const existing = target.get(key);
            if (!existing || projectSearchTermPriority(source) > projectSearchTermPriority(existing.source)) {
                target.set(key, next);
            }
        }
    }
}

function normalizeProjectSearchTerm(value: string): string {
    return value
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/[<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isUsefulProjectSearchTerm(value: string): boolean {
    if (value.length < 2) {
        return false;
    }

    const genericTerms = new Set([
        'main', 'shader', 'pass', 'draw', 'dispatch', 'compute', 'fragment', 'pixel', 'vertex', 'geometry', 'unknown',
    ]);

    return !genericTerms.has(value.toLowerCase());
}

function mergeProjectSearchTerms(...collections: Array<Map<string, ProjectSearchTerm>>): ProjectSearchTerm[] {
    const merged = new Map<string, ProjectSearchTerm>();
    for (const collection of collections) {
        for (const [key, term] of collection.entries()) {
            const existing = merged.get(key);
            if (!existing || projectSearchTermPriority(term.source) > projectSearchTermPriority(existing.source)) {
                merged.set(key, term);
            }
        }
    }

    return Array.from(merged.values()).sort((left, right) => {
        return projectSearchTermPriority(right.source) - projectSearchTermPriority(left.source)
            || left.value.length - right.value.length
            || left.value.localeCompare(right.value);
    });
}

function serializeProjectSearchTerms(terms: Map<string, ProjectSearchTerm>): Array<{ value: string; source: ProjectSearchTermSource; origin: string }> {
    return Array.from(terms.values()).sort((left, right) => {
        return projectSearchTermPriority(right.source) - projectSearchTermPriority(left.source)
            || left.value.localeCompare(right.value);
    }).map((term) => ({
        value: term.value,
        source: term.source,
        origin: term.origin,
    }));
}

function collectShaderTermsFromPayload(shaderPayload: any, target: Map<string, ProjectSearchTerm>): void {
    const shaders = shaderPayload && typeof shaderPayload === 'object' ? shaderPayload.shaders : undefined;
    if (!shaders || typeof shaders !== 'object') {
        return;
    }

    for (const [stageName, stage] of Object.entries(shaders as Record<string, any>)) {
        if (!stage || typeof stage !== 'object') {
            continue;
        }

        collectProjectSearchTerms(target, stage.name, 'shaderName', `shader.${stageName}.name`);
        collectProjectSearchTerms(target, stage.entrySourceName, 'shaderFile', `shader.${stageName}.entrySourceName`);
        for (const file of stage.sourceFiles ?? []) {
            collectProjectSearchTerms(target, file?.filename, 'shaderFile', `shader.${stageName}.sourceFiles.filename`);
        }
    }
}

function collectTraceTerms(
    trace: DrawCallTrace,
    passTerms: Map<string, ProjectSearchTerm>,
    markerTerms: Map<string, ProjectSearchTerm>,
    drawTerms: Map<string, ProjectSearchTerm>,
): void {
    trace.markerPath.forEach((marker, index) => {
        const isLeaf = index === trace.markerPath.length - 1;
        collectProjectSearchTerms(
            isLeaf ? passTerms : markerTerms,
            marker,
            isLeaf ? 'passName' : 'markerPath',
            `markerPath[${index}]`,
        );
    });

    collectProjectSearchTerms(drawTerms, trace.event.name, 'drawName', 'event.name');
}

function findDrawCallTraceByEventId(
    drawCalls: DrawCall[],
    eventId: number,
    markerPath: string[] = [],
    fullPath: string[] = [],
): DrawCallTrace | undefined {
    for (const drawCall of drawCalls) {
        const markerNode = isMarkerGroup(drawCall);
        const nextMarkerPath = markerNode ? [...markerPath, drawCall.name] : markerPath;
        const nextFullPath = [...fullPath, drawCall.name];

        if (drawCall.eventId === eventId) {
            return {
                event: drawCall,
                markerPath: nextMarkerPath,
                fullPath: nextFullPath,
            };
        }

        if (drawCall.children?.length) {
            const found = findDrawCallTraceByEventId(drawCall.children, eventId, nextMarkerPath, nextFullPath);
            if (found) {
                return found;
            }
        }
    }

    return undefined;
}

async function searchWorkspaceImplementationCandidates(
    terms: ProjectSearchTerm[],
    includeGlob: string,
    fileLimit: number,
    matchLimit: number,
    category: 'shader' | 'csharp',
): Promise<ProjectImplementationSearchResult> {
    if (terms.length === 0) {
        return {
            category,
            relevantFileCount: 0,
            searchedFileCount: 0,
            matches: [],
        };
    }

    const files = await vscode.workspace.findFiles(includeGlob, PROJECT_SEARCH_EXCLUDE_GLOB, fileLimit);
    const results: ProjectImplementationMatch[] = [];
    const seen = new Set<string>();
    let searchedFileCount = 0;

    for (const uri of files) {
        searchedFileCount++;
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const relativeLower = relativePath.toLowerCase();
        const fileName = path.basename(relativePath);
        const fileNameLower = fileName.toLowerCase();
        const fileStemLower = path.basename(relativePath, path.extname(relativePath)).toLowerCase();

        for (const term of terms) {
            const needle = term.value.toLowerCase();
            const exactFileName = fileNameLower === needle || fileStemLower === needle;
            const fileNameContains = fileNameLower.includes(needle) || fileStemLower.includes(needle) || relativeLower.includes(needle);
            if (!fileNameContains) {
                continue;
            }

            const score = scoreProjectImplementationMatch(category, 'fileName', term, exactFileName);

            pushProjectImplementationMatch(results, seen, {
                category,
                matchKind: 'fileName',
                term: term.value,
                termSource: term.source,
                origin: term.origin,
                file: relativePath,
                score: score.score,
                scoreLabel: projectMatchScoreLabel(score.score),
                reasons: score.reasons,
            });
        }

        const text = await readWorkspaceTextFile(uri);
        if (!text) {
            continue;
        }

        const lines = text.split(/\r?\n/);
        const loweredLines = lines.map((line) => line.toLowerCase());

        for (const term of terms) {
            const needle = term.value.toLowerCase();
            const lineIndex = loweredLines.findIndex((line) => line.includes(needle));
            if (lineIndex === -1) {
                continue;
            }

            const rawLine = lines[lineIndex].trim();
            const exactContent = rawLine === term.value || rawLine.includes(`"${term.value}"`) || rawLine.includes(`'${term.value}'`);
            const score = scoreProjectImplementationMatch(category, 'content', term, exactContent);
            pushProjectImplementationMatch(results, seen, {
                category,
                matchKind: 'content',
                term: term.value,
                termSource: term.source,
                origin: term.origin,
                file: relativePath,
                line: lineIndex + 1,
                preview: rawLine.slice(0, 240),
                score: score.score,
                scoreLabel: projectMatchScoreLabel(score.score),
                reasons: score.reasons,
            });
        }
    }

    results.sort(compareProjectImplementationMatches);
    return {
        category,
        relevantFileCount: files.length,
        searchedFileCount,
        matches: results.slice(0, matchLimit),
    };
}

function pushProjectImplementationMatch(
    results: ProjectImplementationMatch[],
    seen: Set<string>,
    match: ProjectImplementationMatch,
): void {
    const key = `${match.category}|${match.matchKind}|${match.term.toLowerCase()}|${match.termSource}|${match.file}|${match.line ?? 0}`;
    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    results.push(match);
}

function scoreProjectImplementationMatch(
    category: 'shader' | 'csharp',
    matchKind: 'fileName' | 'content',
    term: ProjectSearchTerm,
    exact: boolean,
): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    if (matchKind === 'fileName') {
        if (category === 'shader') {
            if (term.source === 'shaderFile') {
                score += 340;
                reasons.push('shader file name match');
            } else if (term.source === 'shaderName') {
                score += 300;
                reasons.push('shader asset/name matched a shader file path');
            } else if (term.source === 'passName') {
                score += 180;
                reasons.push('pass name matched inside shader file path');
            } else if (term.source === 'additional') {
                score += 120;
                reasons.push('additional term matched a shader file path');
            } else {
                score += 80;
                reasons.push('secondary term matched a shader file path');
            }
        } else {
            if (term.source === 'passName') {
                score += 220;
                reasons.push('pass name matched a C# file path');
            } else if (term.source === 'shaderName' || term.source === 'shaderFile') {
                score += 150;
                reasons.push('shader identifier matched a C# file path');
            } else if (term.source === 'markerPath') {
                score += 130;
                reasons.push('marker path matched a C# file path');
            } else if (term.source === 'drawName') {
                score += 100;
                reasons.push('draw name matched a C# file path');
            } else {
                score += 90;
                reasons.push('additional term matched a C# file path');
            }
        }
    } else {
        if (category === 'csharp') {
            if (term.source === 'passName') {
                score += 280;
                reasons.push('C# pass string hit');
            } else if (term.source === 'markerPath') {
                score += 190;
                reasons.push('marker path hit in C# content');
            } else if (term.source === 'shaderName' || term.source === 'shaderFile') {
                score += 150;
                reasons.push('shader identifier hit in C# content');
            } else if (term.source === 'drawName') {
                score += 120;
                reasons.push('draw name hit in C# content');
            } else {
                score += 100;
                reasons.push('additional term hit in C# content');
            }
        } else {
            if (term.source === 'shaderFile') {
                score += 240;
                reasons.push('shader file-derived term hit in shader content');
            } else if (term.source === 'shaderName') {
                score += 210;
                reasons.push('shader name hit in shader content');
            } else if (term.source === 'passName') {
                score += 170;
                reasons.push('pass name hit in shader content');
            } else if (term.source === 'additional') {
                score += 100;
                reasons.push('additional term hit in shader content');
            } else {
                score += 80;
                reasons.push('secondary term hit in shader content');
            }
        }
    }

    if (exact) {
        score += 50;
        reasons.push('exact text match');
    }

    return { score, reasons };
}

function projectMatchScoreLabel(score: number): 'high' | 'medium' | 'low' {
    if (score >= 320) {
        return 'high';
    }
    if (score >= 200) {
        return 'medium';
    }
    return 'low';
}

function compareProjectImplementationMatches(left: ProjectImplementationMatch, right: ProjectImplementationMatch): number {
    return right.score - left.score
        || projectSearchTermPriority(right.termSource) - projectSearchTermPriority(left.termSource)
        || left.file.localeCompare(right.file)
        || (left.line ?? 0) - (right.line ?? 0);
}

function assessWorkspaceCompatibility(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    shaderSearch: ProjectImplementationSearchResult,
    csharpSearch: ProjectImplementationSearchResult,
    prioritizedMatches: ProjectImplementationMatch[],
): WorkspaceCompatibility {
    if (workspaceFolders.length === 0) {
        return {
            status: 'noWorkspace',
            likelyProjectWorkspace: false,
            summary: 'No project workspace is open.',
            shaderFileCount: 0,
            csharpFileCount: 0,
            suggestions: ['Open the game or rendering project folder in this workspace.'],
        };
    }

    const shaderFileCount = shaderSearch.relevantFileCount;
    const csharpFileCount = csharpSearch.relevantFileCount;
    const totalMatches = prioritizedMatches.length;
    const hasHighSignal = prioritizedMatches.some((match) => match.scoreLabel === 'high');

    if (shaderFileCount === 0 && csharpFileCount === 0) {
        return {
            status: 'noRelevantFiles',
            likelyProjectWorkspace: false,
            summary: 'The current workspace does not contain shader files or C# source files that look relevant to rendering implementation lookup.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Open the actual game/rendering project workspace instead of a tools-only or extension-only folder.',
                'If the project lives in another repo, add that folder to the current VS Code workspace.',
            ],
        };
    }

    if (totalMatches === 0) {
        return {
            status: 'weakMatch',
            likelyProjectWorkspace: false,
            summary: 'The workspace has shader or C# files, but none matched the derived shader/pass/marker terms. The opened folder may be unrelated, or runtime names may differ from source names.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Open the actual engine/game project if a different folder is currently active.',
                'Provide an explicit shaderName or passName if runtime names differ from source names.',
                'Check whether capture markers/pass names are too generic to map directly.',
            ],
        };
    }

    if (!hasHighSignal || shaderFileCount === 0 || csharpFileCount === 0) {
        return {
            status: 'partial',
            likelyProjectWorkspace: true,
            summary: 'The workspace looks usable, but the mapping signal is only partial. Results may be correct, but they should be treated as candidates rather than a confirmed source location.',
            shaderFileCount,
            csharpFileCount,
            suggestions: [
                'Prefer the highest-scoring matches first.',
                'If pass names are weak, try a more specific shaderName or a narrower eventId.',
            ],
        };
    }

    return {
        status: 'ready',
        likelyProjectWorkspace: true,
        summary: 'The workspace looks relevant and the highest-ranked matches have strong shader/pass mapping signals.',
        shaderFileCount,
        csharpFileCount,
        suggestions: ['Start from prioritizedMatches before exploring lower-ranked candidates.'],
    };
}

async function readWorkspaceTextFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > PROJECT_MAX_FILE_SIZE_BYTES) {
            return undefined;
        }

        const data = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(data).toString('utf8');
    } catch {
        return undefined;
    }
}

function filterDrawCallsAdvanced(drawCalls: DrawCall[], opts: AdvancedFilterOptions, ancestorMarkerMatch = false): DrawCall[] {
    const result: DrawCall[] = [];
    const markerLower = opts.markerFilter?.toLowerCase();

    for (const dc of drawCalls) {
        // Determine if this node's marker name matches the markerFilter
        const selfMarkerMatch = markerLower ? dc.name.toLowerCase().includes(markerLower) : false;
        // Propagate match downward: once inside a matching marker subtree, all descendants qualify
        const inMarkerScope = ancestorMarkerMatch || selfMarkerMatch;

        // Recurse into children first (depth-first)
        const filteredChildren = dc.children?.length
            ? filterDrawCallsAdvanced(dc.children, opts, inMarkerScope)
            : [];

        // Evaluate this node
        const passesEventIdMin = opts.eventIdMin === undefined || dc.eventId >= opts.eventIdMin;
        const passesEventIdMax = opts.eventIdMax === undefined || dc.eventId <= opts.eventIdMax;
        const passesOnlyDrawCalls = !opts.onlyDrawCalls || isRealDrawCall(dc.flags);
        const passesExcludeMarkers = !opts.excludeMarkers || !isMarkerGroup(dc);
        const passesExcludeDebug = !opts.excludeDebugMarkers || !isDebugMarker(dc);
        const passesExcludeEmpty = !opts.excludeEmptyOperations || !isEmptyOperation(dc);
        const passesMarkerFilter = !markerLower || inMarkerScope || filteredChildren.length > 0;

        if (passesEventIdMin && passesEventIdMax && passesOnlyDrawCalls && passesExcludeMarkers && passesExcludeDebug && passesExcludeEmpty && passesMarkerFilter) {
            // Produce a copy with filtered children
            result.push({ ...dc, children: filteredChildren });
        } else if (filteredChildren.length > 0) {
            // This node didn't pass but its children did — promote children
            result.push(...filteredChildren);
        }
    }
    return result;
}

function isDebugMarker(dc: DrawCall): boolean {
    const name = dc.name.toLowerCase();
    return isMarkerGroup(dc) && (name.includes('debug') || name.includes('marker') || name.startsWith('rdoc'));
}

function isEmptyOperation(dc: DrawCall): boolean {
    return !dc.children?.length && isRealDrawCall(dc.flags) && (dc.numIndices ?? 0) === 0 && (dc.numInstances ?? 0) === 0;
}

function findDrawCallByEventId(drawCalls: DrawCall[], eventId: number): DrawCall | undefined {
    for (const dc of drawCalls) {
        if (dc.eventId === eventId) { return dc; }
        if (dc.children?.length) {
            const found = findDrawCallByEventId(dc.children, eventId);
            if (found) { return found; }
        }
    }
    return undefined;
}

interface DrawCallSummary {
    totalCount: number;
    drawCount: number;
    clearCount: number;
    dispatchCount: number;
    otherCount: number;
    topLevelGroups: number;
    /** Compact top-level tree (children stripped to childCount) for context efficiency. */
    tree: CompactDrawCall[];
    /** Flat leaf-level draw calls (no children), capped at 100. */
    drawCalls: FlatDrawCall[];
    /** Top 50 most expensive draw calls (sorted by durationUs, if available). Use this for performance and timing questions! */
    expensiveDraws?: FlatDrawCall[];
    truncated: boolean;
}

interface FlatDrawCall {
    eventId: number;
    name: string;
    flags: string;
    numIndices: number;
    numInstances: number;
    durationUs?: number;
}

interface CompactDrawCall {
    eventId: number;
    name: string;
    childCount: number;
    children?: CompactDrawCall[];
}

const FLAT_LIMIT = 100;
/**
 * Compact tree depth: 0 = camera/top-level groups, 1 = render-pass sub-groups.
 * At depth >= TREE_DEPTH_LIMIT children are replaced by childCount only.
 * Keeping this at 2 means the tree expands Camera→Pass→(count) — enough for a
 * render-flow diagram without listing every individual draw call.
 */
const TREE_DEPTH_LIMIT = 2;

function toCompactTree(list: DrawCall[], depth = 0): CompactDrawCall[] {
    return list.map(dc => {
        const node: CompactDrawCall = {
            eventId: dc.eventId,
            name: dc.name,
            childCount: dc.children?.length ?? 0,
        };
        if (dc.children?.length && depth < TREE_DEPTH_LIMIT) {
            node.children = toCompactTree(dc.children, depth + 1);
        }
        return node;
    });
}

function summarizeDrawCalls(drawCalls: DrawCall[]): DrawCallSummary {
    let drawCount = 0, clearCount = 0, dispatchCount = 0, otherCount = 0;
    const flat: FlatDrawCall[] = [];

    function walk(list: DrawCall[]) {
        for (const dc of list) {
            // Strip children to avoid recursive duplication in flat list
            const { children, ...rest } = dc;
            flat.push(rest);
            const lower = dc.name.toLowerCase();
            if (lower.includes('draw')) { drawCount++; }
            else if (lower.includes('clear')) { clearCount++; }
            else if (lower.includes('dispatch')) { dispatchCount++; }
            else { otherCount++; }
            if (children?.length) { walk(children); }
        }
    }
    walk(drawCalls);

    const expensiveDraws = flat
        .filter(dc => typeof dc.durationUs === 'number')
        .sort((a, b) => b.durationUs! - a.durationUs!)
        .slice(0, 50);

    return {
        totalCount: flat.length,
        drawCount,
        clearCount,
        dispatchCount,
        otherCount,
        topLevelGroups: drawCalls.length,
        tree: toCompactTree(drawCalls),
        drawCalls: flat.slice(0, FLAT_LIMIT),
        expensiveDraws: expensiveDraws.length > 0 ? expensiveDraws : undefined,
        truncated: flat.length > FLAT_LIMIT,
    };
}

function buildFrameAnalysis(info: CaptureInfo, drawCalls: DrawCall[], resources: ResourceInfo[]) {
    const dcSummary = summarizeDrawCalls(drawCalls);
    const textures = resources.filter(r => r.type === 'Texture');
    const buffers = resources.filter(r => r.type === 'Buffer');
    const shaders = resources.filter(r => r.type === 'Shader');

    const largeTextures = textures.filter(r => r.width >= 2048 || r.height >= 2048);
    const totalTextureBytes = textures.reduce((sum, t) => sum + (t.byteSize || 0), 0);
    const totalBufferBytes = buffers.reduce((sum, b) => sum + (b.byteSize || 0), 0);

    return {
        capture: {
            api: info.api,
            driver: info.driver,
            rdocVersion: info.rdocVersion,
        },
        drawCalls: {
            total: dcSummary.totalCount,
            draws: dcSummary.drawCount,
            clears: dcSummary.clearCount,
            dispatches: dcSummary.dispatchCount,
        },
        resources: {
            textureCount: textures.length,
            bufferCount: buffers.length,
            shaderCount: shaders.length,
            largeTextureCount: largeTextures.length,
            largeTextures: largeTextures.map(t => ({
                name: t.name,
                dimensions: `${t.width}x${t.height}`,
                format: t.format,
                byteSize: t.byteSize,
            })),
            totalTextureMemory: totalTextureBytes,
            totalBufferMemory: totalBufferBytes,
        },
        potentialIssues: detectIssues(dcSummary, textures),
    };
}

function detectIssues(
    drawCalls: DrawCallSummary,
    textures: ResourceInfo[],
): string[] {
    const issues: string[] = [];

    if (drawCalls.totalCount > 500) {
        issues.push(`High draw call count (${drawCalls.totalCount}). Consider batching or instancing.`);
    }
    if (drawCalls.clearCount > 10) {
        issues.push(`${drawCalls.clearCount} clear operations detected. Check if all render targets need clearing.`);
    }

    const hugeTextures = textures.filter(t => t.width >= 4096 || t.height >= 4096);
    if (hugeTextures.length > 0) {
        issues.push(`${hugeTextures.length} textures are 4K+ resolution. Consider mipmapping or downscaling.`);
    }

    const totalTexMB = textures.reduce((s, t) => s + (t.byteSize || 0), 0) / (1024 * 1024);
    if (totalTexMB > 256) {
        issues.push(`Total texture memory is ${totalTexMB.toFixed(0)} MB. Consider texture compression or atlasing.`);
    }

    return issues;
}

// ─── Tool: Get Selection Context ────────────────────────────────────────────
export class GetSelectionContextTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const capturePath = _getCurrentCapturePath();
        const selection = _getSelectionContext();

        // Inspector panel represents "what the user is looking at right now".
        // Its focused event takes precedence over sidebar selection when present.
        const inspector = InspectorPanel.currentPanel;
        const inspectorEventId = inspector?.getCurrentEventId();
        const inspectorDrawCall = inspector?.getCurrentDrawCall();
        const latestMaliAnalysis = inspector?.getLatestMaliAnalysisResult();

        const focusedEventId = inspectorEventId ?? selection.selectedDrawCall?.eventId;
        const focusedDrawCall = inspectorDrawCall ?? selection.selectedDrawCall;

        const context: any = {
            captureLoaded: !!capturePath,
            capturePath: capturePath ?? null,
            hasNativeBridge: _bridge.hasNativeBridge(),
            inspectorOpen: !!inspector,
            focusedEventId: focusedEventId ?? null,
            focusedDrawCall: focusedDrawCall ?? null,
            sidebarSelectedResource: selection.selectedResource ?? null,
            latestMaliAnalysis: latestMaliAnalysis ?? null,
        };

        // Enrich with pipeline state and bound-shader summary for the focused event.
        // We deliberately do NOT include full shader source here — the model should
        // call renderdoc_getShaderSource explicitly when it needs to read code.
        if (focusedEventId !== undefined && focusedEventId !== null && _bridge.hasNativeBridge()) {
            try {
                const pipelineState = await _bridge.nativeGetPipelineState(focusedEventId);
                context.pipelineState = pipelineState;
            } catch (e: any) {
                context.pipelineStateError = e.message;
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(context, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Reading current selection context…' };
    }
}

// ─── Tool: Get Mesh Data ─────────────────────────────────────────────────────
interface GetMeshDataInput {
    eventId: number;
    /** 'vsin' = vertex shader input, 'vsout' = post-VS, 'gsout' = post-GS. Default: 'vsin' */
    stage?: 'vsin' | 'vsout' | 'gsout';
    /** Max vertices to return in 'rows'. Copilot default: 32. UI default: 256. */
    maxVertices?: number;
    /** Instance index (for instanced draws). Default: 0 */
    instance?: number;
}

export class GetMeshDataTool implements vscode.LanguageModelTool<GetMeshDataInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetMeshDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { eventId, stage = 'vsin', maxVertices: requestedMaxVertices = 32, instance = 0 } = options.input;
        const maxVertices = Math.min(4096, Math.max(1, requestedMaxVertices));
        const raw = await _bridge.nativeGetMeshData(eventId, stage, { maxVertices, instance });

        // Topology enum → readable string (mirrors RenderDoc Topology enum order)
        const TOPOLOGY = ['Unknown','PointList','LineList','LineStrip','TriangleList','TriangleStrip',
            'LineList_Adj','LineStrip_Adj','TriangleList_Adj','TriangleStrip_Adj',
            'PatchList_1CPs','PatchList_2CPs','PatchList_3CPs','PatchList_4CPs',
            'PatchList_5CPs','PatchList_6CPs','PatchList_7CPs','PatchList_8CPs',
            'PatchList_9CPs','PatchList_10CPs','PatchList_11CPs','PatchList_12CPs',
            'PatchList_13CPs','PatchList_14CPs','PatchList_15CPs','PatchList_16CPs',
        ];
        const topoStr = TOPOLOGY[raw.topology] ?? `Topology(${raw.topology})`;

        // Build a compact summary instead of dumping all raw rows
        const attrs: Array<{ name: string; format: string; used: boolean; perInstance: boolean }> =
            (raw.attributes ?? []).map((a: any) => ({
                name: a.name,
                format: a.format,
                used: a.used,
                perInstance: a.perInstance,
            }));

        // Build human-readable rows: { vtx, idx?, [attrName]: [values] }
        const attrNames: string[] = (raw.attributes ?? []).map((a: any) => a.name as string);
        const rows = (raw.rows ?? []).map((r: any) => {
            const row: Record<string, unknown> = { vtx: r.vtx };
            if (r.idx !== undefined) { row.idx = r.idx; }
            if (r.restart) { row.restart = true; }
            (r.cols ?? []).forEach((vals: number[], k: number) => {
                row[attrNames[k] ?? `attr${k}`] = vals.length === 1 ? vals[0] : vals;
            });
            return row;
        });

        const summary = {
            eventId: raw.eventId,
            stage,
            topology: topoStr,
            totalVertices: raw.totalIndices,
            returnedVertices: raw.returnedIndices,
            indexed: raw.indexByteStride > 0,
            indexByteStride: raw.indexByteStride || undefined,
            attributes: attrs,
            rows,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetMeshDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const stage = options.input?.stage ?? 'vsin';
        return { invocationMessage: `Reading mesh data (${stage}) at EID ${options.input?.eventId}…` };
    }
}

// ─── Reverse-search cache ────────────────────────────────────────────────────
// Lazily built per capture path. Maps bound resource names/IDs to event IDs.
interface ReverseSearchIndex {
    capturePath: string;
    // shaderKey → eventIds (key is lowercased shader name or entry point)
    byShader: Map<string, number[]>;
    // textureKey → eventIds
    byTexture: Map<string, number[]>;
    // resourceId string → eventIds
    byResourceId: Map<string, number[]>;
}

let _reverseSearchIndex: ReverseSearchIndex | null = null;

async function buildReverseIndex(capturePath: string): Promise<ReverseSearchIndex> {
    if (_reverseSearchIndex?.capturePath === capturePath) {
        return _reverseSearchIndex;
    }

    const idx: ReverseSearchIndex = {
        capturePath,
        byShader: new Map(),
        byTexture: new Map(),
        byResourceId: new Map(),
    };

    // Collect all leaf draw events
    let drawCalls = _getCurrentDrawCalls();
    if (drawCalls.length === 0) {
        drawCalls = await _bridge.getDrawCalls(capturePath);
    }
    const leafEvents: number[] = [];
    function collectLeaves(list: DrawCall[]) {
        for (const dc of list) {
            if (dc.children?.length) {
                collectLeaves(dc.children);
            } else {
                leafEvents.push(dc.eventId);
            }
        }
    }
    collectLeaves(drawCalls);

    function addTo(map: Map<string, number[]>, key: string, eid: number) {
        const k = key.toLowerCase();
        if (!map.has(k)) { map.set(k, []); }
        map.get(k)!.push(eid);
    }

    // Iterate leaf events and collect pipeline state bindings
    for (const eid of leafEvents) {
        try {
            const ps = await _bridge.nativeGetPipelineState(eid);
            // Shader stages: try Vulkan, D3D11, D3D12, GL structures
            const stages: any[] = [];
            if (ps.vulkan?.shaderStages) { stages.push(...ps.vulkan.shaderStages); }
            else if (ps.d3d12?.shaderStages) { stages.push(...ps.d3d12.shaderStages); }
            else if (ps.d3d11?.shaderStages) { stages.push(...ps.d3d11.shaderStages); }
            else if (ps.openGL?.shaderStages) { stages.push(...ps.openGL.shaderStages); }
            // Also check flat shaderStages in case structure differs
            if (ps.shaderStages) { stages.push(...ps.shaderStages); }

            for (const stage of stages) {
                if (stage.shaderName) { addTo(idx.byShader, stage.shaderName, eid); }
                if (stage.entryPoint) { addTo(idx.byShader, stage.entryPoint, eid); }
                if (stage.resourceId) { addTo(idx.byResourceId, String(stage.resourceId), eid); }
                // Bound textures/resources in this stage
                for (const res of (stage.resources ?? [])) {
                    if (res.resourceId) { addTo(idx.byResourceId, String(res.resourceId), eid); }
                    if (res.name) { addTo(idx.byTexture, res.name, eid); }
                }
                for (const res of (stage.readOnlyResources ?? [])) {
                    if (res.resourceId) { addTo(idx.byResourceId, String(res.resourceId), eid); }
                    if (res.name) { addTo(idx.byTexture, res.name, eid); }
                }
            }
        } catch { /* skip events where pipeline state is unavailable */ }
    }

    _reverseSearchIndex = idx;
    return idx;
}

// ─── Tool: Get Frame Summary ─────────────────────────────────────────────────
export class GetFrameSummaryTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        requireCapturePath();

        // Combine statistics + root actions for a concise frame overview
        let stats: any = null;
        let rootMarkers: any[] = [];

        if (_bridge.hasNativeBridge()) {
            try {
                stats = await _bridge.nativeGetCaptureStatistics();
            } catch { /* non-fatal */ }
            try {
                const roots = await _bridge.nativeGetRootActions();
                // roots is an array of top-level action nodes
                const actionList: any[] = Array.isArray(roots) ? roots : (roots?.actions ?? []);
                rootMarkers = actionList.map((a: any) => ({
                    eventId: a.eventId,
                    name: a.name,
                    flags: a.flags,
                    childCount: (a.children ?? []).length,
                }));
            } catch { /* non-fatal */ }
        }

        const drawCalls = _getCurrentDrawCalls();
        let drawCount = 0, dispatchCount = 0, clearCount = 0, totalCount = 0;
        function countLeaves(list: DrawCall[]) {
            for (const dc of list) {
                if (dc.children?.length) { countLeaves(dc.children); }
                else {
                    totalCount++;
                    const f = dc.flags.toLowerCase();
                    if (f.includes('drawcall') || f.includes('meshdispatch')) { drawCount++; }
                    else if (f.includes('dispatch')) { dispatchCount++; }
                    else if (f.includes('clear')) { clearCount++; }
                }
            }
        }
        countLeaves(drawCalls);

        const summary = {
            topLevelPasses: rootMarkers,
            leafCounts: { total: totalCount, draws: drawCount, dispatches: dispatchCount, clears: clearCount },
            statistics: stats ?? 'Native bridge required',
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Building frame summary…' };
    }
}

// ─── Tool: Find Draws by Shader ───────────────────────────────────────────────
interface FindDrawsByShaderInput {
    /** Shader name or entry point substring to search (case-insensitive). */
    shaderName: string;
}

export class FindDrawsByShaderTool implements vscode.LanguageModelTool<FindDrawsByShaderInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByShaderInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse shader search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const needle = options.input.shaderName.toLowerCase();
        const idx = await buildReverseIndex(capturePath);

        const matchedEventIds: number[] = [];
        for (const [key, eids] of idx.byShader) {
            if (key.includes(needle)) {
                for (const eid of eids) {
                    if (!matchedEventIds.includes(eid)) { matchedEventIds.push(eid); }
                }
            }
        }
        matchedEventIds.sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                query: options.input.shaderName,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByShaderInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws by shader "${options.input?.shaderName}"…` };
    }
}

// ─── Tool: Find Draws by Texture ──────────────────────────────────────────────
interface FindDrawsByTextureInput {
    /** Texture name substring to search (case-insensitive). */
    textureName: string;
}

export class FindDrawsByTextureTool implements vscode.LanguageModelTool<FindDrawsByTextureInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByTextureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse texture search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const needle = options.input.textureName.toLowerCase();
        const idx = await buildReverseIndex(capturePath);

        const matchedEventIds: number[] = [];
        for (const [key, eids] of idx.byTexture) {
            if (key.includes(needle)) {
                for (const eid of eids) {
                    if (!matchedEventIds.includes(eid)) { matchedEventIds.push(eid); }
                }
            }
        }
        matchedEventIds.sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                query: options.input.textureName,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByTextureInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws by texture "${options.input?.textureName}"…` };
    }
}

// ─── Tool: Find Draws by Resource ID ─────────────────────────────────────────
interface FindDrawsByResourceIdInput {
    /** Resource ID string to search for. */
    resourceId: string;
}

export class FindDrawsByResourceIdTool implements vscode.LanguageModelTool<FindDrawsByResourceIdInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindDrawsByResourceIdInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Reverse resource search requires the RenderDoc native bridge.'),
            ]);
        }
        const capturePath = requireCapturePath();
        const idx = await buildReverseIndex(capturePath);

        const key = options.input.resourceId.toLowerCase();
        const matchedEventIds = (idx.byResourceId.get(key) ?? []).slice().sort((a, b) => a - b);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                resourceId: options.input.resourceId,
                matchCount: matchedEventIds.length,
                eventIds: matchedEventIds,
            }, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindDrawsByResourceIdInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching draws that use resource ${options.input?.resourceId}…` };
    }
}

// ─── Tool: Get Texture Data ───────────────────────────────────────────────────
interface GetTextureDataInput {
    /** Resource ID of the texture. */
    textureId: string;
    /** Mip level. Defaults to 0 (largest mip). */
    mip?: number;
    /** Event ID at which to sample the texture (0 = end of frame). */
    eventId?: number;
    /** Channel to extract: -1=all, 0=R, 1=G, 2=B, 3=A. Default: -1 */
    channelExtract?: number;
}

export class GetTextureDataTool implements vscode.LanguageModelTool<GetTextureDataInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTextureDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Texture data sampling requires the RenderDoc native bridge.'),
            ]);
        }

        const { textureId, mip = 0, eventId = 0, channelExtract = -1 } = options.input;
        const result = await _bridge.nativeGetTextureData(textureId, mip, eventId, channelExtract);

        // Return metadata + base64 data; suppress raw base64 if very large
        const summary: any = {
            resourceId: result.resourceId ?? textureId,
            width: result.width,
            height: result.height,
            format: result.format,
            mip,
            eventId,
            channelExtract,
            base64Length: result.base64?.length ?? 0,
            base64: result.base64 && result.base64.length <= 1024 * 1024 ? result.base64 : undefined,
            dataTruncated: !!result.base64 && result.base64.length > 1024 * 1024,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetTextureDataInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Sampling texture ${options.input?.textureId} at mip ${options.input?.mip ?? 0}…` };
    }
}

// ─── Tool: Get Buffer Contents ────────────────────────────────────────────────
interface GetBufferContentsInput {
    /** Resource ID of the buffer. */
    resourceId: string;
    /** Byte offset into the buffer. Default: 0 */
    offset?: number;
    /** Number of bytes to read. Default: 4096. Max: 65536. */
    len?: number;
    /** Event ID at which to read the buffer (0 = end of frame). */
    eventId?: number;
}

export class GetBufferContentsTool implements vscode.LanguageModelTool<GetBufferContentsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetBufferContentsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Buffer contents reading requires the RenderDoc native bridge.'),
            ]);
        }

        const { resourceId, offset: requestedOffset = 0, len: requestedLen = 4096, eventId = 0 } = options.input;
        const offset = Math.max(0, requestedOffset);
        const len = Math.min(65536, Math.max(1, requestedLen));
        const result = await _bridge.nativeGetBufferContents(resourceId, offset, len, eventId);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetBufferContentsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const len = options.input?.len ?? 4096;
        return { invocationMessage: `Reading ${len} bytes from buffer ${options.input?.resourceId}…` };
    }
}

// ─── Tool: Get Replay Status ─────────────────────────────────────────────────
export class GetReplayStatusTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const capturePath = _getCurrentCapturePath();
        const hasNative = _bridge.hasNativeBridge();
        const replayState = _getReplayState?.();

        const replayActive = replayState?.replayStatus === 'active';
        const replayMode = replayState?.replayMode ?? 'none';

        const capabilities = {
            pipelineState: hasNative && replayActive,
            shaderSource: hasNative && replayActive,
            shaderInfo: hasNative && replayActive,
            meshData: hasNative && replayActive,
            textureData: hasNative && replayActive,
            bufferContents: hasNative && replayActive,
            eventChunks: hasNative && replayActive,
            currentDrawPreview: hasNative && replayActive,
        };

        let message: string;
        if (!capturePath) {
            message = 'No capture is currently loaded.';
        } else if (!hasNative) {
            message = 'Capture is loaded but the native bridge is not running. Replay-dependent tools are unavailable.';
        } else if (!replayActive) {
            message = `Capture is loaded and native bridge is running, but replay is not active (status: ${replayState?.replayStatus ?? 'unknown'}).`;
        } else {
            message = `${replayMode === 'remote' ? 'Remote' : 'Local'} replay is active.`;
        }

        const result = {
            captureLoaded: !!capturePath,
            capturePath: capturePath ?? null,
            nativeBridgeRunning: hasNative,
            replayActive,
            replayMode,
            capabilities,
            message,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Checking replay status…' };
    }
}

// ─── Tool: Get Bound Resources ─────────────────────────────────────────────────
interface GetBoundResourcesInput {
    eventId: number;
    includeUnused?: boolean;
    includeConstantBuffers?: boolean;
}

export class GetBoundResourcesTool implements vscode.LanguageModelTool<GetBoundResourcesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetBoundResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Bound resource inspection requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const eventId = options.input.eventId;
        const includeConstantBuffers = options.input.includeConstantBuffers ?? true;
        const includeUnused = options.input.includeUnused ?? true;

        let pipelineState: any;
        try {
            pipelineState = await _bridge.nativeGetPipelineState(eventId);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId,
                    reason: err.message ?? 'Failed to get pipeline state.',
                }, null, 2)),
            ]);
        }

        const result = normalizeBoundResources(pipelineState, { includeConstantBuffers, includeUnused });
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetBoundResourcesInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Loading bound resources at EID ${_options.input.eventId}…` };
    }
}

function normalizeBoundResources(pipelineState: any, opts: { includeConstantBuffers: boolean; includeUnused: boolean }): any {
    if (!pipelineState || typeof pipelineState !== 'object') {
        return { available: false, reason: 'Pipeline state is empty or invalid.' };
    }

    const api = pipelineState.api ?? 'Unknown';
    const stageResources = pipelineState.stageResources ?? {};
    const shaders = pipelineState.shaders ?? {};

    // Render targets
    const outputMerger = pipelineState.outputMerger ?? pipelineState.om ?? {};
    const renderTargets: any[] = [];
    const rtArray = outputMerger.renderTargets ?? outputMerger.colorTargets ?? [];
    if (Array.isArray(rtArray)) {
        for (const rt of rtArray) {
            if (rt && rt.resourceId != null) {
                renderTargets.push({
                    slot: rt.slot ?? renderTargets.length,
                    resourceId: String(rt.resourceId),
                    name: rt.resourceName ?? rt.name ?? '',
                    format: rt.format ?? '',
                    width: rt.width ?? 0,
                    height: rt.height ?? 0,
                });
            }
        }
    }

    // Depth target
    let depthTarget: any = null;
    const dt = outputMerger.depthTarget ?? outputMerger.depthStencilTarget ?? null;
    if (dt && dt.resourceId != null) {
        depthTarget = {
            resourceId: String(dt.resourceId),
            name: dt.resourceName ?? dt.name ?? '',
            format: dt.format ?? '',
            width: dt.width ?? 0,
            height: dt.height ?? 0,
        };
    }

    // Stages
    const stageOrder = ['vertex', 'hull', 'domain', 'geometry', 'fragment', 'pixel', 'compute'];
    const stages: any[] = [];
    const seenStages = new Set<string>();

    for (const stageKey of stageOrder) {
        const resources = stageResources[stageKey];
        const shader = shaders[stageKey];
        if (!resources && !shader) { continue; }
        const normalizedKey = stageKey === 'pixel' ? 'Fragment' : stageKey.charAt(0).toUpperCase() + stageKey.slice(1);
        if (seenStages.has(normalizedKey)) { continue; }
        seenStages.add(normalizedKey);

        const res = resources ?? {};
        const stageEntry: any = {
            stage: normalizedKey,
            shaderName: shader?.name ?? shader?.entryPoint ?? '',
            readOnlyTextures: summarizeBoundResources(res.textures, 'read', opts.includeUnused),
            readWriteTextures: summarizeBoundResources(res.readWriteTextures ?? res.uavTextures, 'rw', opts.includeUnused),
            buffers: summarizeBoundResources(res.buffers, 'read', opts.includeUnused),
            samplers: summarizeSamplers(res.samplers),
        };

        if (opts.includeConstantBuffers) {
            stageEntry.constantBuffers = summarizeConstantBlockMetadata(res.constantBlocks);
        }

        stages.push(stageEntry);
    }

    // Resource counts
    let sampledTextures = 0, storageTextures = 0, buffers = 0, samplers = 0, constantBuffers = 0;
    for (const stage of stages) {
        sampledTextures += stage.readOnlyTextures?.length ?? 0;
        storageTextures += stage.readWriteTextures?.length ?? 0;
        buffers += stage.buffers?.length ?? 0;
        samplers += stage.samplers?.length ?? 0;
        constantBuffers += stage.constantBuffers?.length ?? 0;
    }

    return {
        available: true,
        eventId: pipelineState.eventId ?? null,
        api,
        renderTargets,
        depthTarget,
        stages,
        resourceCounts: {
            renderTargets: renderTargets.length,
            sampledTextures,
            storageTextures,
            buffers,
            samplers,
            constantBuffers,
        },
    };
}

function summarizeBoundResources(entries: any, _kind: string, includeUnused: boolean): any[] {
    if (!Array.isArray(entries)) { return []; }
    const filtered = includeUnused ? entries : entries.filter((entry: any) => !entry?.staticallyUnused);
    return filtered.map((entry) => ({
        name: entry.name ?? '',
        slot: entry.slot,
        space: entry.space,
        resourceId: entry.resourceId != null ? String(entry.resourceId) : null,
        resourceName: entry.resourceName ?? '',
        format: entry.format ?? '',
        width: entry.width ?? 0,
        height: entry.height ?? 0,
        byteSize: entry.byteSize ?? 0,
        staticallyUnused: entry.staticallyUnused ?? false,
    }));
}

function summarizeSamplers(entries: any): any[] {
    if (!Array.isArray(entries)) { return []; }
    return entries.map((entry) => ({
        name: entry.name ?? '',
        slot: entry.slot,
        space: entry.space,
        resourceId: entry.resourceId != null ? String(entry.resourceId) : null,
        resourceName: entry.resourceName ?? '',
        minFilter: entry.minFilter ?? '',
        magFilter: entry.magFilter ?? '',
        addressU: entry.addressU ?? '',
        addressV: entry.addressV ?? '',
    }));
}

// ─── Tool: Get Event Chunks ─────────────────────────────────────────────────
interface GetEventChunksInput {
    eventId: number;
}

export class GetEventChunksTool implements vscode.LanguageModelTool<GetEventChunksInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetEventChunksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Event chunks require the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const eventId = options.input.eventId;
        try {
            const result = await _bridge.nativeGetEventChunks(eventId);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: true,
                    eventId: result.eventId,
                    chunkCount: result.chunks?.length ?? 0,
                    chunks: result.chunks ?? [],
                }, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId,
                    reason: err.message ?? 'Failed to get event chunks.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetEventChunksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Loading API event chunks for EID ${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Current Draw Preview ─────────────────────────────────────────
interface GetCurrentDrawPreviewInput {
    eventId: number;
    channelExtract?: number;
    overlayMode?: string;
    resourceId?: string;
    overlayResourceId?: string;
}

export class GetCurrentDrawPreviewTool implements vscode.LanguageModelTool<GetCurrentDrawPreviewInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetCurrentDrawPreviewInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Current draw preview requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const { eventId, channelExtract = -1, overlayMode = 'none', resourceId, overlayResourceId } = options.input;

        try {
            const result = await _bridge.nativeGetCurrentDrawPreview(
                eventId,
                channelExtract,
                overlayMode as any,
                true,
                resourceId,
                overlayResourceId,
            );

            if (!result || !result.base64) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        available: false,
                        eventId,
                        reason: 'No preview image was returned for this event.',
                    }, null, 2)),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: true,
                    eventId,
                    resourceId: result.resourceId ?? null,
                    label: result.label ?? '',
                    width: result.width ?? 0,
                    height: result.height ?? 0,
                    format: result.format ?? 'png',
                    overlayMode,
                    base64: result.base64,
                }, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId,
                    reason: err.message ?? 'Failed to get current draw preview.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetCurrentDrawPreviewInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Rendering current draw preview at EID ${_options.input.eventId}…` };
    }
}

// ─── Tool: Trace Resource Usage ─────────────────────────────────────────────
interface TraceResourceUsageInput {
    resourceId: string;
    maxEvents?: number;
}

export class TraceResourceUsageTool implements vscode.LanguageModelTool<TraceResourceUsageInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TraceResourceUsageInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Resource usage tracing requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const { resourceId, maxEvents = 50 } = options.input;
        const capturePath = requireCapturePath();

        try {
            // Get all draw calls
            const drawCalls = await _bridge.getDrawCalls(capturePath);
            
            // Find all events that reference this resource
            const usageEvents: Array<{
                eventId: number;
                name: string;
                usageType: string;
                stage?: string;
                slot?: number;
            }> = [];

            const searchResource = async (events: DrawCall[]) => {
                for (const event of events) {
                    if (usageEvents.length >= maxEvents) break;
                    
                    try {
                        const pipelineState = await _bridge.nativeGetPipelineState(event.eventId);
                        if (!pipelineState) continue;

                        // Check render targets
                        const outputMerger = pipelineState.outputMerger ?? pipelineState.om ?? {};
                        const renderTargets = outputMerger.renderTargets ?? outputMerger.colorTargets ?? [];
                        if (Array.isArray(renderTargets)) {
                            for (const rt of renderTargets) {
                                if (rt && String(rt.resourceId) === resourceId) {
                                    usageEvents.push({
                                        eventId: event.eventId,
                                        name: event.name,
                                        usageType: 'renderTarget',
                                        slot: rt.slot,
                                    });
                                }
                            }
                        }

                        // Check depth target
                        const depthTarget = outputMerger.depthTarget ?? outputMerger.depthStencilTarget;
                        if (depthTarget && String(depthTarget.resourceId) === resourceId) {
                            usageEvents.push({
                                eventId: event.eventId,
                                name: event.name,
                                usageType: 'depthTarget',
                            });
                        }

                        // Check stage resources
                        const stageResources = pipelineState.stageResources ?? {};
                        for (const [stageName, resources] of Object.entries(stageResources)) {
                            if (!resources || typeof resources !== 'object') continue;
                            const res = resources as any;
                            
                            // Check textures
                            const textures = res.textures ?? [];
                            if (Array.isArray(textures)) {
                                for (const tex of textures) {
                                    if (tex && String(tex.resourceId) === resourceId) {
                                        usageEvents.push({
                                            eventId: event.eventId,
                                            name: event.name,
                                            usageType: 'sampledTexture',
                                            stage: stageName,
                                            slot: tex.slot,
                                        });
                                    }
                                }
                            }

                            // Check read-write textures
                            const rwTextures = res.readWriteTextures ?? res.uavTextures ?? [];
                            if (Array.isArray(rwTextures)) {
                                for (const tex of rwTextures) {
                                    if (tex && String(tex.resourceId) === resourceId) {
                                        usageEvents.push({
                                            eventId: event.eventId,
                                            name: event.name,
                                            usageType: 'readWriteTexture',
                                            stage: stageName,
                                            slot: tex.slot,
                                        });
                                    }
                                }
                            }

                            // Check buffers
                            const buffers = res.buffers ?? [];
                            if (Array.isArray(buffers)) {
                                for (const buf of buffers) {
                                    if (buf && String(buf.resourceId) === resourceId) {
                                        usageEvents.push({
                                            eventId: event.eventId,
                                            name: event.name,
                                            usageType: 'buffer',
                                            stage: stageName,
                                            slot: buf.slot,
                                        });
                                    }
                                }
                            }
                        }
                    } catch {
                        // Skip events that fail to query
                    }

                    // Recurse into children
                    if (event.children && event.children.length > 0) {
                        await searchResource(event.children);
                    }
                }
            };

            await searchResource(drawCalls);

            // Classify usage
            // Confirmed producers: render target and depth target writes are definitive output bindings
            const producers = usageEvents.filter(e =>
                e.usageType === 'renderTarget' ||
                e.usageType === 'depthTarget'
            );
            // Consumers: sampled textures and buffer reads
            const consumers = usageEvents.filter(e =>
                e.usageType === 'sampledTexture' ||
                e.usageType === 'buffer'
            );
            // Read-write bindings: bound as UAV/storage but we cannot confirm whether this event
            // actually wrote to the resource. These are potential producers, not confirmed ones.
            const readWriteBindings = usageEvents.filter(e =>
                e.usageType === 'readWriteTexture'
            );

            const result = {
                available: true,
                resourceId,
                totalUsageEvents: usageEvents.length,
                producers: producers.slice(0, maxEvents),
                consumers: consumers.slice(0, maxEvents),
                readWriteBindings: readWriteBindings.slice(0, maxEvents),
                summary: {
                    renderTargetWrites: producers.filter(e => e.usageType === 'renderTarget').length,
                    depthTargetWrites: producers.filter(e => e.usageType === 'depthTarget').length,
                    sampledReads: consumers.filter(e => e.usageType === 'sampledTexture').length,
                    bufferReads: consumers.filter(e => e.usageType === 'buffer').length,
                    readWriteBindings: readWriteBindings.length,
                },
                note: 'readWriteBindings are resources bound as read-write (UAV/storage) but not confirmed as written by this event. Do not treat them as confirmed producers.',
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    resourceId,
                    reason: err.message ?? 'Failed to trace resource usage.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<TraceResourceUsageInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Tracing usage of resource ${_options.input.resourceId}…` };
    }
}

// ─── Tool: Diff Pipeline State ───────────────────────────────────────────────
interface DiffPipelineStateInput {
    eventIdA: number;
    eventIdB: number;
}

export class DiffPipelineStateTool implements vscode.LanguageModelTool<DiffPipelineStateInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DiffPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Pipeline state diff requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const { eventIdA, eventIdB } = options.input;

        try {
            const [stateA, stateB] = await Promise.all([
                _bridge.nativeGetPipelineState(eventIdA),
                _bridge.nativeGetPipelineState(eventIdB),
            ]);

            if (!stateA || !stateB) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        available: false,
                        reason: 'Failed to retrieve pipeline state for one or both events.',
                    }, null, 2)),
                ]);
            }

            const diff: Record<string, any> = {};
            const changes: string[] = [];

            // Compare shaders
            const shadersA = stateA.shaders ?? {};
            const shadersB = stateB.shaders ?? {};
            const shaderDiff: Record<string, any> = {};
            
            for (const stage of ['vertex', 'hull', 'domain', 'geometry', 'fragment', 'pixel', 'compute']) {
                const shaderA = shadersA[stage];
                const shaderB = shadersB[stage];
                
                if (shaderA || shaderB) {
                    const nameA = shaderA?.name ?? shaderA?.entryPoint ?? null;
                    const nameB = shaderB?.name ?? shaderB?.entryPoint ?? null;
                    
                    if (nameA !== nameB) {
                        shaderDiff[stage] = { before: nameA, after: nameB };
                        changes.push(`Shader ${stage}: ${nameA ?? 'none'} → ${nameB ?? 'none'}`);
                    }
                }
            }
            
            if (Object.keys(shaderDiff).length > 0) {
                diff.shaders = shaderDiff;
            }

            // Compare render targets
            const omA = stateA.outputMerger ?? stateA.om ?? {};
            const omB = stateB.outputMerger ?? stateB.om ?? {};
            
            const rtA = omA.renderTargets ?? omA.colorTargets ?? [];
            const rtB = omB.renderTargets ?? omB.colorTargets ?? [];
            
            if (JSON.stringify(rtA) !== JSON.stringify(rtB)) {
                diff.renderTargets = { before: rtA, after: rtB };
                changes.push('Render targets changed');
            }

            // Compare depth target
            const depthA = omA.depthTarget ?? omA.depthStencilTarget;
            const depthB = omB.depthTarget ?? omB.depthStencilTarget;
            
            if (JSON.stringify(depthA) !== JSON.stringify(depthB)) {
                diff.depthTarget = { before: depthA, after: depthB };
                changes.push('Depth target changed');
            }

            // Compare blend state
            const blendA = stateA.blendState ?? stateA.blend;
            const blendB = stateB.blendState ?? stateB.blend;
            
            if (JSON.stringify(blendA) !== JSON.stringify(blendB)) {
                diff.blendState = { before: blendA, after: blendB };
                changes.push('Blend state changed');
            }

            // Compare rasterizer state
            const rasterA = stateA.rasterizerState ?? stateA.rasterizer;
            const rasterB = stateB.rasterizerState ?? stateB.rasterizer;
            
            if (JSON.stringify(rasterA) !== JSON.stringify(rasterB)) {
                diff.rasterizerState = { before: rasterA, after: rasterB };
                changes.push('Rasterizer state changed');
            }

            // Compare depth stencil state
            const depthStencilA = stateA.depthStencilState ?? stateA.depthStencil;
            const depthStencilB = stateB.depthStencilState ?? stateB.depthStencil;
            
            if (JSON.stringify(depthStencilA) !== JSON.stringify(depthStencilB)) {
                diff.depthStencilState = { before: depthStencilA, after: depthStencilB };
                changes.push('Depth stencil state changed');
            }

            const result = {
                available: true,
                eventIdA,
                eventIdB,
                hasChanges: changes.length > 0,
                changeCount: changes.length,
                changes,
                diff,
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventIdA,
                    eventIdB,
                    reason: err.message ?? 'Failed to diff pipeline state.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<DiffPipelineStateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Comparing pipeline state between EID ${_options.input.eventIdA} and EID ${_options.input.eventIdB}…` };
    }
}

// ─── Tool: Analyze Hot Event ────────────────────────────────────────────────
interface AnalyzeHotEventInput {
    eventId: number;
    includeShaderInfo?: boolean;
    includeMeshData?: boolean;
}

export class AnalyzeHotEventTool implements vscode.LanguageModelTool<AnalyzeHotEventInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AnalyzeHotEventInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Hot event analysis requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const { eventId, includeShaderInfo = true, includeMeshData = false } = options.input;

        try {
            // Gather all relevant information for this event
            const capturePath = requireCapturePath();
            const [drawCalls, pipelineState, timings] = await Promise.all([
                _bridge.getDrawCalls(capturePath),
                _bridge.nativeGetPipelineState(eventId),
                _bridge.getDrawTimings().catch(() => new Map<number, number>()),
            ]);

            const durationUs = timings.get(eventId);

            // Find the draw call for this event
            const eventDrawCall = findDrawCallByEventId(drawCalls, eventId);

            const analysis: any = {
                available: true,
                eventId,
                event: eventDrawCall ? {
                    eventId: eventDrawCall.eventId,
                    name: eventDrawCall.name,
                    flags: eventDrawCall.flags,
                    numIndices: eventDrawCall.numIndices,
                    numInstances: eventDrawCall.numInstances,
                } : null,
                durationUs: durationUs ?? null,
                durationMs: durationUs ? durationUs / 1000 : null,
            };

            // Pipeline state summary
            if (pipelineState) {
                const shaders = pipelineState.shaders ?? {};
                const stageResources = pipelineState.stageResources ?? {};
                const outputMerger = pipelineState.outputMerger ?? pipelineState.om ?? {};

                analysis.pipelineState = {
                    api: pipelineState.api,
                    shaders: Object.entries(shaders).map(([stage, shader]: [string, any]) => ({
                        stage,
                        name: shader?.name ?? shader?.entryPoint ?? 'unknown',
                        resourceId: shader?.resourceId,
                    })),
                    renderTargets: (outputMerger.renderTargets ?? outputMerger.colorTargets ?? [])
                        .filter((rt: any) => rt && rt.resourceId != null)
                        .map((rt: any) => ({
                            resourceId: String(rt.resourceId),
                            name: rt.resourceName ?? rt.name ?? '',
                            format: rt.format ?? '',
                            width: rt.width ?? 0,
                            height: rt.height ?? 0,
                        })),
                    depthTarget: outputMerger.depthTarget ?? outputMerger.depthStencilTarget ?? null,
                };

                // Resource counts
                let sampledTextures = 0;
                let storageTextures = 0;
                let buffers = 0;
                let samplers = 0;
                let constantBuffers = 0;

                for (const resources of Object.values(stageResources)) {
                    if (!resources || typeof resources !== 'object') continue;
                    const res = resources as any;
                    sampledTextures += (res.textures ?? []).length;
                    storageTextures += (res.readWriteTextures ?? res.uavTextures ?? []).length;
                    buffers += (res.buffers ?? []).length;
                    samplers += (res.samplers ?? []).length;
                    constantBuffers += (res.constantBlocks ?? []).length;
                }

                analysis.resourceCounts = {
                    sampledTextures,
                    storageTextures,
                    buffers,
                    samplers,
                    constantBuffers,
                };
            }

            // Optional shader info - structured metadata, not source code
            if (includeShaderInfo && pipelineState) {
                const shaders = pipelineState.shaders ?? {};
                const stageResources = pipelineState.stageResources ?? {};
                const shaderSummary: any[] = [];

                for (const [stage, shader] of Object.entries(shaders)) {
                    if (!shader || typeof shader !== 'object') continue;
                    const res = stageResources[stage] ?? {};
                    shaderSummary.push({
                        stage,
                        name: (shader as any).name ?? (shader as any).entryPoint ?? 'unknown',
                        resourceId: (shader as any).resourceId,
                        boundTextures: (res.textures ?? []).length,
                        boundBuffers: (res.buffers ?? []).length,
                        boundConstantBuffers: (res.constantBlocks ?? []).length,
                    });
                }

                if (shaderSummary.length > 0) {
                    analysis.shaderInfo = shaderSummary;
                }
            }

            // Optional mesh data
            if (includeMeshData) {
                try {
                    const meshData = await _bridge.nativeGetMeshData(eventId, 'vsin', { maxVertices: 10 });
                    analysis.meshData = {
                        topology: meshData.topology,
                        vertexCount: meshData.vertexCount,
                        indexCount: meshData.indexCount,
                        attributes: meshData.attributes?.map((attr: any) => ({
                            name: attr.name,
                            format: attr.format,
                            semantic: attr.semantic,
                        })),
                    };
                } catch {
                    // Mesh data not available
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(analysis, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    eventId,
                    reason: err.message ?? 'Failed to analyze hot event.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<AnalyzeHotEventInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Analyzing hot event EID ${_options.input.eventId}…` };
    }
}

// ─── Tool: Get Pass Graph ───────────────────────────────────────────────────
interface GetPassGraphInput {
    includeResources?: boolean;
}

export class GetPassGraphTool implements vscode.LanguageModelTool<GetPassGraphInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetPassGraphInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!_bridge.hasNativeBridge()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: 'Pass graph requires an active local replay via the RenderDoc native bridge.',
                }, null, 2)),
            ]);
        }

        const { includeResources = true } = options.input;
        const capturePath = requireCapturePath();

        try {
            const drawCalls = await _bridge.getDrawCalls(capturePath);
            const timings = await _bridge.getDrawTimings().catch(() => new Map<number, number>());

            // Build pass graph from top-level markers
            const passes: Array<{
                id: string;
                name: string;
                eventIdStart: number;
                eventIdEnd: number;
                drawCount: number;
                durationUs?: number;
                resources?: {
                    renderTargets: string[];
                    sampledTextures: string[];
                };
            }> = [];

            const buildPasses = async (events: DrawCall[], depth = 0) => {
                for (const event of events) {
                    // Top-level markers become passes
                    if (depth === 0 && event.children && event.children.length > 0) {
                        const firstChild = findFirstLeaf(event);
                        const lastChild = findLastLeaf(event);
                        const eventIdStart = firstChild?.eventId ?? event.eventId;
                        const eventIdEnd = lastChild?.eventId ?? event.eventId;
                         
                        const pass: any = {
                            id: buildPassId(event.name, eventIdStart, eventIdEnd),
                            name: event.name,
                            eventIdStart,
                            eventIdEnd,
                            drawCount: countDrawCalls(event),
                        };

                        // Calculate duration
                        const duration = calculatePassDuration(event, timings);
                        if (duration > 0) {
                            pass.durationUs = duration;
                        }

                        // Collect resources if requested
                        if (includeResources) {
                            const resources = await collectPassResources(event, _bridge);
                            if (resources.renderTargets.length > 0 || resources.sampledTextures.length > 0) {
                                pass.resources = resources;
                            }
                        }

                        passes.push(pass);
                    } else if (depth === 0) {
                        // Single draw call at top level
                        passes.push({
                            id: buildPassId(event.name, event.eventId, event.eventId),
                            name: event.name,
                            eventIdStart: event.eventId,
                            eventIdEnd: event.eventId,
                            drawCount: 1,
                            durationUs: timings.get(event.eventId),
                        });
                    }

                    // Recurse for nested structure
                    if (event.children && event.children.length > 0) {
                        await buildPasses(event.children, depth + 1);
                    }
                }
            };

            await buildPasses(drawCalls);

            // Build dependency edges between passes
            const edges: Array<{
                fromPassId: string;
                fromPassName: string;
                toPassId: string;
                toPassName: string;
                resourceId: string;
                usage: 'sampledFromRenderTarget';
            }> = [];

            // Build a map of resource producers (passes that write to render targets)
            const resourceProducers = new Map<string, Array<{ id: string; name: string }>>();
            for (const pass of passes) {
                if (pass.resources?.renderTargets) {
                    for (const rt of pass.resources.renderTargets) {
                        if (!resourceProducers.has(rt)) {
                            resourceProducers.set(rt, []);
                        }
                        resourceProducers.get(rt)!.push({ id: pass.id, name: pass.name });
                    }
                }
            }

            // Find edges: if pass B samples a texture that pass A wrote to
            for (const pass of passes) {
                if (pass.resources?.sampledTextures) {
                    for (const tex of pass.resources.sampledTextures) {
                        const producers = resourceProducers.get(tex);
                        if (producers) {
                            for (const producerPass of producers) {
                                if (producerPass.id !== pass.id) {
                                    edges.push({
                                        fromPassId: producerPass.id,
                                        fromPassName: producerPass.name,
                                        toPassId: pass.id,
                                        toPassName: pass.name,
                                        resourceId: tex,
                                        usage: 'sampledFromRenderTarget',
                                    });
                                }
                            }
                        }
                    }
                }
            }

            const result = {
                available: true,
                passCount: passes.length,
                passes,
                edges,
                edgeCount: edges.length,
                totalDurationUs: passes.reduce((sum, p) => sum + (p.durationUs ?? 0), 0),
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    available: false,
                    reason: err.message ?? 'Failed to build pass graph.',
                }, null, 2)),
            ]);
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<GetPassGraphInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Building pass graph…' };
    }
}

// Helper functions for pass graph
function findFirstLeaf(event: DrawCall): DrawCall | null {
    if (!event.children || event.children.length === 0) {
        return event;
    }
    return findFirstLeaf(event.children[0]);
}

export interface LaunchRemoteApplicationInput {
    targetUrl?: string;
    targetQuery?: string;
    packageActivity: string;
    commandLine?: string;
}

export interface TriggerRemoteCaptureInput {
    trigger?: TriggerCaptureOptions['trigger'];
    frameNumber?: number;
    delaySeconds?: number;
}

export interface AndroidReadinessInput {
    packageName: string;
    targetQuery?: string;
}

export interface WindowsLaunchInput {
    executablePath: string;
    workingDir?: string;
    commandLine?: string;
}

function buildPassId(name: string, eventIdStart: number, eventIdEnd: number): string {
    const safeName = (name || 'pass').replace(/\s+/g, '_');
    return `${safeName}:${eventIdStart}-${eventIdEnd}`;
}

function findLastLeaf(event: DrawCall): DrawCall | null {
    if (!event.children || event.children.length === 0) {
        return event;
    }
    return findLastLeaf(event.children[event.children.length - 1]);
}

function countDrawCalls(event: DrawCall): number {
    let count = 0;
    if (!event.children || event.children.length === 0) {
        count = 1;
    } else {
        for (const child of event.children) {
            count += countDrawCalls(child);
        }
    }
    return count;
}

function calculatePassDuration(event: DrawCall, timings: Map<number, number>): number {
    let duration = 0;
    
    if (!event.children || event.children.length === 0) {
        duration = timings.get(event.eventId) ?? 0;
    } else {
        for (const child of event.children) {
            duration += calculatePassDuration(child, timings);
        }
    }
    
    return duration;
}

async function collectPassResources(
    event: DrawCall,
    bridge: RenderDocBridge,
): Promise<{ renderTargets: string[]; sampledTextures: string[] }> {
    const renderTargets = new Set<string>();
    const sampledTextures = new Set<string>();

    const collectFromEvent = async (e: DrawCall) => {
        try {
            const pipelineState = await bridge.nativeGetPipelineState(e.eventId);
            if (!pipelineState) return;

            const outputMerger = pipelineState.outputMerger ?? pipelineState.om ?? {};
            const rts = outputMerger.renderTargets ?? outputMerger.colorTargets ?? [];
            if (Array.isArray(rts)) {
                for (const rt of rts) {
                    if (rt && rt.resourceId != null) {
                        renderTargets.add(String(rt.resourceId));
                    }
                }
            }

            const stageResources = pipelineState.stageResources ?? {};
            for (const resources of Object.values(stageResources)) {
                if (!resources || typeof resources !== 'object') continue;
                const res = resources as any;
                const textures = res.textures ?? [];
                if (Array.isArray(textures)) {
                    for (const tex of textures) {
                        if (tex && tex.resourceId != null) {
                            sampledTextures.add(String(tex.resourceId));
                        }
                    }
                }
            }
        } catch {
            // Skip events that fail
        }

        if (e.children) {
            for (const child of e.children) {
                await collectFromEvent(child);
            }
        }
    };

    await collectFromEvent(event);

    return {
        renderTargets: Array.from(renderTargets),
        sampledTextures: Array.from(sampledTextures),
    };
}

