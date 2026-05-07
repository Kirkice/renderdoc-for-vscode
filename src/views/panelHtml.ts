/**
 * Pure HTML-string builders used by various one-off webview panels in
 * `extension.ts` (shader / pipeline / texture / draw-call / resource detail).
 */

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}

function embedJson(id: string, value: unknown): string {
    const payload = JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
    return `<script id="${id}" type="application/json">${payload}</script>`;
}

function cspMeta(nonce: string | undefined, opts: { allowImgData?: boolean } = {}): string {
    const directives = [
        `default-src 'none'`,
        `style-src 'unsafe-inline'`,
        `img-src data:${opts.allowImgData ? ' blob:' : ''}`,
    ];
    if (nonce) { directives.push(`script-src 'nonce-${nonce}'`); }
    return `<meta http-equiv="Content-Security-Policy" content="${directives.join('; ')}">`;
}

function themeCss(extra = ''): string {
    return `
        :root {
            color-scheme: dark;
            --bg-0: #10151c;
            --bg-1: #171e27;
            --bg-2: #202937;
            --card: rgba(24, 31, 40, 0.96);
            --card-strong: rgba(28, 36, 47, 0.98);
            --line: rgba(133, 152, 173, 0.18);
            --line-strong: rgba(112, 208, 198, 0.38);
            --accent: #70d0c6;
            --accent-warm: #c98b52;
            --text-dim: rgba(234, 240, 245, 0.66);
            --text-mono: #dbe6ee;
            --shadow: 0 24px 56px rgba(0, 0, 0, 0.28);
            --checker-a: #1d232b;
            --checker-b: #28313d;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; min-height: 100%; }
        body {
            font-family: "Segoe UI Variable Text", "Bahnschrift", "Segoe UI", sans-serif;
            color: #eef4f8;
            background:
                radial-gradient(circle at top left, rgba(112, 208, 198, 0.12), transparent 30%),
                radial-gradient(circle at top right, rgba(201, 139, 82, 0.12), transparent 24%),
                linear-gradient(180deg, var(--bg-1), var(--bg-0) 60%, #0d1217 100%);
        }
        .shell {
            max-width: 1180px;
            margin: 0 auto;
            padding: 20px;
            display: grid;
            gap: 16px;
        }
        .hero,
        .surface,
        .stageCard,
        .tableCard,
        .actionCard {
            position: relative;
            overflow: hidden;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: linear-gradient(180deg, rgba(30, 38, 49, 0.98), rgba(18, 24, 31, 0.98));
            box-shadow: var(--shadow);
        }
        .hero::after,
        .surface::after,
        .stageCard::after,
        .tableCard::after,
        .actionCard::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(135deg, rgba(112, 208, 198, 0.07), transparent 34%, rgba(201, 139, 82, 0.08));
        }
        .hero {
            padding: 18px 20px;
            display: grid;
            gap: 10px;
        }
        .eyebrow {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.16em;
            color: var(--text-dim);
        }
        .heroTitle {
            font-size: 25px;
            line-height: 1.08;
            font-weight: 760;
            max-width: 20ch;
        }
        .heroMeta,
        .surfaceMeta,
        .empty,
        .note {
            font-size: 12px;
            line-height: 1.55;
            color: var(--text-dim);
        }
        .heroMeta code,
        .surfaceMeta code,
        .note code {
            font-family: Consolas, "Cascadia Code", monospace;
            color: var(--text-mono);
        }
        .surface,
        .tableCard,
        .actionCard {
            padding: 16px;
        }
        .surfaceTitle {
            font-size: 15px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        .surfaceHeader {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }
        .badge,
        .pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            width: fit-content;
            padding: 5px 10px;
            border-radius: 999px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            border: 1px solid rgba(112, 208, 198, 0.28);
            background: rgba(112, 208, 198, 0.12);
            color: #def8f4;
        }
        .pill.muted,
        .badge.muted {
            border-color: rgba(133, 152, 173, 0.2);
            background: rgba(133, 152, 173, 0.08);
            color: #d8dfe7;
        }
        .tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .tab {
            border: 1px solid rgba(133, 152, 173, 0.2);
            background: rgba(133, 152, 173, 0.08);
            color: #dce4eb;
            border-radius: 999px;
            padding: 8px 14px;
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            font-weight: 700;
            transition: transform 160ms ease, border-color 160ms ease, filter 160ms ease;
        }
        .tab:hover { transform: translateY(-1px); filter: brightness(1.05); }
        .tab.active {
            border-color: rgba(112, 208, 198, 0.34);
            background: rgba(112, 208, 198, 0.14);
            color: #effbf8;
        }
        .tabPanel { display: none; }
        .tabPanel.active { display: block; }
        pre,
        .codeBlock {
            margin: 0;
            padding: 16px;
            overflow: auto;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: Consolas, "Cascadia Code", monospace;
            font-size: 12.5px;
            line-height: 1.55;
            color: var(--text-mono);
            border: 1px solid rgba(133, 152, 173, 0.14);
            border-radius: 14px;
            background: rgba(10, 14, 19, 0.7);
        }
        details {
            border: 1px solid rgba(133, 152, 173, 0.18);
            border-radius: 14px;
            overflow: hidden;
            background: rgba(16, 21, 28, 0.74);
        }
        details + details { margin-top: 10px; }
        summary {
            cursor: pointer;
            padding: 12px 14px;
            font-size: 13px;
            font-weight: 700;
            list-style: none;
            background: rgba(112, 208, 198, 0.08);
            border-bottom: 1px solid rgba(133, 152, 173, 0.14);
        }
        details[open] summary { border-bottom-color: rgba(112, 208, 198, 0.16); }
        .stageCard {
            padding: 18px;
            display: grid;
            gap: 12px;
            justify-items: center;
        }
        .checker {
            width: 100%;
            min-height: 220px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            border: 1px solid rgba(133, 152, 173, 0.14);
            border-radius: 14px;
            background:
                linear-gradient(45deg, var(--checker-a) 25%, transparent 25%) 0 0 / 18px 18px,
                linear-gradient(-45deg, var(--checker-a) 25%, transparent 25%) 0 9px / 18px 18px,
                linear-gradient(45deg, transparent 75%, var(--checker-a) 75%) 9px -9px / 18px 18px,
                linear-gradient(-45deg, transparent 75%, var(--checker-a) 75%) 9px 0 / 18px 18px,
                var(--checker-b);
        }
        .checker canvas,
        .checker img {
            max-width: 100%;
            max-height: min(70vh, 780px);
            display: block;
            image-rendering: pixelated;
        }
        .toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .toolButton {
            min-height: 38px;
            padding: 0 14px;
            border-radius: 12px;
            border: 1px solid rgba(133, 152, 173, 0.18);
            background: rgba(133, 152, 173, 0.08);
            color: #dce4eb;
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            font-weight: 700;
            transition: transform 160ms ease, border-color 160ms ease, filter 160ms ease;
        }
        .toolButton:hover { transform: translateY(-1px); filter: brightness(1.05); }
        .toolButton.active {
            border-color: rgba(112, 208, 198, 0.34);
            background: rgba(112, 208, 198, 0.14);
            color: #effbf8;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
        }
        th, td {
            text-align: left;
            padding: 11px 12px;
            border-bottom: 1px solid rgba(133, 152, 173, 0.14);
            vertical-align: top;
        }
        th {
            width: 220px;
            color: var(--text-dim);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-weight: 700;
        }
        td {
            color: #eef4f8;
            font-family: Consolas, "Cascadia Code", monospace;
            font-size: 12.5px;
        }
        tr:last-child th,
        tr:last-child td { border-bottom: none; }
        @media (max-width: 800px) {
            .shell { padding: 14px; }
            .heroTitle { font-size: 22px; }
            th, td {
                display: block;
                width: 100%;
            }
            th {
                padding-bottom: 4px;
                border-bottom: none;
            }
            td {
                padding-top: 0;
            }
        }
        ${extra}
    `;
}

