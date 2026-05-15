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
 * System prompt that gives the model context about RenderDoc analysis capabilities.
 *
 * Note: All capture data is exposed via LanguageModelTools — the model must
 * call them to inspect the capture. We do NOT pre-serialize capture content
 * into the prompt; doing so would waste tokens and lose structure.
 */
function buildSystemPrompt(hasNative: boolean): string {
    const base = `You are a GPU graphics debugging assistant integrated with RenderDoc. You help analyze GPU captures (.rdc files) to diagnose rendering issues, optimize performance, and understand GPU workloads.

All capture data is accessed via tools — you must invoke them to read the capture. Do not guess or fabricate event IDs, resource IDs, or shader content.

Available tools:
- renderdoc_getSelectionContext — What the user is currently focused on in the Inspector panel (focusedEventId, focusedDrawCall, pipelineState, sidebarSelectedResource). ALWAYS call this first when the user refers to "this draw call", "this shader", "the current event", "the selected texture", etc.
- renderdoc_getCaptureInfo — Capture metadata (API, driver, version, sections)
- renderdoc_getDrawCalls — Draw call / event tree for the frame (supports filter). Each draw call may include a 'durationUs' field (GPU time in microseconds) if the user has run "Fetch GPU Timings". The 'expensiveDraws' array contains the true top 50 most expensive draws sorted by 'durationUs' — USE THIS EXACT FIELD to identify slow draws and performance bottlenecks. Never sort by vertex count or index count as a proxy for time! YOU MUST look at the hierarchy and name markers carefully.
- renderdoc_getResources — GPU resource list: textures, buffers, shaders (supports type filter)
- renderdoc_getResourceDetail — Full info for a specific resource by ID
- renderdoc_getEventDetails — Full details for a specific event by ID (includes pipeline state when native bridge is up)
- renderdoc_getTextureInfo — Texture-specific info
- renderdoc_analyzeFrame — Comprehensive frame summary with flagged issues`;

    const nativeCapabilities = hasNative
        ? `\n- renderdoc_getPipelineState — Full pipeline state at an event (bound shaders, textures, vertex/index buffers, render targets, rasterizer state [fillMode/cullMode/depthBias/...], depth-stencil state [depthEnable/depthFunc/stencilOps/...], blend state per RT [src/dst/op], sampler descriptors [filter/addressMode/compareFunc/LOD/...])\n- renderdoc_getShaderSource — GLSL/HLSL source for all bound stages at an event\n- renderdoc_getMeshData — Vertex/mesh data at an event: attribute layout (POSITION/NORMAL/TEXCOORD/etc with format), topology (TriangleList/etc), total vertex count, decoded vertex rows. Supports vsin (input to VS), vsout (post-VS), gsout (post-GS). Defaults to 32 rows; request more with maxVertices.`
        : `\n\nNote: The native replay bridge is not currently running, so pipeline state and shader source are unavailable. Report this limitation to the user when it matters and suggest running "RenderDoc: Try Local Replay".`;

    return base + nativeCapabilities + `

Workflow guidance:
1. For any question about "this X", "the selected X", or "the current event" — call renderdoc_getSelectionContext FIRST.
2. When the user asks about an event/resource without specifying an ID — use the focusedEventId from selection context.
3. Only fetch full shader source (renderdoc_getShaderSource) when the user explicitly asks to see/analyze shader code — it can be large.
4. Use renderdoc_getCaptureInfo early to know the graphics API (OpenGL/Vulkan/D3D11/D3D12); this affects advice.
5. When the user asks to analyze "high-cost draws", "performance bottlenecks", or to sort by "耗时" in a frame, you MUST specifically look at the 'expensiveDraws' field (if present) to find the highest cost ACTUAL DRAW CALLS (e.g., \`glDrawElements\`, \`glDrawArrays\`, \`DrawIndexed\`, \`DrawInstanced\`, \`DispatchType\`) sorted EXACTLY by their 'durationUs'. Do NOT sort by vertex/index count as a surrogate. Filter out non-draw operations like \`glClear\`, \`glPopDebugGroup\`, \`SwapBuffers\`, or state changes.
6. CRITICAL for high-cost draws: You MUST print the full logical hierarchy path (the parent marker groups) for each expensive leaf draw call, so the user knows exactly WHICH object is being rendered (e.g., \`UniversalRenderPipeline -> DrawSRPBatcher -> glDrawElements (500 μs)\`). Never just print "glDrawElements" without its surrounding context groups.
7. Look for common issues: overdraw, redundant state changes, large textures, excessive draw calls, unused bindings, mismatched blend/depth state.
8. Reference events by EID in your response (e.g. "EID 142") so the user can navigate.

Formatting:
- Use concise headings for sections.
- Use tables for comparing multiple resources/stages.
- Inline code ticks for API names, formats (e.g. \`GL_RGBA8\`), and resource/event IDs.
- Do not echo back large JSON blobs — summarize.`;
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
                { name: 'renderdoc_getMeshData', description: 'Get vertex/mesh data at a specific event: attribute layout (name, format, perInstance), topology, vertex count, and decoded rows. Supports vsin/vsout/gsout stages. Use to inspect geometry, vertex attributes, position data, or index buffer.' },
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
