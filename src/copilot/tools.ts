import * as vscode from 'vscode';
import {
    getRenderDocToolDefinitions,
    initRenderDocToolRuntime,
    type RenderDocToolDefinition,
} from '../ai/toolRuntime';
import { DrawCall } from '../types';
import { RenderDocBridge } from '../renderdocBridge';

export function initTools(
    bridge: RenderDocBridge,
    getCurrentCapturePath: () => string | undefined,
    getSelectionContext: () => { selectedDrawCall: any; selectedResource: any },
    getCurrentDrawCalls?: () => DrawCall[],
) {
    initRenderDocToolRuntime({
        bridge,
        getCurrentCapturePath,
        getSelectionContext,
        getCurrentDrawCalls,
    });
}

function formatToolResult(result: unknown): string {
    if (typeof result === 'string') {
        return result;
    }
    return JSON.stringify(result, null, 2);
}

class RuntimeLanguageModelTool<Input> implements vscode.LanguageModelTool<Input> {
    constructor(private readonly definition: RenderDocToolDefinition<Input>) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const result = await this.definition.invoke(options.input);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatToolResult(result)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: this.definition.prepareInvocationMessage(options.input),
        };
    }
}

export function registerAllTools(context: vscode.ExtensionContext) {
    const registrations = getRenderDocToolDefinitions().map((definition) => {
        return vscode.lm.registerTool(definition.name, new RuntimeLanguageModelTool(definition));
    });
    context.subscriptions.push(...registrations);
}