function themedDocument(options: {
    title: string;
    subtitle?: string;
    content: string;
    nonce?: string;
    allowImgData?: boolean;
    extraCss?: string;
    script?: string;
}): string {
    const nonceAttr = options.nonce ? ` nonce="${options.nonce}"` : '';
    const subtitle = options.subtitle ? `<div class="heroMeta">${options.subtitle}</div>` : '';
    const script = options.script ? `<script${nonceAttr}>${options.script}</script>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta(options.nonce, { allowImgData: options.allowImgData })}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title)}</title>
<style>${themeCss(options.extraCss)}</style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div class="eyebrow">RenderDoc Panel</div>
      <div class="heroTitle">${escapeHtml(options.title)}</div>
      ${subtitle}
    </div>
    ${options.content}
  </div>
  ${script}
</body>
</html>`;
}

export function getShaderPanelHtml(result: Record<string, unknown>): string {
    const stages: Array<{ name: string; source: string }> = [];
    for (const [stage, src] of Object.entries(result)) {
        if (typeof src === 'string' && src.trim().length > 0) {
            stages.push({ name: stage, source: src });
        }
    }

    const nonce = generateNonce();
    const tabs = stages.map((stage, index) =>
        `<button class="tab${index === 0 ? ' active' : ''}" data-idx="${index}">${escapeHtml(stage.name)}</button>`
    ).join('');
    const panels = stages.map((stage, index) =>
        `<div class="tabPanel${index === 0 ? ' active' : ''}" data-idx="${index}"><pre>${escapeHtml(stage.source)}</pre></div>`
    ).join('');

    return themedDocument({
        title: 'Shader Sources',
        subtitle: 'Stage tabs stay compact while the code view uses the same darker material and accent system as the redesigned capture workflow.',
        nonce,
        content: `
            <div class="surface">
              <div class="surfaceHeader">
                <div class="surfaceTitle">Available Stages</div>
                <div class="pill ${stages.length ? '' : 'muted'}">${stages.length} stage${stages.length === 1 ? '' : 's'}</div>
              </div>
              <div class="tabs">${tabs || '<div class="empty">No shader sources were returned for this event.</div>'}</div>
              ${panels || '<div class="empty">No shader sources were returned for this event.</div>'}
            </div>
        `,
        script: `
            document.querySelectorAll('.tab').forEach(function(button) {
                button.addEventListener('click', function() {
                    var idx = button.getAttribute('data-idx');
                    document.querySelectorAll('.tab').forEach(function(tab) {
                        tab.classList.toggle('active', tab.getAttribute('data-idx') === idx);
                    });
                    document.querySelectorAll('.tabPanel').forEach(function(panel) {
                        panel.classList.toggle('active', panel.getAttribute('data-idx') === idx);
                    });
                });
            });
        `,
    });
}

