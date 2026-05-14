import { buildRenderDocSystemPrompt } from './prompt';
import {
    getRenderDocExternalToolDefinitions,
    invokeRenderDocToolByName,
} from './toolRuntime';

export type ExternalAiProvider = 'openai-compatible' | 'anthropic';

export interface ExternalAiConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ExternalAiProgressEvent {
    message: string;
}

export interface ExternalAiRuntimeRequest {
    provider: ExternalAiProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    temperature: number;
    maxToolRounds: number;
    requestTimeoutMs: number;
    hasNative: boolean;
    history: ExternalAiConversationMessage[];
    prompt: string;
    onProgress?: (event: ExternalAiProgressEvent) => void;
    signal?: AbortSignal;
}

interface AbortScope {
    signal: AbortSignal;
    dispose: () => void;
}

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';

function createAbortScope(timeoutMs: number, parentSignal?: AbortSignal): AbortScope {
    const controller = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    let parentAbortListener: (() => void) | undefined;

    if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`The AI request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
    }

    if (parentSignal) {
        const abortFromParent = () => {
            controller.abort(parentSignal.reason ?? new Error('The AI request was cancelled.'));
        };
        if (parentSignal.aborted) {
            abortFromParent();
        } else {
            parentSignal.addEventListener('abort', abortFromParent, { once: true });
            parentAbortListener = () => parentSignal.removeEventListener('abort', abortFromParent);
        }
    }

    return {
        signal: controller.signal,
        dispose: () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            parentAbortListener?.();
        },
    };
}

async function requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<any> {
    const abortScope = createAbortScope(timeoutMs, signal);
    try {
        const response = await fetch(url, {
            ...init,
            signal: abortScope.signal,
        });
        const text = await response.text();
        let payload: any = undefined;
        if (text.trim()) {
            try {
                payload = JSON.parse(text);
            } catch {
                payload = undefined;
            }
        }

        if (!response.ok) {
            const message = payload?.error?.message
                ?? payload?.error?.error?.message
                ?? payload?.error?.details
                ?? payload?.message
                ?? text
                ?? `HTTP ${response.status}`;
            throw new Error(String(message).trim() || `HTTP ${response.status}`);
        }

        if (payload === undefined) {
            throw new Error('The AI provider returned an empty response body.');
        }

        return payload;
    } finally {
        abortScope.dispose();
    }
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

function normalizeOpenAiContent(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }
                if (typeof part?.text === 'string') {
                    return part.text;
                }
                return '';
            })
            .join('');
    }
    return '';
}

function serializeToolResult(result: unknown): string {
    if (typeof result === 'string') {
        return result;
    }
    return JSON.stringify(result, null, 2);
}

async function generateOpenAiCompatibleResponse(request: ExternalAiRuntimeRequest): Promise<string> {
    const baseUrl = normalizeOpenAiBaseUrl(request.baseUrl || 'https://api.openai.com/v1');
    const tools = getRenderDocExternalToolDefinitions(request.hasNative).map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (request.apiKey) {
        headers.Authorization = `Bearer ${request.apiKey}`;
    }

    const messages: any[] = [
        { role: 'system', content: buildRenderDocSystemPrompt(request.hasNative) },
        ...request.history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: request.prompt },
    ];

    request.onProgress?.({ message: 'Waiting for the model response…' });

    for (let round = 0; round < request.maxToolRounds; round++) {
        const payload = await requestJson(
            `${baseUrl}/chat/completions`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: request.model,
                    temperature: request.temperature,
                    messages,
                    tools,
                    tool_choice: 'auto',
                }),
            },
            request.requestTimeoutMs,
            request.signal,
        );

        const assistantMessage = payload?.choices?.[0]?.message;
        if (!assistantMessage) {
            throw new Error('The OpenAI-compatible provider did not return a message.');
        }

        const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
        if (toolCalls.length === 0) {
            const content = normalizeOpenAiContent(assistantMessage.content).trim();
            return content || 'No response returned by the model.';
        }

        messages.push({
            role: 'assistant',
            content: assistantMessage.content ?? null,
            tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
            const toolName = toolCall?.function?.name;
            if (!toolName) {
                continue;
            }

            request.onProgress?.({ message: `Calling ${toolName}…` });

            let parsedInput: unknown = {};
            const argumentText = toolCall?.function?.arguments;
            if (typeof argumentText === 'string' && argumentText.trim()) {
                try {
                    parsedInput = JSON.parse(argumentText);
                } catch {
                    throw new Error(`The model produced invalid JSON arguments for ${toolName}.`);
                }
            }

            const toolResult = await invokeRenderDocToolByName(toolName, parsedInput);
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: serializeToolResult(toolResult),
            });
        }
    }

    throw new Error('The model exceeded the maximum number of tool rounds.');
}

async function generateAnthropicResponse(request: ExternalAiRuntimeRequest): Promise<string> {
    const tools = getRenderDocExternalToolDefinitions(request.hasNative).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    }));

    const messages: any[] = [
        ...request.history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: request.prompt },
    ];

    request.onProgress?.({ message: 'Waiting for the model response…' });

    for (let round = 0; round < request.maxToolRounds; round++) {
        const payload = await requestJson(
            request.baseUrl || DEFAULT_ANTHROPIC_BASE_URL,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01',
                    'x-api-key': request.apiKey || '',
                },
                body: JSON.stringify({
                    model: request.model,
                    max_tokens: 4096,
                    temperature: request.temperature,
                    system: buildRenderDocSystemPrompt(request.hasNative),
                    messages,
                    tools,
                }),
            },
            request.requestTimeoutMs,
            request.signal,
        );

        const contentBlocks = Array.isArray(payload?.content) ? payload.content : [];
        const toolUses = contentBlocks.filter((block: any) => block?.type === 'tool_use');
        const text = contentBlocks
            .filter((block: any) => block?.type === 'text')
            .map((block: any) => String(block.text || ''))
            .join('')
            .trim();

        if (toolUses.length === 0) {
            return text || 'No response returned by the model.';
        }

        messages.push({ role: 'assistant', content: contentBlocks });

        const toolResults = [];
        for (const toolUse of toolUses) {
            const toolName = toolUse?.name;
            if (!toolName) {
                continue;
            }

            request.onProgress?.({ message: `Calling ${toolName}…` });
            const toolResult = await invokeRenderDocToolByName(toolName, toolUse.input ?? {});
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: serializeToolResult(toolResult),
            });
        }

        messages.push({
            role: 'user',
            content: toolResults,
        });
    }

    throw new Error('The model exceeded the maximum number of tool rounds.');
}

export async function generateExternalAiResponse(request: ExternalAiRuntimeRequest): Promise<string> {
    if (request.provider === 'anthropic') {
        return generateAnthropicResponse(request);
    }
    return generateOpenAiCompatibleResponse(request);
}