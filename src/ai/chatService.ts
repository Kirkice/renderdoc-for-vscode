import * as path from 'path';
import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';
import {
    ExternalAiConversationMessage,
    ExternalAiProgressEvent,
    ExternalAiProvider,
    generateExternalAiResponse,
} from './modelRuntime';

const OPENAI_SECRET_KEY = 'renderdoc.ai.openai.apiKey';
const ANTHROPIC_SECRET_KEY = 'renderdoc.ai.anthropic.apiKey';
const PROFILE_SECRET_KEY_PREFIX = 'renderdoc.ai.profile.';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-7-sonnet-latest';

export interface RenderDocAiProfileSummary {
    id: string;
    label: string;
    provider: ExternalAiProvider;
    providerLabel: string;
    model: string;
    baseUrl?: string;
    apiKeyEnvVar?: string;
}

export interface RenderDocAiContextSnapshot {
    capture?: {
        label: string;
        path: string;
    };
    selectedDrawCall?: {
        label: string;
        eventId?: number;
    };
    selectedResource?: {
        label: string;
        resourceId?: string;
        resourceType?: string;
    };
}

export interface RenderDocAiStatus {
    activeProfileId: string;
    activeProfileLabel: string;
    provider: ExternalAiProvider;
    providerLabel: string;
    model: string;
    baseUrl?: string;
    apiKeyConfigured: boolean;
    apiKeySource: 'secret' | 'env' | 'none';
    apiKeyEnvVar?: string;
    usingLocalEndpoint: boolean;
    captureLoaded: boolean;
    nativeBridgeAvailable: boolean;
    ready: boolean;
    missingReason?: string;
    availableProfiles: RenderDocAiProfileSummary[];
    context: RenderDocAiContextSnapshot;
}

interface RenderDocAiProfile extends RenderDocAiProfileSummary {
    legacySecretKey?: string;
}

interface ResolvedApiKey {
    value?: string;
    source: 'secret' | 'env' | 'none';
    envVar?: string;
}

function isLikelyLocalEndpoint(baseUrl: string): boolean {
    try {
        const url = new URL(baseUrl);
        const hostname = url.hostname.toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
        return false;
    }
}

function providerLabel(provider: ExternalAiProvider): string {
    return provider === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible';
}

function cleanString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}

function slugifyProfileId(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'profile';
}

