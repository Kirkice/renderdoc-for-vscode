/**
 * Pure HTML-string builders used by various one-off webview panels in
 * `extension.ts` (shader / pipeline / texture / draw-call / resource detail).
 *
 * Each builder applies a Content-Security-Policy that forbids all sources
 * except the webview origin (for `<style>`/data: images) and a per-load
 * nonce for any inline `<script>` block. Data payloads that originate from
 * the native bridge (notably base64 texture bytes) are embedded via a
 * JSON island so we never string-interpolate into JS.
 *
 * `escapeHtml` is exported for reuse.
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

/** Safely embed JSON inside a `<script type="application/json">` island. */
function embedJson(id: string, value: unknown): string {
    // Escape `</script` to prevent premature tag closure.
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

// ─── Shader panel ─────────────────────────────────────────────────────────
export function getShaderPanelHtml(result: Record<string, unknown>): string {
    const stages: Array<{ name: string; source: string }> = [];
    for (const [stage, src] of Object.entries(result)) {
        if (typeof src === 'string' && src.trim().length > 0) {
            stages.push({ name: stage, source: src });
        }
    }

    const tabs = stages.map((s, i) =>
        `<button class="tab${i === 0 ? ' active' : ''}" data-idx="${i}">${escapeHtml(s.name)}</button>`
    ).join('');
    const contents = stages.map((s, i) =>
        `<pre class="tabcontent" data-idx="${i}" style="${i === 0 ? '' : 'display:none'}">${escapeHtml(s.source)}</pre>`
    ).join('');

    const nonce = generateNonce();
    return `<!DOCTYPE html>
<html><head>
${cspMeta(nonce)}
<style>
  body { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); padding: 8px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 8px; }
  .tab { padding: 6px 16px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); cursor: pointer; border-radius: 4px 4px 0 0; }
  .tab.active { background: var(--vscode-editor-selectionBackground); font-weight: bold; }
  pre { background: var(--vscode-editor-background); padding: 12px; overflow: auto;
        border: 1px solid var(--vscode-panel-border); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
</style></head><body>
  <div class="tabs">${tabs}</div>
  ${contents}
  <script nonce="${nonce}">
    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = btn.getAttribute('data-idx');
        document.querySelectorAll('.tabcontent').forEach(function (el) {
          el.style.display = el.getAttribute('data-idx') === idx ? '' : 'none';
        });
        document.querySelectorAll('.tab').forEach(function (el) {
          el.classList.toggle('active', el.getAttribute('data-idx') === idx);
        });
      });
    });
  </script>
</body></html>`;
}

// ─── Pipeline state (no scripts) ──────────────────────────────────────────
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
    return `<!DOCTYPE html>
<html><head>
${cspMeta(undefined)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  details { margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  summary { cursor: pointer; padding: 8px; background: var(--vscode-editor-selectionBackground); font-weight: bold; }
  pre { padding: 8px 12px; margin: 0; overflow: auto; font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
  .header { font-size: 1.2em; margin-bottom: 12px; }
</style></head><body>
  <div class="header">Pipeline State @ Event ${eventId}</div>
  ${sections}
</body></html>`;
}

