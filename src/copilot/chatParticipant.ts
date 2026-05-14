import * as vscode from 'vscode';
import { buildRenderDocSystemPrompt } from '../ai/prompt';
import { getRenderDocChatToolReferences } from '../ai/toolRuntime';
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

        const toolReferences: vscode.LanguageModelChatTool[] = getRenderDocChatToolReferences(hasNative);

        try {
            const model = request.model;
            if (!model) {
                stream.markdown('No language model is currently selected for chat.');
                return { metadata: { command: '' } };
            }

            // Build messages
            const messages = [
                vscode.LanguageModelChatMessage.User(buildRenderDocSystemPrompt(hasNative)),
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
