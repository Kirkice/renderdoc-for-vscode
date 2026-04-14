import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';

let _bridge: RenderDocBridge;
let _getCurrentCapturePath: () => string | undefined;

export function initChatParticipant(bridge: RenderDocBridge, getCurrentCapturePath: () => string | undefined) {
    _bridge = bridge;
    _getCurrentCapturePath = getCurrentCapturePath;
}

const PARTICIPANT_ID = 'renderdoc';

/**
 * System prompt that gives the model context about RenderDoc analysis capabilities.
 */
function buildSystemPrompt(hasNative: boolean): string {
    const base = `You are a GPU graphics debugging assistant integrated with RenderDoc. You help analyze GPU captures (.rdc files) to diagnose rendering issues, optimize performance, and understand GPU workloads.

You have access to the following tools:
- renderdoc_getCaptureInfo: Get metadata about the loaded capture (API, driver, sections)
- renderdoc_getDrawCalls: Get the list of draw calls / GPU events in the frame (with optional filter)
- renderdoc_getResources: Get textures, buffers, shaders and other GPU resources (with optional type filter)
- renderdoc_getResourceDetail: Get detailed info about a specific resource by ID
- renderdoc_getEventDetails: Get full details of a specific event by its event ID
- renderdoc_getTextureInfo: Get texture-specific information
- renderdoc_analyzeFrame: Get a comprehensive frame analysis with potential performance issues`;

    const nativeCapabilities = hasNative
        ? `\n- renderdoc_getPipelineState: Get the full GPU pipeline state at a specific draw call event
- renderdoc_getShaderSource: Get shader source code (GLSL/HLSL) at a specific event`
        : '\n\nNote: The native RenderDoc bridge is not yet available. Pipeline state and shader source tools are limited.';

    return base + nativeCapabilities + `

When analyzing captures:
1. Start with renderdoc_getCaptureInfo to understand context (API, driver)
2. Use renderdoc_analyzeFrame for an overview
3. Drill into specific draw calls or resources as needed
4. Look for common issues: overdraw, redundant state changes, large textures, excessive draw calls
5. Provide actionable recommendations

Format your responses clearly with sections. Use tables for comparing resources. Highlight specific event IDs when referencing draw calls.`;
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> => {
        const capturePath = _getCurrentCapturePath();

        // If no capture is loaded, prompt user
        if (!capturePath) {
            stream.markdown('No RenderDoc capture file is currently loaded.\n\n');
            stream.button({
                command: 'renderdoc.openCapture',
                title: 'Open Capture File',
            });
            return { metadata: { command: '' } };
        }

        const hasNative = _bridge.hasNativeBridge();

        // Build the model request with tools
        const toolReferences: vscode.LanguageModelChatTool[] = [
            { name: 'renderdoc_getCaptureInfo', description: 'Get metadata about the loaded RenderDoc capture file' },
            { name: 'renderdoc_getDrawCalls', description: 'Get draw calls from the capture, optionally filtered by name' },
            { name: 'renderdoc_getResources', description: 'Get GPU resources (textures, buffers, shaders), optionally filtered by type' },
            { name: 'renderdoc_getResourceDetail', description: 'Get detailed information about a specific resource by ID' },
            { name: 'renderdoc_getEventDetails', description: 'Get details of a specific draw call event by event ID' },
            { name: 'renderdoc_getTextureInfo', description: 'Get texture-specific info' },
            { name: 'renderdoc_analyzeFrame', description: 'Comprehensive frame analysis with performance issue detection' },
        ];

        if (hasNative) {
            toolReferences.push(
                { name: 'renderdoc_getPipelineState', description: 'Get GPU pipeline state at a specific event' },
                { name: 'renderdoc_getShaderSource', description: 'Get shader source code at a specific event' },
            );
        }

        try {
            const [model] = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o',
            });

            if (!model) {
                stream.markdown('No language model available. Please make sure GitHub Copilot is active.');
                return { metadata: { command: '' } };
            }

            // Build messages
            const messages = [
                vscode.LanguageModelChatMessage.User(buildSystemPrompt(hasNative)),
            ];

            // Include history for multi-turn conversation
            for (const turn of chatContext.history) {
                if (turn instanceof vscode.ChatRequestTurn) {
                    messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                } else if (turn instanceof vscode.ChatResponseTurn) {
                    const responseText = turn.response
                        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
                        .map(part => part.value.value)
                        .join('');
                    if (responseText) {
                        messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                    }
                }
            }

            messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

            // Tool-calling loop
            const MAX_TOOL_ROUNDS = 10;
            let round = 0;

            while (round < MAX_TOOL_ROUNDS) {
                round++;
                const response = await model.sendRequest(messages, { tools: toolReferences }, token);

                let hasToolCall = false;

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(part.value);
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        hasToolCall = true;

                        // Execute the tool
                        stream.progress(`Calling ${part.name}…`);

                        try {
                            const toolResult = await vscode.lm.invokeTool(part.name, {
                                input: part.input,
                                toolInvocationToken: request.toolInvocationToken,
                            }, token);

                            // Add tool call + result to messages for next round
                            messages.push(
                                vscode.LanguageModelChatMessage.Assistant([
                                    new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input),
                                ]),
                            );
                            messages.push(
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelToolResultPart(part.callId, toolResult.content as any),
                                ]),
                            );
                        } catch (err: any) {
                            messages.push(
                                vscode.LanguageModelChatMessage.Assistant([
                                    new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input),
                                ]),
                            );
                            messages.push(
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelToolResultPart(part.callId, [
                                        new vscode.LanguageModelTextPart(`Error: ${err.message}`),
                                    ]),
                                ]),
                            );
                        }
                    }
                }

                // If the model didn't call any tools, it finished generating text — we're done
                if (!hasToolCall) {
                    break;
                }
            }
        } catch (err: any) {
            if (err.code === 'NoPermissions') {
                stream.markdown('You need to allow access to the language model for the RenderDoc chat participant.');
            } else {
                stream.markdown(`Error: ${err.message}`);
            }
        }

        return { metadata: { command: '' } };
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('device-camera');
    context.subscriptions.push(participant);
}
