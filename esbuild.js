// esbuild configuration for bundling the extension host code.
// The webview assets under `media/` are shipped as-is (no bundling needed).
//
// Usage:
//   node esbuild.js               # one-shot development build
//   node esbuild.js --watch       # rebuild on file change
//   node esbuild.js --production  # minified production build
//
// Entry point: src/extension.ts  →  dist/extension.js

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    // vscode is resolved by the host, never bundle it.
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    // Prevent esbuild from renaming class/function names that appear in
    // serialized panel identifiers or error messages.
    keepNames: true,
};

async function run() {
    if (watch) {
        const ctx = await esbuild.context(baseOptions);
        await ctx.watch();
        console.log('[esbuild] watching...');
    } else {
        await esbuild.build(baseOptions);
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
