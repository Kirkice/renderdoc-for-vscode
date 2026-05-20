import * as vscode from 'vscode';

export type RenderDocDiagnosticLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const CHANNEL_NAME = 'RenderDoc Diagnostics';
const MAX_RECENT_LINES = 800;

let channel: vscode.OutputChannel | undefined;
const recentLines: string[] = [];

function ensureChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    }
    return channel;
}

function appendLine(line: string): void {
    recentLines.push(line);
    if (recentLines.length > MAX_RECENT_LINES) {
        recentLines.splice(0, recentLines.length - MAX_RECENT_LINES);
    }
    ensureChannel().appendLine(line);
}

function formatUnknown(value: unknown): string {
    if (value instanceof Error) {
        const lines: string[] = [];
        lines.push(`${value.name}: ${value.message}`);
        if (value.stack) {
            lines.push(value.stack);
        }
        const cause = (value as { cause?: unknown }).cause;
        if (cause !== undefined) {
            lines.push(`Cause: ${formatUnknown(cause)}`);
        }
        return lines.join('\n');
    }
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (value === null) {
        return 'null';
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function formatDetailLines(details: unknown): string[] {
    const text = formatUnknown(details).trim();
    if (!text) {
        return [];
    }
    return text.split(/\r?\n/);
}

export function logRenderDocDiagnostic(
    level: RenderDocDiagnosticLevel,
    message: string,
    details?: unknown,
): void {
    const timestamp = new Date().toISOString();
    appendLine(`${timestamp} [${level}] ${message}`);
    if (details === undefined) {
        return;
    }
    for (const line of formatDetailLines(details)) {
        appendLine(`${timestamp} [${level}]   ${line}`);
    }
}

export function logRenderDocInfo(message: string, details?: unknown): void {
    logRenderDocDiagnostic('INFO', message, details);
}

export function logRenderDocWarning(message: string, details?: unknown): void {
    logRenderDocDiagnostic('WARN', message, details);
}

export function logRenderDocError(message: string, details?: unknown): void {
    logRenderDocDiagnostic('ERROR', message, details);
}

export function showRenderDocDiagnostics(preserveFocus = false): void {
    ensureChannel().show(preserveFocus);
}

export function getRecentRenderDocDiagnostics(): string {
    return recentLines.join('\n');
}

export async function copyRecentRenderDocDiagnosticsToClipboard(): Promise<number> {
    const text = getRecentRenderDocDiagnostics();
    await vscode.env.clipboard.writeText(text);
    return recentLines.length;
}