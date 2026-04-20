
(() => {
    const vscode = acquireVsCodeApi();
    const state = {
        captureInfo: null,
        drawCalls: [],
        resources: [],
        eventId: null,
        drawCall: null,
        shaders: null,
        pipeline: null,
        activeTab: 'overview',
        activeShaderStage: null,
        eventFilter: '',
        texFilter: '',
        modalResource: null,
        modalChannel: -1,
        eventScope: 'all',   // 'all' | 'group'
        texScope: 'all',     // 'all' | 'draw'
    };

    // Build resourceId -> resource info lookup (strings for consistent key match)
    const resById = () => {
        const m = new Map();
        for (const r of state.resources) m.set(String(r.resourceId), r);
        return m;
    };
    const resName = (rid) => {
        const r = resById().get(String(rid));
        return r ? (r.name || ('Resource ' + rid)) : ('Resource ' + rid);
    };

    // ── Tab switching ──────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    function switchTab(tab) {
        state.activeTab = tab;
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
        document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
        render();
    }

    // ── Toolbar ────────────────────────────────────────────────────
    document.getElementById('btn-prev-event').addEventListener('click', () => navigateEvent(-1));
    document.getElementById('btn-next-event').addEventListener('click', () => navigateEvent(+1));
    document.getElementById('btn-jump').addEventListener('click', () => {
        const v = parseInt(document.getElementById('event-jump').value, 10);
        if (!isNaN(v)) vscode.postMessage({ type: 'selectEvent', eventId: v });
    });
    document.getElementById('event-jump').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-jump').click();
    });

    function flattenEvents(list, out = []) {
        for (const dc of list) {
            out.push(dc);
            if (dc.children?.length) flattenEvents(dc.children, out);
        }
        return out;
    }
    // Find the smallest marker / parent node whose subtree contains the given EID.
    // If the event is a top-level leaf, returns null (caller falls back to root list).
    function findParentGroup(list, eventId, parent = null) {
        for (const dc of list) {
            if (dc.eventId === eventId) return parent;
            if (dc.children?.length) {
                const found = findParentGroup(dc.children, eventId, dc);
                if (found !== null) return found;
                // Also consider this node as a candidate if a descendant matches
                const contains = flattenEvents(dc.children).some(c => c.eventId === eventId);
                if (contains) return dc;
            }
        }
        return null;
    }
    function navigateEvent(delta) {
        const flat = flattenEvents(state.drawCalls);
        if (!flat.length) return;
        let idx = flat.findIndex(dc => dc.eventId === state.eventId);
        if (idx < 0) idx = 0;
        else idx = Math.max(0, Math.min(flat.length - 1, idx + delta));
        vscode.postMessage({ type: 'selectEvent', eventId: flat[idx].eventId });
    }

    // ── Filters ────────────────────────────────────────────────────
    document.getElementById('evt-filter').addEventListener('input', e => {
        state.eventFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'events') renderEvents();
    });
    document.getElementById('tex-filter').addEventListener('input', e => {
        state.texFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'textures') renderTextures();
    });

    // ── Scope toggles ─────────────────────────────────────────────
    document.querySelectorAll('.scope-toggle').forEach(group => {
        group.querySelectorAll('.scope').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.scope').forEach(b => b.classList.toggle('active', b === btn));
                const kind = group.dataset.scope;
                if (kind === 'tex') { state.texScope = btn.dataset.val; renderTextures(); }
                else if (kind === 'evt') { state.eventScope = btn.dataset.val; renderEvents(); }
            });
        });
    });

    // ── Message router ─────────────────────────────────────────────
    window.addEventListener('message', ev => {
        const m = ev.data;
        console.log('[Inspector webview] msg:', m.type);
        switch (m.type) {
            case 'captureLoaded':
                state.captureInfo = m.captureInfo;
                state.drawCalls = m.drawCalls || [];
                state.resources = m.resources || [];
                render();
                break;
            case 'eventChanged':
                {
                    const sameEvent = state.eventId === m.eventId;
                    state.eventId = m.eventId;
                    state.drawCall = m.drawCall;
                    if (!sameEvent) {
                        state.shaders = null;
                        state.pipeline = null;
                    }
                    updateHeader();
                    render();
                }
                break;
            case 'shadersLoaded':
                if (m.eventId === state.eventId) {
                    state.shaders = m.data;
                    if (state.activeTab === 'shaders') renderShaders();
                }
                break;
            case 'pipelineLoaded':
                if (m.eventId === state.eventId) {
                    state.pipeline = m.data;
                    if (state.activeTab === 'pipeline' || state.activeTab === 'overview') render();
                }
                break;
            case 'texturePreview':
                handleTexturePreview(m);
                break;
        }
    });

    // ── Header ─────────────────────────────────────────────────────
    function updateHeader() {
        const lbl = document.getElementById('event-label');
        const apiBadge = document.getElementById('api-badge');
        if (state.eventId != null) {
            const name = state.drawCall?.name || '(unknown)';
            lbl.textContent = 'EID ' + state.eventId + ' — ' + name;
        } else {
            lbl.textContent = 'No event selected';
        }
        if (state.captureInfo?.api) {
            apiBadge.textContent = state.captureInfo.api;
            apiBadge.hidden = false;
        } else if (state.pipeline?.api) {
            apiBadge.textContent = state.pipeline.api;
            apiBadge.hidden = false;
        } else {
            apiBadge.hidden = true;
        }
    }

    // ── Overview ───────────────────────────────────────────────────
    function renderOverview() {
        const body = document.getElementById('overview-body');
        if (!state.captureInfo) { body.textContent = 'Load a capture to begin.'; body.className = 'empty-state'; return; }
        body.className = '';
        const info = state.captureInfo;
        const drawCount = flattenEvents(state.drawCalls).length;
        const texCount = state.resources.filter(r => r.type === 'Texture').length;
        const bufCount = state.resources.filter(r => r.type === 'Buffer').length;
        const shdCount = state.resources.filter(r => r.type === 'Shader').length;

        let html = '<div class="stat-row">';
        html += stat(drawCount, 'Events');
        html += stat(texCount, 'Textures');
        html += stat(bufCount, 'Buffers');
        html += stat(shdCount, 'Shaders');
        html += '</div>';

        html += '<div class="info-grid">';
        for (const [k, v] of [
            ['API', info.api],
            ['Driver', info.driver],
            ['RenderDoc Version', info.rdocVersion],
            ['Machine ID', info.machineIdent],
            ['Timestamp', info.timestamp],
            ['Frame Count', info.frameCount],
            ['Sections', info.sectionCount],
            ['File', info.filePath],
        ]) {
            if (v == null || v === '') continue;
            html += '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
        }
        html += '</div>';

        if (state.drawCall) {
            html += '<h3>Current Event</h3>';
            html += '<div class="info-grid">';
            for (const [k, v] of [
                ['EID', state.drawCall.eventId],
                ['Name', state.drawCall.name],
                ['Indices', state.drawCall.numIndices],
                ['Instances', state.drawCall.numInstances],
                ['Flags', state.drawCall.flags],
            ]) {
                if (v == null || v === '' || v === 0) continue;
                html += '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
            }
            html += '</div>';
        }
        body.innerHTML = html;
    }
    const stat = (n, l) => '<div class="stat-card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';

    // ── Pipeline ───────────────────────────────────────────────────
    // Full graphics pipeline flow. Mirrors the RenderDoc desktop layout.
    // Inactive stages are greyed out. Compute pipeline is shown as a
    // separate card below.
    const GFX_PIPELINE = [
        { id: 'ia',       kind: 'Fixed',  label: 'Input Assembler', fixed: true },
        { id: 'vertex',   kind: 'Shader', label: 'Vertex Shader' },
        { id: 'tessCtrl', kind: 'Shader', label: 'Tess Control (HS)', aliases: ['hull'] },
        { id: 'tessEval', kind: 'Shader', label: 'Tess Eval (DS)',    aliases: ['domain'] },
        { id: 'geometry', kind: 'Shader', label: 'Geometry Shader' },
        { id: 'raster',   kind: 'Fixed',  label: 'Rasterizer', fixed: true },
        { id: 'fragment', kind: 'Shader', label: 'Fragment Shader', aliases: ['pixel'] },
        { id: 'om',       kind: 'Fixed',  label: 'Output Merger', fixed: true },
    ];
    function resolveShader(shaders, id, aliases) {
        if (shaders[id]) return { key: id, info: shaders[id] };
        for (const a of (aliases || [])) {
            if (shaders[a]) return { key: a, info: shaders[a] };
        }
        return null;
    }
    function renderPipeline() {
        const body = document.getElementById('pipeline-body');
        if (state.eventId == null) { body.textContent = 'Select an event.'; body.className = 'empty-state'; return; }
        body.className = '';
        const p = state.pipeline;
        if (!p) { body.innerHTML = '<div class="empty-state">Loading pipeline…</div>'; return; }
        if (p.error) { body.innerHTML = '<div class="empty-state">Pipeline unavailable: ' + esc(p.error) + '<br><br>(Replay required for pipeline state)</div>'; return; }

        const shaders = p.shaders || {};
        const fb = p.framebuffer || {};
        const vi = p.vertexInput || {};

        let html = '<div class="info-grid">';
        html += '<div class="k">API</div><div class="v">' + esc(p.api || '?') + '</div>';
        html += '<div class="k">Event</div><div class="v">' + state.eventId + '</div>';
        if (state.drawCall) html += '<div class="k">Draw</div><div class="v">' + esc(state.drawCall.name) + '</div>';
        html += '</div>';

        html += '<div class="pipe-subtitle">Graphics Pipeline</div>';
        html += '<div class="pipe-flow">';
        GFX_PIPELINE.forEach((stage, idx) => {
            if (idx > 0) html += '<span class="pipe-arrow">▶</span>';
            html += renderPipelineStage(stage, shaders, fb, vi);
        });
        html += '</div>';

        const cs = resolveShader(shaders, 'compute', []);
        if (cs) {
            html += '<div class="pipe-subtitle">Compute Pipeline</div>';
            html += '<div class="pipe-flow">';
            html += renderPipelineStage({ id: 'compute', kind: 'Shader', label: 'Compute Shader' }, shaders, fb, vi);
            html += '</div>';
        }

        const colorRTs = fb.colorTargets || [];
        if (colorRTs.length || fb.depthTarget) {
            html += '<div class="pipe-subtitle">Render Targets</div><div>';
            for (const rt of colorRTs) {
                html += '<span class="resource-chip" data-resid="' + esc(rt) + '">' + esc(resName(rt)) + '</span>';
            }
            if (fb.depthTarget) {
                html += '<span class="resource-chip depth" data-resid="' + esc(fb.depthTarget) + '">DS: ' + esc(resName(fb.depthTarget)) + '</span>';
            }
            html += '</div>';
        }

        const vbs = vi.vertexBuffers || [];
        if (vbs.length || vi.indexBuffer) {
            html += '<div class="pipe-subtitle">Vertex Input</div><div>';
            vbs.forEach((vb, i) => {
                html += '<span class="resource-chip" data-resid="' + esc(vb.resourceId) + '">VB' + i + ': ' + esc(resName(vb.resourceId)) + '</span>';
            });
            if (vi.indexBuffer) {
                html += '<span class="resource-chip" data-resid="' + esc(vi.indexBuffer) + '">IB: ' + esc(resName(vi.indexBuffer)) + '</span>';
            }
            html += '</div>';
        }

        body.innerHTML = html;
        body.querySelectorAll('.pipe-stage.clickable').forEach(el => {
            el.addEventListener('click', () => {
                const stageKey = el.dataset.stage;
                if (stageKey) { switchTab('shaders'); state.activeShaderStage = stageKey; renderShaders(); }
            });
        });
        body.querySelectorAll('.resource-chip[data-resid]').forEach(el => {
            el.addEventListener('click', () => openTextureModal(el.dataset.resid));
        });
    }
    function renderPipelineStage(stage, shaders, fb, vi) {
        let shaderInfo = null;
        let stageKey = stage.id;
        if (stage.kind === 'Shader') {
            const res = resolveShader(shaders, stage.id, stage.aliases);
            if (res) { shaderInfo = res.info; stageKey = res.key; }
        }
        const active = stage.fixed ? true : !!shaderInfo;
        const clickable = stage.kind === 'Shader' && shaderInfo;
        let cls = 'pipe-stage' + (stage.fixed ? ' fixed' : '') + (!active ? ' inactive' : '') + (clickable ? ' clickable' : '');
        let html = '<div class="' + cls + '"' + (clickable ? ' data-stage="' + esc(stageKey) + '"' : '') + '>';
        html += '<span class="ps-kind">' + esc(stage.kind) + '</span>';
        html += '<span class="ps-name">' + esc(stage.label) + '</span>';
        if (stage.kind === 'Shader') {
            if (shaderInfo) {
                const shName = shaderInfo.name || resName(shaderInfo.resourceId);
                html += '<span class="ps-shader" title="' + esc(shName) + '">' + esc(shName) + '</span>';
                html += '<span class="ps-meta">id ' + esc(String(shaderInfo.resourceId)) + '</span>';
            } else {
                html += '<span class="ps-meta">(not bound)</span>';
            }
        } else if (stage.id === 'ia') {
            const vbCount = (vi.vertexBuffers || []).length;
            html += '<span class="ps-meta">' + vbCount + ' VB' + (vbCount === 1 ? '' : 's') + (vi.indexBuffer ? ' + IB' : '') + '</span>';
        } else if (stage.id === 'raster') {
            html += '<span class="ps-meta">fixed-function</span>';
        } else if (stage.id === 'om') {
            const nRT = (fb.colorTargets || []).length;
            html += '<span class="ps-meta">' + nRT + ' RT' + (nRT === 1 ? '' : 's') + (fb.depthTarget ? ' + DS' : '') + '</span>';
        }
        html += '</div>';
        return html;
    }

    // ── Shaders ────────────────────────────────────────────────────
    function renderShaders() {
        const body = document.getElementById('shaders-body');
        const toolbar = document.getElementById('shaders-toolbar');
        if (state.eventId == null) {
            body.textContent = 'Select an event.';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        if (!state.shaders) {
            body.textContent = 'Loading shaders…';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        if (state.shaders.error) {
            body.textContent = 'Shader sources unavailable: ' + state.shaders.error + '\\n\\n(Local replay required.)';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }
        const shaders = state.shaders.shaders || {};
        const stages = Object.keys(shaders);
        if (stages.length === 0) {
            body.textContent = 'No bound shaders at this event.';
            body.className = 'code-view empty-state';
            toolbar.hidden = true;
            return;
        }

        toolbar.hidden = false;
        const tabs = document.getElementById('shader-stage-tabs');
        tabs.innerHTML = '';
        if (!state.activeShaderStage || !stages.includes(state.activeShaderStage)) {
            state.activeShaderStage = stages[0];
        }
        for (const s of stages) {
            const btn = document.createElement('button');
            btn.className = 'stage-tab' + (s === state.activeShaderStage ? ' active' : '');
            btn.textContent = s;
            btn.addEventListener('click', () => { state.activeShaderStage = s; renderShaders(); });
            tabs.appendChild(btn);
        }

        const openBtn = document.createElement('button');
        openBtn.className = 'icon-btn';
        openBtn.style.marginLeft = 'auto';
        openBtn.textContent = 'Open in Editor';
        openBtn.addEventListener('click', () => {
            const info = shaders[state.activeShaderStage];
            vscode.postMessage({ type: 'openShaderInEditor', source: info.source || info.disassembly || '', language: 'glsl' });
        });
        tabs.appendChild(openBtn);

        const info = shaders[state.activeShaderStage];
        body.className = 'code-view';
        // Header shows shader resource name + id. Prefer the explicit name the
        // native bridge attaches to the shader source response; fall back to
        // the pipeline-state shaders entry; finally fall back to resource-list
        // lookup (which is a no-op for shaders that never appear in the
        // texture/buffer XML resource list).
        const pipeStage = state.pipeline && state.pipeline.shaders && state.pipeline.shaders[state.activeShaderStage];
        const rid = (info && info.resourceId) || (pipeStage && pipeStage.resourceId);
        const shaderName = (info && info.name) || (pipeStage && pipeStage.name) || (rid ? resName(rid) : '');
        let header;
        if (rid) {
            const nameStr = shaderName && shaderName !== ('Resource ' + rid) ? shaderName : ('Shader ' + rid);
            header = '// ' + state.activeShaderStage + ' shader — ' + nameStr + ' (id ' + rid + ')\\n';
        } else {
            header = '// ' + state.activeShaderStage + ' shader\\n';
        }
        const code = info.source || info.disassembly || '// No source available for ' + state.activeShaderStage;
        body.textContent = header + '\\n' + code;
    }

    // ── Textures ───────────────────────────────────────────────────
    function renderTextures() {
        const body = document.getElementById('textures-body');
        let textures = state.resources.filter(r => r.type === 'Texture');

        // Scope to resources used by the current draw: render targets + any
        // textures the shader sampled from (native bridge collects these via
        // DescriptorAccess → GetDescriptors when pipelineState is queried).
        let scopeLabel = '';
        if (state.texScope === 'draw') {
            const pipe = state.pipeline || {};
            const fb = pipe.framebuffer || {};
            const ids = new Set();
            (fb.colorTargets || []).forEach(id => ids.add(String(id)));
            if (fb.depthTarget)   ids.add(String(fb.depthTarget));
            if (fb.stencilTarget) ids.add(String(fb.stencilTarget));
            (pipe.boundTextures || []).forEach(id => ids.add(String(id)));
            textures = textures.filter(t => ids.has(String(t.resourceId)));
            scopeLabel = '(current draw)';
        }

        const f = state.texFilter;
        const filtered = f ? textures.filter(t => (t.name || '').toLowerCase().includes(f) || (t.format || '').toLowerCase().includes(f)) : textures;
        document.getElementById('tex-count').textContent = filtered.length + ' / ' + textures.length + ' ' + scopeLabel;
        if (filtered.length === 0) {
            body.innerHTML = '';
            body.className = 'tex-grid empty-state';
            if (state.texScope === 'draw' && state.eventId == null) {
                body.textContent = 'Select an event to see its bound textures.';
            } else if (state.texScope === 'draw') {
                const pipeReady = state.pipeline && !state.pipeline.error;
                body.textContent = pipeReady
                    ? 'This draw did not sample any textures or bind render targets.'
                    : 'Loading pipeline state for this draw…';
            } else {
                body.textContent = textures.length === 0 ? 'No textures in this capture.' : 'No textures match filter.';
            }
            return;
        }
        body.className = 'tex-grid';
        body.innerHTML = filtered.map(t => texCardHtml(t)).join('');
        body.querySelectorAll('.tex-card').forEach(card => {
            card.addEventListener('click', () => openTextureModal(card.dataset.resid));
        });

        // Auto-request thumbnails for every visible card (RenderDoc-style —
        // the user asked for immediate loading on tab open instead of a
        // per-card click). Dedupe by key to avoid a storm on re-renders.
        for (const t of filtered) {
            requestThumbnail(String(t.resourceId));
        }
    }

    // Thumbnail management ──────────────────────────────────────
    // We keep a client-side cache of already-loaded thumbnails, keyed by
    // "resId:eventId", so tab switches or filter changes don't refetch.
    const thumbCache = new Map();       // key → base64 PNG
    const thumbPending = new Set();     // key currently in flight
    function thumbKey(resId) {
        return String(resId) + ':0:' + (state.eventId || 0) + ':-1';
    }
    function requestThumbnail(resId) {
        const key = thumbKey(resId);
        if (thumbCache.has(key)) {
            applyThumbnail(resId, thumbCache.get(key));
            return;
        }
        if (thumbPending.has(key)) return;
        thumbPending.add(key);
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: resId,
            mip: 0,
            eventId: state.eventId || 0,
            channelExtract: -1,
        });
    }
    function applyThumbnail(resId, base64) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        card.innerHTML = '<img src="data:image/png;base64,' + base64 + '" alt="thumbnail">';
    }
    function applyThumbnailError(resId, errMsg) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        card.innerHTML = '<span class="placeholder">' + esc(errMsg || 'preview failed') + '</span>';
    }

    function texCardHtml(t) {
        const dim = (t.width && t.height) ? (t.width + '×' + t.height) : '';
        return '<div class="tex-card" data-resid="' + esc(t.resourceId) + '">' +
            '<div class="thumb"><span class="placeholder">Loading…</span></div>' +
            '<div class="tex-name" title="' + esc(t.name || '') + '">' + esc(t.name || ('Texture ' + t.resourceId)) + '</div>' +
            '<div class="tex-meta">' + esc(dim) + ' ' + esc(t.format || '') + '</div>' +
            '</div>';
    }

    // ── Texture modal ──────────────────────────────────────────────
    function openTextureModal(resId) {
        const tex = state.resources.find(r => r.resourceId === resId);
        if (!tex) return;
        state.modalResource = tex;
        state.modalChannel = -1;
        document.getElementById('tex-modal-title').textContent = tex.name || 'Texture ' + resId;
        document.getElementById('tex-modal-preview').innerHTML = '<div class="muted">Loading…</div>';
        const meta = document.getElementById('tex-modal-meta');
        meta.innerHTML = '<div class="info-grid">' +
            kv('ID', resId) +
            kv('Name', tex.name) +
            kv('Format', tex.format) +
            kv('Size', (tex.width||0) + ' × ' + (tex.height||0)) +
            kv('Mips', tex.mipLevels) +
            kv('Bytes', tex.byteSize) +
            '</div>';
        document.querySelectorAll('#channel-toggle .ch').forEach(b => b.classList.toggle('active', parseInt(b.dataset.ch) === -1));
        document.getElementById('texture-modal').hidden = false;
        requestTexture();
    }
    function requestTexture() {
        if (!state.modalResource) return;
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: state.modalResource.resourceId,
            mip: 0,
            eventId: state.eventId || 0,
            channelExtract: state.modalChannel,
        });
    }
    function handleTexturePreview(m) {
        // Is this response destined for a thumbnail card (auto-loaded on tab
        // open) rather than the modal? Match by key — thumbnails always use
        // mip=0, channel=-1, so they share the same key shape we computed in
        // thumbKey().
        if (thumbPending.has(m.key)) {
            thumbPending.delete(m.key);
            const resId = m.key.split(':')[0];
            if (m.error) {
                applyThumbnailError(resId, m.error);
            } else if (m.base64) {
                thumbCache.set(m.key, m.base64);
                applyThumbnail(resId, m.base64);
            }
            // A thumbnail load does NOT block the modal; if the user also
            // happens to have the modal open for the same key, fall through.
            if (!state.modalResource || state.modalResource.resourceId !== resId || state.modalChannel !== -1) {
                return;
            }
        }
        if (!state.modalResource) return;
        const expectedKey = state.modalResource.resourceId + ':0:' + (state.eventId||0) + ':' + state.modalChannel;
        if (m.key !== expectedKey) return;
        const area = document.getElementById('tex-modal-preview');
        if (m.error) { area.innerHTML = '<div class="muted">Error: ' + esc(m.error) + '</div>'; return; }
        area.innerHTML = '<img src="data:image/png;base64,' + m.base64 + '" alt="texture preview">';
    }
    document.getElementById('tex-modal-close').addEventListener('click', () => { document.getElementById('texture-modal').hidden = true; state.modalResource = null; });
    document.querySelector('#texture-modal .modal-backdrop').addEventListener('click', () => { document.getElementById('texture-modal').hidden = true; state.modalResource = null; });
    document.querySelectorAll('#channel-toggle .ch').forEach(b => b.addEventListener('click', () => {
        state.modalChannel = parseInt(b.dataset.ch, 10);
        document.querySelectorAll('#channel-toggle .ch').forEach(x => x.classList.toggle('active', x === b));
        requestTexture();
    }));
    document.getElementById('tex-modal-export').addEventListener('click', () => {
        if (state.modalResource) vscode.postMessage({ type: 'exportTexture', resourceId: state.modalResource.resourceId, label: state.modalResource.name });
    });

    // ── Events tree ────────────────────────────────────────────────
    function renderEvents() {
        const body = document.getElementById('events-body');
        if (!state.drawCalls.length) { body.className = 'event-tree empty-state'; body.textContent = 'No events.'; return; }
        body.className = 'event-tree';
        const allFlat = flattenEvents(state.drawCalls);

        // Determine the root list to render based on scope
        let rootList = state.drawCalls;
        if (state.eventScope === 'group' && state.eventId != null) {
            // Find the smallest marker/parent subtree that contains the current event
            const parent = findParentGroup(state.drawCalls, state.eventId);
            if (parent) rootList = parent.children && parent.children.length ? parent.children : [parent];
        }
        const f = state.eventFilter;
        let shown = 0;
        const render = (list, depth = 0) => {
            let html = '';
            for (const dc of list) {
                const match = !f || dc.name.toLowerCase().includes(f) || String(dc.eventId).includes(f);
                const childrenHtml = dc.children?.length ? render(dc.children, depth + 1) : '';
                if (!match && !childrenHtml) continue;
                if (match) shown++;
                html += evtNodeHtml(dc);
                if (childrenHtml) html += '<div class="evt-children">' + childrenHtml + '</div>';
            }
            return html;
        };
        body.innerHTML = render(rootList);
        document.getElementById('evt-count').textContent = shown + ' / ' + allFlat.length + (state.eventScope === 'group' ? ' (group)' : '');
        body.querySelectorAll('.evt-node').forEach(el => {
            el.addEventListener('click', () => vscode.postMessage({ type: 'selectEvent', eventId: parseInt(el.dataset.eid, 10) }));
        });
    }
    function evtNodeHtml(dc) {
        const flagClass = /drawcall|draw/i.test(dc.flags || '') ? 'draw'
            : /clear/i.test(dc.flags || '') ? 'clear'
            : /dispatch/i.test(dc.flags || '') ? 'dispatch' : '';
        const current = dc.eventId === state.eventId ? ' current' : '';
        return '<div class="evt-node' + current + '" data-eid="' + dc.eventId + '">' +
            '<span class="evt-eid">' + dc.eventId + '</span>' +
            '<span class="evt-name">' + esc(dc.name) + '</span>' +
            (flagClass ? '<span class="evt-flag ' + flagClass + '">' + esc((dc.flags || '').split('|')[0]) + '</span>' : '') +
            '</div>';
    }

    // ── Render dispatch ────────────────────────────────────────────
    function render() {
        if (state.activeTab === 'overview') renderOverview();
        else if (state.activeTab === 'pipeline') renderPipeline();
        else if (state.activeTab === 'shaders') renderShaders();
        else if (state.activeTab === 'textures') renderTextures();
        else if (state.activeTab === 'events') renderEvents();
        updateHeader();
    }

    // ── Utils ──────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function kv(k, v) {
        if (v == null || v === '') return '';
        return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>';
    }

    console.log('[Inspector webview] sending ready');
    vscode.postMessage({ type: 'ready' });
})();
    