export function getPipelineStateHtml(state: any, eventId: number): string {
    const json = JSON.stringify(state, null, 2);
    let sections = '';
    if (typeof state === 'object' && state !== null) {
        for (const [key, value] of Object.entries(state)) {
            const content = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
            sections += `<details open><summary>${escapeHtml(key)}</summary><pre>${escapeHtml(content)}</pre></details>`;
        }
    } else {
        sections = `<pre>${escapeHtml(json)}</pre>`;
    }

    return themedDocument({
        title: `Pipeline State @ Event ${eventId}`,
        subtitle: 'Pipeline sections are grouped into collapsible cards so large state dumps remain easier to scan.',
        content: `<div class="surface"><div class="surfaceTitle">State Sections</div>${sections}</div>`,
    });
}

export function getTexturePreviewHtml(result: any, resourceId: string): string {
    const nonce = generateNonce();
    const payload = {
        base64: typeof result?.base64 === 'string' ? result.base64 : '',
    };
    const width = String(result?.width ?? '?');
    const height = String(result?.height ?? '?');
    const format = String(result?.texFormat ?? 'Unknown');

    return themedDocument({
        title: 'Texture Preview',
        subtitle: `Resource <code>${escapeHtml(resourceId)}</code> · ${escapeHtml(width)}×${escapeHtml(height)} · ${escapeHtml(format)}`,
        nonce,
        allowImgData: true,
        content: `
            <div class="stageCard">
              <div class="checker"><canvas id="texCanvas"></canvas></div>
              <div class="surfaceMeta" id="infoLine">${escapeHtml(width)}×${escapeHtml(height)} · ${escapeHtml(format)} · Resource ID: ${escapeHtml(resourceId)}</div>
              <div class="toolbar">
                <button class="toolButton active" data-ch="rgb">RGB</button>
                <button class="toolButton" data-ch="r">R</button>
                <button class="toolButton" data-ch="g">G</button>
                <button class="toolButton" data-ch="b">B</button>
                <button class="toolButton" data-ch="a">A</button>
              </div>
            </div>
            ${embedJson('tex-data', payload)}
        `,
        script: `
            (function() {
                var data = JSON.parse(document.getElementById('tex-data').textContent || '{}');
                var canvas = document.getElementById('texCanvas');
                var ctx = canvas.getContext('2d');
                var pixels = null;
                var w = 0;
                var h = 0;
                var bin = atob(data.base64 || '');
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                var blob = new Blob([bytes], { type: 'image/png' });

                createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(function(bitmap) {
                    w = bitmap.width;
                    h = bitmap.height;
                    canvas.width = w;
                    canvas.height = h;
                    ctx.drawImage(bitmap, 0, 0);
                    pixels = ctx.getImageData(0, 0, w, h).data;
                    showChannel('rgb');
                }).catch(function(err) {
                    document.getElementById('infoLine').textContent = 'Failed to decode texture: ' + err.message;
                });

                function showChannel(channel) {
                    if (!pixels) return;
                    var out = ctx.createImageData(w, h);
                    var d = out.data;
                    var s = pixels;
                    var len = s.length;
                    var i;
                    var value;
                    if (channel === 'rgb') {
                        for (i = 0; i < len; i += 4) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255; }
                    } else if (channel === 'r') {
                        for (i = 0; i < len; i += 4) { value = s[i]; d[i] = value; d[i + 1] = value; d[i + 2] = value; d[i + 3] = 255; }
                    } else if (channel === 'g') {
                        for (i = 0; i < len; i += 4) { value = s[i + 1]; d[i] = value; d[i + 1] = value; d[i + 2] = value; d[i + 3] = 255; }
                    } else if (channel === 'b') {
                        for (i = 0; i < len; i += 4) { value = s[i + 2]; d[i] = value; d[i + 1] = value; d[i + 2] = value; d[i + 3] = 255; }
                    } else if (channel === 'a') {
                        for (i = 0; i < len; i += 4) { value = s[i + 3]; d[i] = value; d[i + 1] = value; d[i + 2] = value; d[i + 3] = 255; }
                    }
                    ctx.putImageData(out, 0, 0);
                }

                document.querySelectorAll('.toolButton').forEach(function(button) {
                    button.addEventListener('click', function() {
                        document.querySelectorAll('.toolButton').forEach(function(entry) {
                            entry.classList.remove('active');
                        });
                        button.classList.add('active');
                        showChannel(button.getAttribute('data-ch'));
                    });
                });
            })();
        `,
    });
}