function uniqueEnvVars(values: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const trimmed = cleanString(value);
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

export class RenderDocAiService {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly bridge: RenderDocBridge,
        private readonly getCurrentCapturePath: () => string | undefined,
        private readonly getSelectionContext: () => {
            selectedDrawCall?: any;
            selectedResource?: any;
        },
    ) {}

    private getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('renderdoc');
    }

    private getLegacyProvider(): ExternalAiProvider {
        return this.getConfiguration().get<ExternalAiProvider>('ai.provider', 'openai-compatible');
    }

    private getLegacyProfiles(): RenderDocAiProfile[] {
        const config = this.getConfiguration();
        return [
            {
                id: 'openai-compatible',
                label: 'OpenAI Compatible',
                provider: 'openai-compatible',
                providerLabel: providerLabel('openai-compatible'),
                model: config.get<string>('ai.openai.model', DEFAULT_OPENAI_MODEL),
                baseUrl: config.get<string>('ai.openai.baseUrl', DEFAULT_OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL,
                apiKeyEnvVar: 'OPENAI_API_KEY',
                legacySecretKey: OPENAI_SECRET_KEY,
            },
            {
                id: 'anthropic',
                label: 'Anthropic',
                provider: 'anthropic',
                providerLabel: providerLabel('anthropic'),
                model: config.get<string>('ai.anthropic.model', DEFAULT_ANTHROPIC_MODEL),
                apiKeyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
                legacySecretKey: ANTHROPIC_SECRET_KEY,
            },
        ];
    }

    private normalizeConfiguredProfiles(rawProfiles: unknown): RenderDocAiProfile[] {
        if (!Array.isArray(rawProfiles)) {
            return [];
        }

        const profiles: RenderDocAiProfile[] = [];
        const seenIds = new Set<string>();

        for (let index = 0; index < rawProfiles.length; index++) {
            const raw = rawProfiles[index];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                continue;
            }

            const record = raw as Record<string, unknown>;
            const provider = record.provider === 'anthropic'
                ? 'anthropic'
                : record.provider === 'openai-compatible'
                    ? 'openai-compatible'
                    : undefined;
            const model = cleanString(record.model);
            if (!provider || !model) {
                continue;
            }

            const label = cleanString(record.label) || `${providerLabel(provider)} ${index + 1}`;
            const rawId = cleanString(record.id) || label;
            const baseId = slugifyProfileId(rawId);
            let id = baseId;
            let suffix = 2;
            while (seenIds.has(id)) {
                id = `${baseId}-${suffix++}`;
            }
            seenIds.add(id);

            const baseUrl = cleanString(record.baseUrl)
                || (provider === 'openai-compatible' ? DEFAULT_OPENAI_BASE_URL : undefined);

            profiles.push({
                id,
                label,
                provider,
                providerLabel: providerLabel(provider),
                model,
                baseUrl,
                apiKeyEnvVar: cleanString(record.apiKeyEnvVar),
            });
        }

        return profiles;
    }

    private getProfiles(): RenderDocAiProfile[] {
        const configuredProfiles = this.normalizeConfiguredProfiles(this.getConfiguration().get<unknown>('ai.profiles', []));
        return configuredProfiles.length > 0 ? configuredProfiles : this.getLegacyProfiles();
    }

    private getConfiguredActiveProfileId(): string | undefined {
        return cleanString(this.getConfiguration().get<string>('ai.activeProfile', ''));
    }

    private getActiveProfile(profiles = this.getProfiles()): RenderDocAiProfile {
        const configuredActiveProfileId = this.getConfiguredActiveProfileId();
        if (configuredActiveProfileId) {
            const configuredMatch = profiles.find((profile) => profile.id === configuredActiveProfileId);
            if (configuredMatch) {
                return configuredMatch;
            }
        }

        const legacyProvider = this.getLegacyProvider();
        const providerMatch = profiles.find((profile) => profile.id === legacyProvider || profile.provider === legacyProvider);
        return providerMatch || profiles[0];
    }

    private secretKeyForProfile(profileId: string): string {
        return `${PROFILE_SECRET_KEY_PREFIX}${encodeURIComponent(profileId)}.apiKey`;
    }

    private getDefaultApiKeyEnvVars(provider: ExternalAiProvider): string[] {
        if (provider === 'anthropic') {
            return ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
        }
        return ['OPENAI_API_KEY'];
    }

    private async getApiKey(profile: RenderDocAiProfile): Promise<ResolvedApiKey> {
        const directSecret = cleanString(await this.context.secrets.get(this.secretKeyForProfile(profile.id)));
        if (directSecret) {
            return { value: directSecret, source: 'secret' };
        }

        if (profile.legacySecretKey) {
            const legacySecret = cleanString(await this.context.secrets.get(profile.legacySecretKey));
            if (legacySecret) {
                return { value: legacySecret, source: 'secret' };
            }
        }

        const envVars = uniqueEnvVars([profile.apiKeyEnvVar, ...this.getDefaultApiKeyEnvVars(profile.provider)]);
        for (const envVar of envVars) {
            const envValue = cleanString(process.env[envVar]);
            if (envValue) {
                return {
                    value: envValue,
                    source: 'env',
                    envVar,
                };
            }
        }

        return { source: 'none' };
    }

    private formatMissingKeyMessage(profile: RenderDocAiProfile): string {
        const envHint = profile.apiKeyEnvVar ? ` or set ${profile.apiKeyEnvVar}` : '';
        if (profile.provider === 'anthropic') {
            return `Set an API key for ${profile.label}${envHint} before using this profile.`;
        }
        return `Set an API key for ${profile.label}${envHint}, or point the endpoint at a local server.`;
    }

    private buildContextSnapshot(): RenderDocAiContextSnapshot {
        const capturePath = this.getCurrentCapturePath();
        const selection = this.getSelectionContext();
        const selectedDrawCall = selection?.selectedDrawCall;
        const selectedResource = selection?.selectedResource;

        const drawLabel = cleanString(selectedDrawCall?.name)
            || cleanString(selectedDrawCall?.label)
            || (typeof selectedDrawCall?.eventId === 'number' ? `EID ${selectedDrawCall.eventId}` : undefined);
        const resourceLabel = cleanString(selectedResource?.label)
            || cleanString(selectedResource?.name)
            || cleanString(selectedResource?.resourceId);

        return {
            capture: capturePath
                ? {
                    label: path.basename(capturePath),
                    path: capturePath,
                }
                : undefined,
            selectedDrawCall: drawLabel
                ? {
                    label: drawLabel,
                    eventId: typeof selectedDrawCall?.eventId === 'number' ? selectedDrawCall.eventId : undefined,
                }
                : undefined,
            selectedResource: resourceLabel
                ? {
                    label: resourceLabel,
                    resourceId: cleanString(selectedResource?.resourceId),
                    resourceType: cleanString(selectedResource?.resourceType) || cleanString(selectedResource?.type),
                }
                : undefined,
        };
    }

    async getStatus(): Promise<RenderDocAiStatus> {
        const profiles = this.getProfiles();
        const activeProfile = this.getActiveProfile(profiles);
        const apiKey = await this.getApiKey(activeProfile);
        const captureLoaded = !!this.getCurrentCapturePath();
        const nativeBridgeAvailable = this.bridge.hasNativeBridge();
        const usingLocalEndpoint = !!activeProfile.baseUrl && isLikelyLocalEndpoint(activeProfile.baseUrl);
        const context = this.buildContextSnapshot();

        let missingReason: string | undefined;
        if (!captureLoaded) {
            missingReason = 'Open a RenderDoc capture before sending prompts.';
        } else if (!apiKey.value && !usingLocalEndpoint) {
            missingReason = this.formatMissingKeyMessage(activeProfile);
        }

        return {
            activeProfileId: activeProfile.id,
            activeProfileLabel: activeProfile.label,
            provider: activeProfile.provider,
            providerLabel: activeProfile.providerLabel,
            model: activeProfile.model,
            baseUrl: activeProfile.baseUrl,
            apiKeyConfigured: !!apiKey.value,
            apiKeySource: apiKey.source,
            apiKeyEnvVar: apiKey.envVar || activeProfile.apiKeyEnvVar,
            usingLocalEndpoint,
            captureLoaded,
            nativeBridgeAvailable,
            ready: !missingReason,
            missingReason,
            availableProfiles: profiles.map((profile) => ({
                id: profile.id,
                label: profile.label,
                provider: profile.provider,
                providerLabel: profile.providerLabel,
                model: profile.model,
                baseUrl: profile.baseUrl,
                apiKeyEnvVar: profile.apiKeyEnvVar,
            })),
            context,
        };
    }

    async sendMessage(
        history: ExternalAiConversationMessage[],
        prompt: string,
        onProgress?: (event: ExternalAiProgressEvent) => void,
        signal?: AbortSignal,
    ): Promise<string> {
        const profiles = this.getProfiles();
        const activeProfile = this.getActiveProfile(profiles);
        const status = await this.getStatus();
        if (!status.ready) {
            throw new Error(status.missingReason || 'The AI profile is not ready.');
        }

        const apiKey = await this.getApiKey(activeProfile);
        return generateExternalAiResponse({
            provider: activeProfile.provider,
            model: activeProfile.model,
            apiKey: apiKey.value,
            baseUrl: activeProfile.baseUrl,
            temperature: this.getConfiguration().get<number>('ai.temperature', 0.2),
            maxToolRounds: this.getConfiguration().get<number>('ai.maxToolRounds', 8),
            requestTimeoutMs: this.getConfiguration().get<number>('ai.requestTimeoutMs', 120000),
            hasNative: this.bridge.hasNativeBridge(),
            history,
            prompt,
            onProgress,
            signal,
        });
    }

    async setActiveProfile(profileId: string): Promise<void> {
        const profiles = this.getProfiles();
        const profile = profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            throw new Error(`Unknown AI profile: ${profileId}`);
        }

        const config = this.getConfiguration();
        await config.update('ai.activeProfile', profile.id, vscode.ConfigurationTarget.Global);
        await config.update('ai.provider', profile.provider, vscode.ConfigurationTarget.Global);
    }

    async configureProvider(): Promise<void> {
        const profiles = this.getProfiles();
        const activeProfile = this.getActiveProfile(profiles);
        const selection = await vscode.window.showQuickPick([
            ...profiles.map((profile) => ({
                label: profile.label,
                description: `${profile.providerLabel} · ${profile.model}`,
                detail: profile.baseUrl || 'Anthropic Messages API',
                profileId: profile.id,
            })),
            {
                label: 'Manage Profiles…',
                description: 'Open renderdoc.ai settings to add or edit model profiles',
                detail: 'Edit renderdoc.ai.profiles and renderdoc.ai.activeProfile',
                profileId: '__settings__',
            },
        ], {
            title: 'RenderDoc AI Profile',
            placeHolder: activeProfile.label,
        });

        if (!selection) {
            return;
        }

        if (selection.profileId === '__settings__') {
            await this.openSettings();
            return;
        }

        await this.setActiveProfile(selection.profileId);
        vscode.window.showInformationMessage(`RenderDoc AI profile set to ${selection.label}.`);
    }

    async setApiKey(profileId?: string): Promise<void> {
        const profiles = this.getProfiles();
        const profile = profileId
            ? profiles.find((candidate) => candidate.id === profileId)
            : this.getActiveProfile(profiles);
        if (!profile) {
            throw new Error(`Unknown AI profile: ${profileId}`);
        }

        const value = await vscode.window.showInputBox({
            title: `${profile.label} API Key`,
            prompt: `Enter the API key used by ${profile.label}. Leave it empty to clear the saved key.`,
            password: true,
            ignoreFocusOut: true,
        });

        if (value === undefined) {
            return;
        }

        const trimmed = value.trim();
        const secretKey = this.secretKeyForProfile(profile.id);
        if (!trimmed) {
            await this.context.secrets.delete(secretKey);
            if (profile.legacySecretKey) {
                await this.context.secrets.delete(profile.legacySecretKey);
            }
            vscode.window.showInformationMessage(`RenderDoc AI ${profile.label} API key cleared.`);
            return;
        }

        await this.context.secrets.store(secretKey, trimmed);
        if (profile.legacySecretKey) {
            await this.context.secrets.store(profile.legacySecretKey, trimmed);
        }
        vscode.window.showInformationMessage(`RenderDoc AI ${profile.label} API key saved.`);
    }

    async clearApiKey(profileId?: string): Promise<void> {
        const profiles = this.getProfiles();
        const profile = profileId
            ? profiles.find((candidate) => candidate.id === profileId)
            : this.getActiveProfile(profiles);
        if (!profile) {
            throw new Error(`Unknown AI profile: ${profileId}`);
        }

        await this.context.secrets.delete(this.secretKeyForProfile(profile.id));
        if (profile.legacySecretKey) {
            await this.context.secrets.delete(profile.legacySecretKey);
        }
        vscode.window.showInformationMessage(`RenderDoc AI ${profile.label} API key cleared.`);
    }

    async openSettings(): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'renderdoc.ai.profiles');
    }
}