import * as vscode from 'vscode';
import { RenderDocBridge } from '../renderdocBridge';

let _bridge: RenderDocBridge;
let _getCurrentCapturePath: () => string | undefined;
let _getSelectionContext: () => { selectedDrawCall: any; selectedResource: any };

export function initChatParticipant(
    bridge: RenderDocBridge,
    getCurrentCapturePath: () => string | undefined,
    getSelectionContext: () => { selectedDrawCall: any; selectedResource: any },
) {
    _bridge = bridge;
    _getCurrentCapturePath = getCurrentCapturePath;
    _getSelectionContext = getSelectionContext;
}

const PARTICIPANT_ID = 'renderdoc';

/**
 * Participant-specific policy.
 *
 * The workspace skill under .github/skills/renderdoc-analysis remains the
 * richer source of truth for generic tool-orchestration guidance, but we keep
 * the highest-value workflow defaults here as well so packaged VSIX installs
 * still behave reasonably when workspace skills are missing or not auto-loaded.
 */
function buildSystemPrompt(hasNative: boolean): string {
    const base = `You are a GPU graphics debugging assistant integrated with RenderDoc.

All capture facts must come from the provided renderdoc_* tools. Never guess or fabricate event IDs, resource IDs, shader source, pipeline state, resource bindings, buffer contents, texture contents, or GPU timings.

Participant hard rules:
1. If the user asks about an event or resource without specifying an ID, resolve it from selection context before using other tools.
2. For bottleneck questions, use the expensiveDraws field when present. Never infer GPU cost from vertex count or index count alone.
3. When reporting expensive leaf draws, include the full logical marker hierarchy path.
4. Reference events as EID <n>.
5. Separate confirmed timing evidence from geometry, shader, texture, or overdraw hypotheses.
6. Do not invent shader instruction counts, cycle estimates, overdraw metrics, or Mali results when the tools did not provide them.
7. If no capture is loaded, or a native-only capability is unavailable, say so explicitly instead of implying the data exists.

Workflow defaults:
1. For questions about "this", "current", or "selected", start with renderdoc_getSelectionContext. For selected-draw timing or performance questions, resolve the focused event first, and reuse any latestMaliAnalysis already present in selection context when it is relevant.
2. For frame overview, pass layout, render flow, or bottleneck questions, start with renderdoc_getFrameSummary. Use renderdoc_getCaptureInfo early if API context matters. If direct GPU timing data may be missing, call renderdoc_getActionTimings.
3. For performance questions, identify the hottest passes or leaf draws first, then drill into the hottest EIDs. Do not stop at a flat ranking list.
4. For each hot draw, inspect geometry pressure next with renderdoc_getEventDetails and, when needed, renderdoc_getMeshData. Prefer reporting numIndices, numInstances, and topology. Only estimate triangle or face pressure when the topology makes that estimate defensible.
5. After timing and geometry, inspect shader pressure with renderdoc_getShaderInfo or renderdoc_getPipelineState. Use renderdoc_getShaderSource only when the user explicitly wants code. If the user wants Mali advice and no latestMaliAnalysis is present, say that Inspector -> Shaders -> Analyze with Mali Offline Compiler may be needed first.
6. Then inspect texture pressure: bound texture count, suspicious texture resources, and the largest relevant textures by size, dimensions, format, byteSize, and mip levels using renderdoc_getResourceDetail or renderdoc_getTextureInfo.
7. For a specific EID outside a broader performance workflow, start with renderdoc_getEventDetails. Prefer renderdoc_getShaderInfo when the question is about a shader stage together with bindings or constant buffers. Use renderdoc_getPipelineState for broader state, binding, or render-target inspection. Use renderdoc_getMeshData only for geometry, topology, or vertex-layout questions.
8. For texture or resource tracing, start with renderdoc_getResourceDetail or renderdoc_getTextureInfo. Use renderdoc_findDrawsByTexture, renderdoc_findDrawsByShader, or renderdoc_findDrawsByResourceId for reverse lookups. Keep renderdoc_getTextureData requests narrow with specific eventId, mip, or channel when possible.
9. Treat overdraw as a separate rasterization follow-up. Only call it confirmed when direct overlay or preview evidence exists; otherwise describe it as a follow-up validation item.
10. For buffer inspection, identify the exact buffer resource first, fetch a small slice by default, and use offset plus len to paginate larger buffers.
11. When the user wants the project-side owner of a hot pass, shader, or event, use renderdoc_findProjectImplementation.
12. Prefer concise findings first, summarize evidence instead of dumping raw JSON, and when giving optimization advice, organize it by timing, geometry, shader or Mali, textures, overdraw status, and prioritized fixes.`;

    const nativeNote = hasNative
        ? `\n\nNative replay is available. Native-only tools may be used when needed for pipeline state, shader source, mesh data, reverse binding lookups, texture data, and buffer contents.`
        : `\n\nNative replay is not currently available. Do not promise pipeline state, shader source, mesh data, texture data, or buffer contents. Use the non-native tools that still work, and when replay-dependent details matter, say that the native bridge is unavailable and suggest running "RenderDoc: Try Local Replay".`;

    return base + nativeNote;
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
            { name: 'renderdoc_getSelectionContext', description: "Get what the user is focused on in the Inspector panel: focusedEventId, focusedDrawCall, pipelineState, sidebarSelectedResource. Call this first for any question about 'this' / 'the current' / 'the selected' item." },
            { name: 'renderdoc_getCaptureInfo', description: 'Get metadata about the loaded RenderDoc capture file' },
            { name: 'renderdoc_getFrameSummary', description: 'Get a high-level frame overview: top-level passes with child counts, leaf draw/dispatch/clear totals, GPU statistics. Call this FIRST for structural or performance questions.' },
            { name: 'renderdoc_getDrawCalls', description: 'Get draw calls from the capture. Supports filter, markerFilter, excludeMarkers, onlyDrawCalls, eventIdMin, eventIdMax.' },
            { name: 'renderdoc_getResources', description: 'Get GPU resources (textures, buffers, shaders), optionally filtered by type' },
            { name: 'renderdoc_getResourceDetail', description: 'Get detailed information about a specific resource by ID' },
            { name: 'renderdoc_getEventDetails', description: 'Get details of a specific draw call event by event ID' },
            { name: 'renderdoc_getTextureInfo', description: 'Get texture-specific info' },
            { name: 'renderdoc_analyzeFrame', description: 'Comprehensive frame analysis with performance issue detection' },
        ];

        if (hasNative) {
            toolReferences.push(
                { name: 'renderdoc_getActionTimings', description: 'Fetch GPU timings on demand for the current capture, optionally filtered by event IDs or marker groups. Use when timings have not been pre-fetched yet.' },
                { name: 'renderdoc_getPipelineState', description: 'Get GPU pipeline state at a specific event' },
                { name: 'renderdoc_getShaderSource', description: 'Get shader source code at a specific event' },
                { name: 'renderdoc_getShaderInfo', description: 'Get a higher-level shader summary at an event by combining shader metadata/source, bound textures/samplers, and decoded constant buffer contents for one or more stages.' },
                { name: 'renderdoc_findProjectImplementation', description: 'Search the open project for likely shader files and C# pass implementations using a RenderDoc event, shader name, or pass/marker name.' },
                { name: 'renderdoc_getMeshData', description: 'Get vertex/mesh data at a specific event: attribute layout (name, format, perInstance), topology, vertex count, and decoded rows. Supports vsin/vsout/gsout stages. Use to inspect geometry, vertex attributes, position data, or index buffer.' },
                { name: 'renderdoc_findDrawsByShader', description: 'Reverse search: find all event IDs that use a shader by name/entry point substring' },
                { name: 'renderdoc_findDrawsByTexture', description: 'Reverse search: find all event IDs that bind a texture by name substring' },
                { name: 'renderdoc_findDrawsByResourceId', description: 'Reverse search: find all event IDs that bind a specific resource ID' },
                { name: 'renderdoc_getTextureData', description: 'Sample a texture at a specific event/mip and return base64 PNG pixel data' },
                { name: 'renderdoc_getBufferContents', description: 'Read raw bytes from a GPU buffer resource (vertex/index/constant/storage buffers), returned base64-encoded' },
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