// ─── Texture preview (nonced script + JSON island for base64) ─────────────
export function getTexturePreviewHtml(result: any, resourceId: string): string {
    const nonce = generateNonce();
    const payload = {
        base64: typeof result?.base64 === 'string' ? result.base64 : '',
    };
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
${cspMeta(nonce, { allowImgData: true })}
<style>
  body { margin: 0; padding: 16px; background: var(--vscode-editor-background); display: flex; flex-direction: column; align-items: center; font-family: var(--vscode-font-family); }
  .canvas-wrap {
    background-image: linear-gradient(45deg, #808080 25%, transparent 25%),
                      linear-gradient(-45deg, #808080 25%, transparent 25%),
                      linear-gradient(45deg, transparent 75%, #808080 75%),
                      linear-gradient(-45deg, transparent 75%, #808080 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
    background-color: #c0c0c0;
    display: inline-block;
    border: 1px solid var(--vscode-panel-border);
    line-height: 0;
  }
  canvas { display: block; max-width: 90vw; max-height: 80vh; image-rendering: pixelated; }
  .info { color: var(--vscode-descriptionForeground); margin-top: 8px; font-size: 0.85em; }
  .channel-bar { display: flex; gap: 6px; margin-top: 12px; }
  .channel-btn {
    padding: 4px 14px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    border-radius: 4px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 0.85em;
    font-weight: 600; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  .channel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .channel-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style></head><body>
  <div class="canvas-wrap"><canvas id="texCanvas"></canvas></div>
  <div class="info" id="infoLine">${escapeHtml(String(result?.width ?? '?'))}x${escapeHtml(String(result?.height ?? '?'))} &mdash; ${escapeHtml(String(result?.texFormat ?? ''))} &mdash; Resource ID: ${escapeHtml(resourceId)}</div>
  <div class="channel-bar">
    <button class="channel-btn active" data-ch="rgb">RGB</button>
    <button class="channel-btn" data-ch="r">R</button>
    <button class="channel-btn" data-ch="g">G</button>
    <button class="channel-btn" data-ch="b">B</button>
    <button class="channel-btn" data-ch="a">A</button>
  </div>
  ${embedJson('tex-data', payload)}
  <script nonce="${nonce}">
  (function(){
    var data = JSON.parse(document.getElementById('tex-data').textContent || '{}');
    var canvas = document.getElementById('texCanvas');
    var ctx = canvas.getContext('2d');
    var pixels = null;
    var w = 0, h = 0;

    var bin = atob(data.base64 || '');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: 'image/png' });

    createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(function(bmp) {
      w = bmp.width; h = bmp.height;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(bmp, 0, 0);
      pixels = ctx.getImageData(0, 0, w, h).data;
      showChannel('rgb');
    }).catch(function(err) {
      document.getElementById('infoLine').textContent = 'Failed to decode texture: ' + err.message;
    });

    function showChannel(ch) {
      if (!pixels) return;
      var out = ctx.createImageData(w, h);
      var d = out.data, s = pixels, len = s.length, i, v;
      if (ch === 'rgb')      { for (i = 0; i < len; i += 4) { d[i]=s[i]; d[i+1]=s[i+1]; d[i+2]=s[i+2]; d[i+3]=255; } }
      else if (ch === 'r')   { for (i = 0; i < len; i += 4) { v=s[i];   d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255; } }
      else if (ch === 'g')   { for (i = 0; i < len; i += 4) { v=s[i+1]; d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255; } }
      else if (ch === 'b')   { for (i = 0; i < len; i += 4) { v=s[i+2]; d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255; } }
      else if (ch === 'a')   { for (i = 0; i < len; i += 4) { v=s[i+3]; d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255; } }
      ctx.putImageData(out, 0, 0);
    }

    document.querySelectorAll('.channel-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.channel-btn').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        showChannel(btn.getAttribute('data-ch'));
      });
    });
  })();
  </script>
</body></html>`;
}

// ─── Draw call detail (no scripts) ────────────────────────────────────────
export function getDrawCallDetailHtml(item: any): string {
    return `<!DOCTYPE html>
<html><head>
${cspMeta(undefined)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); }
  .header { font-size: 1.2em; margin-bottom: 16px; }
</style></head><body>
  <div class="header">Draw Call #${escapeHtml(String(item?.eventId ?? ''))}</div>
  <table>
    <tr><th>Name</th><td>${escapeHtml(String(item?.label ?? ''))}</td></tr>
    <tr><th>Event ID</th><td>${escapeHtml(String(item?.eventId ?? ''))}</td></tr>
    <tr><th>Draw Index</th><td>${escapeHtml(String(item?.drawIndex ?? ''))}</td></tr>
    <tr><th>Num Indices</th><td>${escapeHtml(String(item?.numIndices ?? ''))}</td></tr>
    <tr><th>Num Instances</th><td>${escapeHtml(String(item?.numInstances ?? ''))}</td></tr>
    <tr><th>Flags</th><td>${escapeHtml(String(item?.flags ?? ''))}</td></tr>
  </table>
</body></html>`;
}

// ─── Resource detail (no scripts) ─────────────────────────────────────────
export function getResourceDetailHtml(detail: any): string {
    if (!detail) {
        return '<html><body>No detail available.</body></html>';
    }
    const rows = Object.entries(detail)
        .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
        .join('');
    return `<!DOCTYPE html>
<html><head>
${cspMeta(undefined)}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); width: 200px; }
  .header { font-size: 1.2em; margin-bottom: 16px; }
</style></head><body>
  <div class="header">Resource Details</div>
  <table>${rows}</table>
</body></html>`;
}
