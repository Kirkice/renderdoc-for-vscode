/**
 * Typed error class used everywhere the native bridge can fail.
 *
 * Callers can branch on `err.kind` to distinguish a transient condition
 * (e.g. `restarting`, `timeout`) from a protocol-level bug (`validation`,
 * `remote`) or a hard failure (`unavailable`, `exited`).
 *
 * This replaces the previous soup of `new Error(...)` strings so that
 * `catch` sites don't have to parse free-form messages.
 */

export type BridgeErrorKind =
    | 'unavailable'   // bridge process not spawned or stdin missing
    | 'exited'        // bridge process died while a call was in flight
    | 'restarting'    // bridge was restarted while a call was in flight
    | 'io'            // stdin write failed
    | 'timeout'       // no reply within the configured window
    | 'remote'        // bridge returned a JSON-RPC `error` object
    | 'validation';   // reply parsed but did not match the Zod schema

export interface BridgeErrorOptions {
    method?: string;
    code?: number | string;
    issues?: readonly string[];
    cause?: unknown;
}

export class BridgeError extends Error {
    readonly kind: BridgeErrorKind;
    readonly method?: string;
    readonly code?: number | string;
    readonly issues?: readonly string[];

    constructor(kind: BridgeErrorKind, message: string, opts: BridgeErrorOptions = {}) {
        super(message);
        this.name = 'BridgeError';
        this.kind = kind;
        this.method = opts.method;
        this.code = opts.code;
        this.issues = opts.issues;
        if (opts.cause !== undefined) {
            // `Error.cause` is standard since ES2022 but TS's lib needs this cast.
            (this as { cause?: unknown }).cause = opts.cause;
        }
    }

    static is(e: unknown): e is BridgeError {
        return e instanceof BridgeError;
    }
}
