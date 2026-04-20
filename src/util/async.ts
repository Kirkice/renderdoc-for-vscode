/**
 * Shared async utilities.
 *
 * `withTimeout` guarantees the returned promise settles within `ms`
 * milliseconds. If the underlying promise has not settled by then the
 * returned promise rejects with an Error whose message is `message`.
 *
 * The underlying promise is NOT cancelled — JavaScript has no native
 * cancellation for arbitrary promises — but the caller is unblocked.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error(message));
            }
        }, ms);
        p.then(
            (v) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            (e) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    reject(e);
                }
            },
        );
    });
}
