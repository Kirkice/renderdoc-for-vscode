import type { LiveSessionPhase } from './launchTargetState';

const allowedTransitions: Record<LiveSessionPhase, readonly LiveSessionPhase[]> = {
    idle: ['checking', 'launching', 'running'],
    checking: ['ready', 'launching', 'failed', 'idle'],
    ready: ['launching', 'running', 'capturing', 'failed', 'idle'],
    launching: ['running', 'ready', 'failed', 'idle'],
    running: ['capturing', 'completed', 'failed', 'idle'],
    capturing: ['completed', 'running', 'failed', 'idle'],
    completed: ['capturing', 'running', 'launching', 'failed', 'idle'],
    failed: ['checking', 'launching', 'running', 'capturing', 'idle'],
};

export function isValidSessionTransition(from: LiveSessionPhase, to: LiveSessionPhase): boolean {
    return from === to || allowedTransitions[from].includes(to);
}