export function getDrawCallDetailHtml(item: any): string {
    return themedDocument({
        title: `Draw Call #${escapeHtml(String(item?.eventId ?? ''))}`,
        subtitle: 'Draw metadata uses the same table treatment as the rest of the redesigned utility windows.',
        content: `
            <div class="tableCard">
              <table>
                <tr><th>Name</th><td>${escapeHtml(String(item?.label ?? ''))}</td></tr>
                <tr><th>Event ID</th><td>${escapeHtml(String(item?.eventId ?? ''))}</td></tr>
                <tr><th>Draw Index</th><td>${escapeHtml(String(item?.drawIndex ?? ''))}</td></tr>
                <tr><th>Num Indices</th><td>${escapeHtml(String(item?.numIndices ?? ''))}</td></tr>
                <tr><th>Num Instances</th><td>${escapeHtml(String(item?.numInstances ?? ''))}</td></tr>
                <tr><th>Flags</th><td>${escapeHtml(String(item?.flags ?? ''))}</td></tr>
              </table>
            </div>
        `,
    });
}

export function getResourceDetailHtml(detail: any): string {
    if (!detail) {
        return themedDocument({
            title: 'Resource Details',
            subtitle: 'No detail was returned for the selected resource.',
            content: '<div class="surface"><div class="empty">No detail available.</div></div>',
        });
    }

    const rows = Object.entries(detail)
        .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
        .join('');

    return themedDocument({
        title: 'Resource Details',
        subtitle: 'Resource properties are shown in a denser structured table for quick scanning.',
        content: `<div class="tableCard"><table>${rows}</table></div>`,
    });
}
