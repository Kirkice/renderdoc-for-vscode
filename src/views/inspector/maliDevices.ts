export const MALI_OFFLINE_COMPILER_DEVICES = [
    'Mali-G725',
    'Mali-G720',
    'Mali-G715',
    'Mali-G710',
    'Mali-G625',
    'Mali-G620',
    'Mali-G615',
    'Mali-G610',
    'Mali-G510',
    'Mali-G310',
    'Mali-G78',
    'Mali-G77',
    'Mali-G76',
    'Mali-G72',
    'Mali-G71',
    'Mali-G68',
    'Mali-G57',
    'Mali-G52',
    'Mali-G31',
] as const;

const MALI_OFFLINE_COMPILER_DEVICE_SET = new Set<string>(MALI_OFFLINE_COMPILER_DEVICES);

export function normalizeMaliOfflineCompilerDevice(device: string | undefined | null): string | undefined {
    const normalized = device?.trim();
    if (!normalized) {
        return undefined;
    }
    return MALI_OFFLINE_COMPILER_DEVICE_SET.has(normalized) ? normalized : undefined;
}