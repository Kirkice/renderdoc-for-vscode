
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
        activeTab: 'textures',
        activeShaderStage: null,
        activeShaderFile: {}, // map: stage -> file index (or -1 for disassembly)
        eventFilter: '',
        texFilter: '',
        resFilter: '',
        resTypeFilter: 'all',
        modalResource: null,
        modalChannel: -1,
        eventScope: 'all',   // 'all' | 'group'
        texScope: 'output',  // 'output' | 'input'
        meshStage: 'vsin',   // 'vsin' | 'vsout'
        meshMax: 0,          // 0 = all rows (matches RenderDoc desktop BufferViewer)
        meshCache: {},       // key -> { data } | { error }
        meshPending: {},
        meshShowPreview: true,
        meshCam: { yaw: 0.6, pitch: 0.4, zoom: 1.0, panX: 0, panY: 0, auto: true },
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
    document.getElementById('tex-filter').addEventListener('input', e => {
        state.texFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'textures') renderTextures();
    });
    document.getElementById('res-filter').addEventListener('input', e => {
        state.resFilter = e.target.value.toLowerCase();
        if (state.activeTab === 'resources') renderResources();
    });

    // ── Scope toggles ─────────────────────────────────────────────
    document.querySelectorAll('.scope-toggle').forEach(group => {
        group.querySelectorAll('.scope').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.scope').forEach(b => b.classList.toggle('active', b === btn));
                const kind = group.dataset.scope;
                if (kind === 'tex') { state.texScope = btn.dataset.val; renderTextures(); }
                else if (kind === 'res') { state.resTypeFilter = btn.dataset.val; renderResources(); }
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
                        state.meshCache = {};
                        state.meshPending = {};
                        state.meshCam.auto = true;
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
            case 'meshLoaded':
                if (m.key) {
                    state.meshCache[m.key] = m.error ? { error: m.error } : { data: m.data };
                    delete state.meshPending[m.key];
                    if (state.activeTab === 'mesh') renderMesh();
                }
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
            if (idx > 0) html += '<span class="pipe-arrow">▼</span>';
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
                const progName = shaderInfo.programName || '';
                const shName   = shaderInfo.shaderName  || '';
                // Prefer program label (set by glObjectLabel on the program), fall back to shader name
                const displayName = progName || shName || resName(shaderInfo.resourceId);
                const tooltip = progName && shName ? progName + ' > ' + shName : displayName;
                html += '<span class="ps-shader" title="' + esc(tooltip) + '">' + esc(displayName) + '</span>';
                if (progName && shName)
                    html += '<span class="ps-meta">&gt; ' + esc(shName) + '</span>';
                else
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
        // Header shows shader resource name + id.
        const pipeStage = state.pipeline && state.pipeline.shaders && state.pipeline.shaders[state.activeShaderStage];
        const rid = (info && info.resourceId) || (pipeStage && pipeStage.resourceId);
        const shaderName = (info && info.name) || (pipeStage && pipeStage.name) || (rid ? resName(rid) : '');

        // File sub-tabs — mirror RenderDoc desktop's file switcher inside a
        // shader stage. Each source file is a distinct tab; disassembly (if
        // available) is appended as a virtual last tab.
        const fileBar = document.getElementById('shader-file-tabs');
        if (fileBar) {
            fileBar.innerHTML = '';
            const files = Array.isArray(info.sourceFiles) ? info.sourceFiles : [];
            const hasDisasm = typeof info.disassembly === 'string' && info.disassembly.length > 0;
            const defaultIdx = (typeof info.entryFileIndex === 'number' && info.entryFileIndex >= 0) ? info.entryFileIndex : 0;

            // Resolve current selection (stored per-stage).
            let cur = state.activeShaderFile[state.activeShaderStage];
            const maxIdx = files.length - 1;
            if (cur === undefined || cur === null || (cur >= 0 && cur > maxIdx) || (cur === -1 && !hasDisasm)) {
                cur = files.length > 0 ? defaultIdx : (hasDisasm ? -1 : 0);
                state.activeShaderFile[state.activeShaderStage] = cur;
            }

            const makeTab = (label, idx) => {
                const b = document.createElement('button');
                b.className = 'stage-tab shader-file-tab' + (idx === cur ? ' active' : '');
                b.textContent = label;
                b.title = label;
                b.addEventListener('click', () => {
                    state.activeShaderFile[state.activeShaderStage] = idx;
                    renderShaders();
                });
                fileBar.appendChild(b);
            };
            for (let i = 0; i < files.length; i++) {
                const fn = (files[i] && files[i].filename) || ('file ' + i);
                const label = fn + (i === defaultIdx ? ' *' : '');
                makeTab(label, i);
            }
            if (hasDisasm) {
                const tgt = info.disassemblyTarget || 'Disassembly';
                makeTab(tgt, -1);
            }
            fileBar.hidden = (files.length + (hasDisasm ? 1 : 0)) <= 0;
        }

        let header;
        if (rid) {
            const nameStr = shaderName && shaderName !== ('Resource ' + rid) ? shaderName : ('Shader ' + rid);
            header = '// ' + state.activeShaderStage + ' shader — ' + nameStr + ' (id ' + rid + ')\\n';
        } else {
            header = '// ' + state.activeShaderStage + ' shader\\n';
        }

        const files = Array.isArray(info.sourceFiles) ? info.sourceFiles : [];
        const hasDisasm = typeof info.disassembly === 'string' && info.disassembly.length > 0;
        const cur = state.activeShaderFile[state.activeShaderStage];
        let code;
        if (cur === -1 && hasDisasm) {
            code = info.disassembly;
            header += '// [disassembly: ' + (info.disassemblyTarget || '?') + ']\\n';
        } else if (cur >= 0 && cur < files.length) {
            code = files[cur].contents || '';
            header += '// [' + (files[cur].filename || ('file ' + cur)) + ']\\n';
        } else {
            code = info.source || info.disassembly || '// No source available for ' + state.activeShaderStage;
        }
        body.textContent = header + '\\n' + code;
    }

    // ── Textures ───────────────────────────────────────────────────
    // Current-draw RT preview (top) + grid of Input (sampled) or Output (RT)
    // textures for the currently selected event.
    function renderTextures() {
        renderCurrentRTPreview();
        const body = document.getElementById('textures-body');
        const allTex = state.resources.filter(r => r.type === 'Texture');

        const pipe = state.pipeline || {};
        const fb = pipe.framebuffer || {};
        const outputIds = new Set();
        (fb.colorTargets || []).forEach(id => outputIds.add(String(id)));
        if (fb.depthTarget)   outputIds.add(String(fb.depthTarget));
        if (fb.stencilTarget) outputIds.add(String(fb.stencilTarget));
        const inputIds = new Set();
        (pipe.boundTextures || []).forEach(id => inputIds.add(String(id)));

        const scopeIds = state.texScope === 'input' ? inputIds : outputIds;
        let textures = allTex.filter(t => scopeIds.has(String(t.resourceId)));
        const scopeLabel = state.texScope === 'input' ? '(sampled by draw)' : '(render targets)';

        const f = state.texFilter;
        const filtered = f
            ? textures.filter(t => (t.name || '').toLowerCase().includes(f) || (t.format || '').toLowerCase().includes(f))
            : textures;
        document.getElementById('tex-count').textContent = filtered.length + ' / ' + textures.length + ' ' + scopeLabel;

        if (filtered.length === 0) {
            body.innerHTML = '';
            body.className = 'tex-grid empty-state';
            if (state.eventId == null) {
                body.textContent = 'Select an event.';
            } else if (!state.pipeline || state.pipeline.error) {
                body.textContent = 'Loading pipeline state for this draw…';
            } else if (state.texScope === 'input') {
                body.textContent = textures.length === 0
                    ? 'This draw did not sample any textures.'
                    : 'No textures match filter.';
            } else {
                body.textContent = textures.length === 0
                    ? 'This draw has no bound render targets.'
                    : 'No textures match filter.';
            }
            return;
        }
        body.className = 'tex-grid';
        body.innerHTML = filtered.map(t => texCardHtml(t)).join('');
        body.querySelectorAll('.tex-card').forEach(card => {
            card.addEventListener('click', () => openTextureModal(card.dataset.resid));
        });

        for (const t of filtered) {
            requestThumbnail(String(t.resourceId));
        }
    }

    // Render the large "current draw output" preview panel on top of the
    // Texture Viewer tab — mirrors RenderDoc's "Cur Output" header image.
    const rtPreviewCache = new Map();   // key → base64 PNG
    const rtPreviewErrors = new Map();  // key → error message (prevents infinite re-request)
    const rtPreviewPending = new Set(); // key currently in flight
    function rtKey(resId) {
        return String(resId) + ':0:' + (state.eventId || 0) + ':-1';
    }
    function renderCurrentRTPreview() {
        const area = document.getElementById('tex-current');
        if (!area) return;
        if (state.eventId == null) {
            area.className = 'tex-current empty-state';
            area.textContent = 'Select an event to preview its render target.';
            return;
        }
        const pipe = state.pipeline;
        if (!pipe || pipe.error) {
            area.className = 'tex-current empty-state';
            area.textContent = pipe && pipe.error
                ? ('Pipeline unavailable: ' + pipe.error)
                : 'Loading render target…';
            return;
        }
        const fb = pipe.framebuffer || {};
        const rtId = (fb.colorTargets && fb.colorTargets[0]) || fb.depthTarget;
        if (!rtId) {
            area.className = 'tex-current empty-state';
            area.textContent = 'No render target bound for this draw.';
            return;
        }
        const tex = state.resources.find(r => String(r.resourceId) === String(rtId));
        const name = (tex && tex.name) || ('Resource ' + rtId);
        const fmt = (tex && tex.format) || '';
        const dim = tex && tex.width ? (tex.width + '×' + tex.height) : '';

        area.className = 'tex-current';
        const key = rtKey(rtId);
        const cached = rtPreviewCache.get(key);
        const errMsg = rtPreviewErrors.get(key);
        let body;
        if (cached) {
            body = '<img src="data:image/png;base64,' + cached + '" alt="current RT">';
        } else if (errMsg) {
            body = '<div class="muted" style="padding:8px;font-size:0.85em;">Preview unavailable: ' + esc(errMsg) + '</div>';
        } else {
            body = '<div class="muted">Loading…</div>';
        }
        area.innerHTML =
            '<div class="tex-current-header">' +
                '<span class="tex-current-label">Cur Output 0</span>' +
                '<span class="tex-current-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
                '<span class="tex-current-meta">' + esc(dim) + ' ' + esc(fmt) + '</span>' +
                '<button class="icon-btn tex-current-open" data-resid="' + esc(rtId) + '">Open</button>' +
            '</div>' +
            '<div class="tex-current-preview">' + body + '</div>';

        const btn = area.querySelector('.tex-current-open');
        if (btn) btn.addEventListener('click', () => openTextureModal(String(rtId)));

        if (!cached && !errMsg && !rtPreviewPending.has(key)) {
            rtPreviewPending.add(key);
            vscode.postMessage({
                type: 'requestTexture',
                resourceId: String(rtId),
                mip: 0,
                eventId: state.eventId || 0,
                channelExtract: -1,
            });
        }
    }

    // Thumbnail management ──────────────────────────────────────
    // We keep a client-side cache of already-loaded thumbnails, keyed by
    // resId alone (no eventId) — thumbnail cards show a static preview of
    // the texture's content and do NOT need to be re-fetched on every event
    // switch.  Only the large "Cur Output" RT preview uses an eventId key
    // so it correctly tracks the RT state at the selected draw.
    const thumbCache = new Map();       // key → base64 PNG
    const thumbPending = new Set();     // key currently in flight
    function thumbKey(resId) {
        // Use eventId=0 so the native bridge samples end-of-frame state.
        // This key is stable across event changes, preventing the N-texture
        // refetch stampede that made switching draws very slow.
        return String(resId) + ':0:0:-1';
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
            eventId: 0,   // end-of-frame state; thumbnails are capture-level, not per-event
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
        // Route to the large "Cur Output" RT preview on the Textures tab, if
        // this response was requested for it.
        if (rtPreviewPending.has(m.key)) {
            rtPreviewPending.delete(m.key);
            if (!m.error && m.base64) {
                rtPreviewCache.set(m.key, m.base64);
            } else if (m.error) {
                rtPreviewErrors.set(m.key, m.error);
            }
            if (state.activeTab === 'textures') renderCurrentRTPreview();
            // The same key may also satisfy a thumbnail card (RT is shown
            // both at top and in the grid) — fall through to that path too.
        }
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

    // ── Resource Inspector ─────────────────────────────────────────
    // Flat list of every resource in the capture, filterable by type + name.
    // Clicking a row opens it in the texture modal (for textures), or the
    // shaders tab (for shaders), or just copies the ID (for buffers).
    function renderResources() {
        const body = document.getElementById('resources-body');
        const all = state.resources || [];
        let list = all;
        if (state.resTypeFilter && state.resTypeFilter !== 'all') {
            list = list.filter(r => r.type === state.resTypeFilter);
        }
        const f = state.resFilter;
        if (f) {
            list = list.filter(r =>
                (r.name || '').toLowerCase().includes(f) ||
                String(r.resourceId).includes(f) ||
                (r.format || '').toLowerCase().includes(f) ||
                (r.type || '').toLowerCase().includes(f)
            );
        }
        document.getElementById('res-count').textContent = list.length + ' / ' + all.length;
        if (list.length === 0) {
            body.className = 'resource-list empty-state';
            body.textContent = all.length === 0 ? 'No resources in this capture.' : 'No resources match filter.';
            return;
        }
        body.className = 'resource-list';
        let html = '<table class="res-table"><thead><tr>'
            + '<th>Type</th><th>ID</th><th>Name</th><th>Format</th><th>Size</th><th>Bytes</th>'
            + '</tr></thead><tbody>';
        for (const r of list) {
            const dim = (r.width && r.height)
                ? (r.width + '\u00d7' + r.height + (r.depth > 1 ? ('\u00d7' + r.depth) : ''))
                : '';
            html += '<tr class="res-row" data-type="' + esc(r.type) + '" data-resid="' + esc(r.resourceId) + '">'
                + '<td>' + esc(r.type || '') + '</td>'
                + '<td class="mono">' + esc(r.resourceId) + '</td>'
                + '<td>' + esc(r.name || '') + '</td>'
                + '<td>' + esc(r.format || '') + '</td>'
                + '<td>' + esc(dim) + '</td>'
                + '<td class="mono">' + esc(r.byteSize != null ? r.byteSize : '') + '</td>'
                + '</tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
        body.querySelectorAll('.res-row').forEach(el => {
            el.addEventListener('click', () => {
                if (el.dataset.type === 'Texture') {
                    openTextureModal(el.dataset.resid);
                }
            });
        });
    }

    // ── Render dispatch ────────────────────────────────────────────
    function render() {
        if (state.activeTab === 'overview') renderOverview();
        else if (state.activeTab === 'pipeline') renderPipeline();
        else if (state.activeTab === 'shaders') renderShaders();
        else if (state.activeTab === 'textures') renderTextures();
        else if (state.activeTab === 'resources') renderResources();
        else if (state.activeTab === 'mesh') renderMesh();
        updateHeader();
    }

    // ── Mesh View ──────────────────────────────────────────────────
    // Canonical CompType table → label + integer-display flag. Matches
    // RenderDoc's enum order (see replay_enums.h).
    const COMP_TYPE_INFO = [
        { label: 'typeless', int: true },
        { label: 'float',    int: false },
        { label: 'unorm',    int: false },
        { label: 'snorm',    int: false },
        { label: 'uint',     int: true  },
        { label: 'sint',     int: true  },
        { label: 'uscaled',  int: true  },
        { label: 'sscaled',  int: true  },
        { label: 'depth',    int: false },
        { label: 'unormSRGB',int: false },
    ];

    function fmtComp(attr) {
        const ci = COMP_TYPE_INFO[attr.compType] || COMP_TYPE_INFO[0];
        const bits = (attr.compByteWidth || 0) * 8;
        return ci.label + bits + 'x' + (attr.compCount || 1);
    }

    function formatValue(v, isInt) {
        if (v === null || v === undefined) return '';
        if (typeof v !== 'number') return String(v);
        if (isInt) return String(Math.trunc(v));
        if (!isFinite(v)) return String(v);
        // RenderDoc-style: up to 6 significant digits, trim trailing zeros.
        let s = v.toFixed(4);
        s = s.replace(/\.?0+$/, '');
        return s === '' || s === '-' ? '0' : s;
    }

    function meshRequestKey() {
        return state.eventId + ':' + state.meshStage + ':' + state.meshMax + ':0';
    }

    function ensureMeshLoaded() {
        if (state.eventId == null) return null;
        const key = meshRequestKey();
        if (state.meshCache[key]) return state.meshCache[key];
        if (!state.meshPending[key]) {
            state.meshPending[key] = true;
            vscode.postMessage({
                type: 'requestMesh',
                eventId: state.eventId,
                stage: state.meshStage,
                maxVertices: state.meshMax,
                instance: 0,
            });
        }
        return null;
    }

    // ── Binary mesh decoding ───────────────────────────────────────
    // Decode base64 string → Uint8Array. ~5x faster than using atob+loop
    // via the browser's built-in parsing of data URLs.
    function b64ToBytes(s) {
        if (!s) return new Uint8Array(0);
        const bin = atob(s);
        const n = bin.length;
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Convert a half-float (uint16) to a JS number.
    function halfToFloat(h) {
        const sign = (h & 0x8000) >> 15;
        const exp  = (h & 0x7C00) >> 10;
        const mant = (h & 0x03FF);
        if (exp === 0) {
            if (mant === 0) return sign ? -0 : 0;
            return (sign ? -1 : 1) * Math.pow(2, -14) * (mant / 1024);
        }
        if (exp === 31) {
            if (mant === 0) return sign ? -Infinity : Infinity;
            return NaN;
        }
        return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + mant / 1024);
    }

    // Pull a single scalar out of a DataView for a given (CompType, width).
    // CompType values (from replay_enums.h): 0=Typeless, 1=Float, 2=UNorm,
    // 3=SNorm, 4=UInt, 5=SInt, 6=UScaled, 7=SScaled, 8=Depth, 9=UNormSRGB.
    function decodeScalar(dv, off, compType, width) {
        if (off < 0 || off + width > dv.byteLength) return 0;
        switch (compType) {
            case 1: // Float
                if (width === 4) return dv.getFloat32(off, true);
                if (width === 8) return dv.getFloat64(off, true);
                if (width === 2) return halfToFloat(dv.getUint16(off, true));
                return 0;
            case 4: case 6: // UInt / UScaled
                if (width === 1) return dv.getUint8(off);
                if (width === 2) return dv.getUint16(off, true);
                if (width === 4) return dv.getUint32(off, true);
                if (width === 8) {
                    const lo = dv.getUint32(off, true);
                    const hi = dv.getUint32(off + 4, true);
                    return hi * 4294967296 + lo;
                }
                return 0;
            case 5: case 7: // SInt / SScaled
                if (width === 1) return dv.getInt8(off);
                if (width === 2) return dv.getInt16(off, true);
                if (width === 4) return dv.getInt32(off, true);
                if (width === 8) {
                    const lo = dv.getUint32(off, true);
                    const hi = dv.getInt32(off + 4, true);
                    return hi * 4294967296 + lo;
                }
                return 0;
            case 2: case 9: // UNorm / UNormSRGB
                if (width === 1) return dv.getUint8(off) / 255;
                if (width === 2) return dv.getUint16(off, true) / 65535;
                return 0;
            case 3: { // SNorm
                if (width === 1) {
                    const v = dv.getInt8(off);
                    return v < -127 ? -1 : v / 127;
                }
                if (width === 2) {
                    const v = dv.getInt16(off, true);
                    return v < -32767 ? -1 : v / 32767;
                }
                return 0;
            }
            default: return 0;
        }
    }

    // Prepare typed-array / metadata caches for a fetched mesh payload.
    // Called once per response; decoded state lives on `entry.decoded`.
    function prepareMeshData(entry) {
        if (!entry || entry.error || !entry.data || entry.decoded) return entry && entry.decoded;
        const d = entry.data;
        const attrs = d.attributes || [];
        const bufBytes = (d.buffers || []).map(b64ToBytes);
        const bufViews = bufBytes.map(b => new DataView(b.buffer, b.byteOffset, b.byteLength));
        const idxBytes = d.indexData ? b64ToBytes(d.indexData) : null;
        const idxView  = idxBytes ? new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength) : null;
        entry.decoded = {
            attrs,
            bufViews,
            bufBytes,
            idxView,
            indexStride: d.indexByteStride || 0,
            baseVertex: d.baseVertex | 0,
            restartEnabled: !!d.restartEnabled,
            restartIndex: d.restartIndex >>> 0,
            topology: d.topology | 0,
            count: d.returnedIndices | 0,
            total: d.totalIndices | 0,
            hasIdx: !!idxView,
        };
        return entry.decoded;
    }

    // Read the raw index at position i; returns { raw, isRestart }.
    function readIndexAt(dec, i) {
        if (!dec.hasIdx) return { raw: i, isRestart: false };
        const s = dec.indexStride;
        const off = i * s;
        if (off + s > dec.idxView.byteLength) return { raw: 0, isRestart: false };
        let raw = 0;
        if (s === 1) raw = dec.idxView.getUint8(off);
        else if (s === 2) raw = dec.idxView.getUint16(off, true);
        else if (s === 4) raw = dec.idxView.getUint32(off, true);
        const isRestart = dec.restartEnabled && raw === dec.restartIndex;
        return { raw, isRestart };
    }

    // Decode one attribute's scalar components for a given vertex index.
    // `vtxIdx` is the actual VB lookup index (raw + baseVertex for indexed,
    // row number otherwise).
    function decodeAttrCells(a, dec, vtxIdx, isRestart, instance) {
        const cc = Math.max(1, a.compCount || 1);
        const out = new Array(cc);
        if (a.genericEnabled) {
            const gv = a.genericValues || [];
            for (let c = 0; c < cc; c++) out[c] = gv[c] != null ? gv[c] : 0;
            return out;
        }
        if (isRestart || a.formatType !== 0 /* not ResourceFormatType::Regular */) {
            for (let c = 0; c < cc; c++) out[c] = 0;
            return out;
        }
        const bi = a.bufferIndex;
        if (bi == null || bi < 0 || bi >= dec.bufViews.length) {
            for (let c = 0; c < cc; c++) out[c] = 0;
            return out;
        }
        const dv = dec.bufViews[bi];
        const stride = a.byteStride | 0;
        const relOff = a.relativeOffset | 0;
        const width = a.compByteWidth | 0;
        const useIdx = a.perInstance
            ? ((a.instanceRate | 0) ? ((instance | 0) / (a.instanceRate | 0)) | 0 : (instance | 0))
            : vtxIdx;
        const base = useIdx * stride + relOff;
        const bgra = !!a.bgra && cc >= 3;
        for (let c = 0; c < cc; c++) {
            const srcC = (bgra && c < 3) ? (2 - c) : c;
            out[c] = decodeScalar(dv, base + srcC * width, a.compType, width);
        }
        return out;
    }

    // ── Mesh virtualized table ─────────────────────────────────────
    const MESH_ROW_HEIGHT = 22;        // px; must match CSS
    const MESH_ROW_OVERSCAN = 16;       // rows rendered above/below viewport

    // Build the table header + scroll container once per dataset change.
    // Returns true if a fresh skeleton was (re-)built.
    function buildMeshSkeleton(body, dec) {
        // Reuse existing skeleton if the attribute schema hasn't changed.
        const sig = dec.count + '|' + dec.hasIdx + '|' +
            dec.attrs.map(a => (a.name || '') + ':' + (a.compCount || 1) +
                               ':' + (a.compType | 0) + ':' + (a.compByteWidth | 0)).join(';');
        if (body.dataset.meshSig === sig) return false;
        body.dataset.meshSig = sig;

        // Fixed per-column widths keep the header and virtualized row grid in
        // lockstep horizontally (important because they are separate grids).
        const COL_NUM = 64;    // VTX / IDX
        const COL_CELL = 88;   // per attribute sub-component
        let colCount = 1 + (dec.hasIdx ? 1 : 0);
        for (const a of dec.attrs) colCount += Math.max(1, a.compCount || 1);
        const tplParts = [];
        tplParts.push(COL_NUM + 'px');
        if (dec.hasIdx) tplParts.push(COL_NUM + 'px');
        for (const a of dec.attrs) {
            const cc = Math.max(1, a.compCount || 1);
            for (let c = 0; c < cc; c++) tplParts.push(COL_CELL + 'px');
        }
        const tpl = tplParts.join(' ');

        // Build header. Top row spans per attribute, bottom row per sub-column.
        let hdrHtml = '';
        hdrHtml += '<div class="mhc mhc-num" style="grid-row:1/3">VTX</div>';
        if (dec.hasIdx) hdrHtml += '<div class="mhc mhc-num" style="grid-row:1/3">IDX</div>';
        for (const a of dec.attrs) {
            const cc = Math.max(1, a.compCount || 1);
            hdrHtml += '<div class="mhc mhc-attr" style="grid-column:span ' + cc +
                '" title="' + esc(fmtComp(a)) + '">' + esc(a.name || '(unnamed)') + '</div>';
        }
        for (const a of dec.attrs) {
            const cc = Math.max(1, a.compCount || 1);
            const labels = ['x', 'y', 'z', 'w'];
            for (let c = 0; c < cc; c++) {
                hdrHtml += '<div class="mhc mhc-sub">.' + (labels[c] || ('c' + c)) + '</div>';
            }
        }

        body.innerHTML =
            '<div class="mesh-inner">' +
                '<div class="mesh-grid" style="grid-template-columns:' + tpl + '">' +
                    hdrHtml +
                '</div>' +
                '<div class="mesh-rows-host">' +
                    '<div class="mesh-window" style="grid-template-columns:' + tpl + '"></div>' +
                '</div>' +
            '</div>';

        const host = body.querySelector('.mesh-rows-host');
        host.style.height = (dec.count * MESH_ROW_HEIGHT) + 'px';

        // Attach the scroll listener once; subsequent skeleton rebuilds update
        // the cached `dec` via closure so the most recent dataset is rendered.
        body._meshDec = dec;
        if (!body._meshScrollBound) {
            body._meshScrollBound = true;
            body.addEventListener('scroll', () => {
                if (body._meshDec) renderMeshRows(body, body._meshDec);
            }, { passive: true });
        }
        body.scrollTop = 0;
        return true;
    }

    // Render only the rows visible (± overscan) in the scroll viewport.
    function renderMeshRows(body, dec) {
        const host = body.querySelector('.mesh-rows-host');
        const win  = body.querySelector('.mesh-window');
        if (!host || !win) return;
        // Where does the row area start inside the scroll container?
        const hostOffsetTop = host.offsetTop;
        const scrollTop = body.scrollTop;
        const clientH = body.clientHeight;
        const viewTop = Math.max(0, scrollTop - hostOffsetTop);
        let first = Math.max(0, Math.floor(viewTop / MESH_ROW_HEIGHT) - MESH_ROW_OVERSCAN);
        let last  = Math.min(dec.count,
            Math.ceil((viewTop + clientH) / MESH_ROW_HEIGHT) + MESH_ROW_OVERSCAN);
        if (last <= first) return;

        // Skip rebuilding if window hasn't moved since last render.
        const prev = win.dataset.range || '';
        const key = first + ':' + last;
        if (prev === key) return;
        win.dataset.range = key;

        win.style.transform = 'translateY(' + (first * MESH_ROW_HEIGHT) + 'px)';

        const attrs = dec.attrs;
        const parts = [];
        for (let i = first; i < last; i++) {
            const idxInfo = readIndexAt(dec, i);
            const isRestart = idxInfo.isRestart;
            const vtxIdx = isRestart ? 0 : (idxInfo.raw + dec.baseVertex);
            parts.push('<div class="mrow' + (isRestart ? ' restart' : '') + '">');
            parts.push('<div class="mc mono num">' + i + '</div>');
            if (dec.hasIdx) parts.push('<div class="mc mono num">' + (isRestart ? '—' : idxInfo.raw) + '</div>');
            for (let k = 0; k < attrs.length; k++) {
                const a = attrs[k];
                const isInt = (COMP_TYPE_INFO[a.compType] || {}).int;
                const vals = decodeAttrCells(a, dec, vtxIdx, isRestart, 0);
                const cc = Math.max(1, a.compCount || 1);
                for (let c = 0; c < cc; c++) {
                    parts.push('<div class="mc mono">' + esc(formatValue(vals[c], isInt)) + '</div>');
                }
            }
            parts.push('</div>');
        }
        win.innerHTML = parts.join('');
    }

    function renderMesh() {
        const body = document.getElementById('mesh-body');
        const info = document.getElementById('mesh-info');
        if (state.eventId == null) {
            body.textContent = 'Select an event.';
            body.className = 'mesh-table-wrap empty-state';
            delete body.dataset.meshSig;
            info.textContent = '';
            return;
        }
        const entry = ensureMeshLoaded();
        if (!entry) {
            body.textContent = 'Loading mesh data…';
            body.className = 'mesh-table-wrap empty-state';
            delete body.dataset.meshSig;
            info.textContent = '';
            return;
        }
        if (entry.error) {
            body.textContent = 'Mesh unavailable: ' + entry.error;
            body.className = 'mesh-table-wrap empty-state';
            delete body.dataset.meshSig;
            info.textContent = '';
            return;
        }
        const dec = prepareMeshData(entry);
        const attrs = dec.attrs;
        info.textContent = (dec.count + ' / ' + dec.total + ' indices')
            + (attrs.length ? ' · ' + attrs.length + ' attributes' : '');

        if (attrs.length === 0 || dec.count === 0) {
            body.textContent = 'No mesh data at this event.';
            body.className = 'mesh-table-wrap empty-state';
            delete body.dataset.meshSig;
            return;
        }

        body.className = 'mesh-table-wrap';
        buildMeshSkeleton(body, dec);
        // Force a render pass for the initial viewport.
        delete body.querySelector('.mesh-window').dataset.range;
        renderMeshRows(body, dec);

        // Also refresh the 3D preview.
        renderMeshPreview();
    }

    // ── Mesh 3D Preview ────────────────────────────────────────────
    // Canvas 2D wire-frame renderer with a simple orbit camera. For VSOut we
    // apply the perspective divide (x/w,y/w,z/w) so that clip-space output
    // lands in NDC; for VSIn we just auto-fit the AABB.
    function findPositionAttr(data) {
        const attrs = data.attributes || [];
        const prefer = ['gl_position','sv_position','position','pos','apos','vpos','vposition','in_position','a_position'];
        for (let i = 0; i < attrs.length; i++) {
            const n = (attrs[i].name || '').toLowerCase();
            if (prefer.some(p => n === p || n.includes(p))) return i;
        }
        // First attribute with 2+ components we can interpret as coords.
        for (let i = 0; i < attrs.length; i++) {
            if ((attrs[i].compCount || 0) >= 2) return i;
        }
        return 0;
    }

    function renderMeshPreview() {
        const pane = document.getElementById('mesh-preview-pane');
        const canvas = document.getElementById('mesh-canvas');
        if (!pane || !canvas) return;
        if (!state.meshShowPreview) { pane.classList.add('hidden'); return; }
        pane.classList.remove('hidden');

        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, pane.clientWidth);
        const cssH = Math.max(1, pane.clientHeight);
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        const W = canvas.width, H = canvas.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, H);

        const entry = state.meshCache[meshRequestKey()];
        if (!entry || entry.error || !entry.data) return;
        const dec = prepareMeshData(entry);
        if (!dec || dec.count === 0) return;
        const data = entry.data;

        const pi = findPositionAttr(data);
        const posAttr = dec.attrs[pi];
        if (!posAttr) return;
        const cc = posAttr.compCount || 0;
        const isClip = state.meshStage !== 'vsin';

        // Extract positions from raw buffers (much faster than re-JSON).
        const N = dec.count;
        const pts = new Array(N);
        let minX=Infinity,minY=Infinity,minZ=Infinity;
        let maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
        let anyFinite = false;
        for (let i = 0; i < N; i++) {
            const idxInfo = readIndexAt(dec, i);
            if (idxInfo.isRestart) { pts[i] = null; continue; }
            const vtxIdx = idxInfo.raw + dec.baseVertex;
            const v = decodeAttrCells(posAttr, dec, vtxIdx, false, 0);
            let x = +v[0] || 0;
            let y = +v[1] || 0;
            let z = cc >= 3 ? (+v[2] || 0) : 0;
            let wv = cc >= 4 ? (+v[3] || 1) : 1;
            if (isClip && wv !== 0 && isFinite(wv)) { x /= wv; y /= wv; z /= wv; }
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { pts[i] = null; continue; }
            pts[i] = [x, y, z];
            anyFinite = true;
            if (x<minX) minX=x; if (y<minY) minY=y; if (z<minZ) minZ=z;
            if (x>maxX) maxX=x; if (y>maxY) maxY=y; if (z>maxZ) maxZ=z;
        }
        if (!anyFinite) return;

        let cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
        let extent = Math.max(maxX-minX, maxY-minY, maxZ-minZ);
        if (!isFinite(extent) || extent <= 0) extent = 1;

        const cam = state.meshCam;
        const viewMin = Math.min(W, H);
        const s = (viewMin / extent) * 0.42 * cam.zoom;

        const ca = Math.cos(cam.yaw),  sa = Math.sin(cam.yaw);
        const cb = Math.cos(cam.pitch), sb = Math.sin(cam.pitch);

        function project(p) {
            let x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
            // yaw around Y
            let x1 = ca * x + sa * z;
            let z1 = -sa * x + ca * z;
            // pitch around X
            let y2 = cb * y - sb * z1;
            // z2 = sb*y + cb*z1;   // unused (no perspective in preview)
            const sx = W * 0.5 + x1 * s + cam.panX * dpr;
            const sy = H * 0.5 - y2 * s + cam.panY * dpr;
            return [sx, sy];
        }

        // Axes (origin marker).
        ctx.lineWidth = 1 * dpr;
        const axLen = viewMin * 0.04;
        const ax = project([cx, cy, cz]);
        ctx.strokeStyle = '#ff5050'; ctx.beginPath();
        const axx = project([cx + extent*0.15, cy, cz]);
        ctx.moveTo(ax[0], ax[1]); ctx.lineTo(axx[0], axx[1]); ctx.stroke();
        ctx.strokeStyle = '#50c050'; ctx.beginPath();
        const axy = project([cx, cy + extent*0.15, cz]);
        ctx.moveTo(ax[0], ax[1]); ctx.lineTo(axy[0], axy[1]); ctx.stroke();
        ctx.strokeStyle = '#5080ff'; ctx.beginPath();
        const axz = project([cx, cy, cz + extent*0.15]);
        ctx.moveTo(ax[0], ax[1]); ctx.lineTo(axz[0], axz[1]); ctx.stroke();

        // Topology enum (RenderDoc Topology):
        //  0 Unknown, 1 PointList, 2 LineList, 3 LineStrip, 4 LineLoop,
        //  5 TriangleList, 6 TriangleStrip, 7 TriangleFan,
        //  8 LineList_Adj, 9 LineStrip_Adj, 10 TriangleList_Adj, 11 TriangleStrip_Adj,
        //  12+ PatchList (treat as points).
        const topo = data.topology;

        ctx.strokeStyle = '#7fb4ff';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        function segment(a, b) {
            const pa = pts[a], pb = pts[b];
            if (!pa || !pb) return;
            const p1 = project(pa), p2 = project(pb);
            ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
        }

        if (topo === 1) {
            // PointList — drawn below.
        } else if (topo === 2) {
            for (let i = 0; i + 1 < N; i += 2) segment(i, i+1);
        } else if (topo === 3 || topo === 9) {
            for (let i = 0; i + 1 < N; i++) segment(i, i+1);
        } else if (topo === 4) {
            for (let i = 0; i + 1 < N; i++) segment(i, i+1);
            if (N >= 2) segment(N-1, 0);
        } else if (topo === 5 || topo === 10) {
            const step = topo === 10 ? 6 : 3;
            const take = topo === 10 ? [0, 2, 4] : [0, 1, 2];
            for (let i = 0; i + step - 1 < N; i += step) {
                const a = i + take[0], b = i + take[1], c = i + take[2];
                segment(a, b); segment(b, c); segment(c, a);
            }
        } else if (topo === 6 || topo === 11) {
            // triangle strip — each new vertex forms a triangle with previous two
            const stride = topo === 11 ? 2 : 1;
            for (let i = 0; i + 2 * stride < N; i++) {
                const a = i * stride, b = (i + 1) * stride, c = (i + 2) * stride;
                if (c >= N) break;
                if (!pts[a] || !pts[b] || !pts[c]) continue;
                segment(a, b); segment(b, c); segment(a, c);
            }
        } else if (topo === 7) {
            for (let i = 1; i + 1 < N; i++) { segment(0, i); segment(i, i+1); }
            if (N >= 3) segment(N-1, 0);
        } else if (topo === 8) {
            for (let i = 0; i + 3 < N; i += 4) segment(i+1, i+2);
        } else {
            // Fallback: connect consecutive.
            for (let i = 0; i + 1 < N; i++) segment(i, i+1);
        }
        ctx.stroke();

        // Points.
        if (topo === 1 || N <= 64) {
            ctx.fillStyle = '#cfe3ff';
            for (let i = 0; i < N; i++) {
                if (!pts[i]) continue;
                const p = project(pts[i]);
                ctx.fillRect(p[0] - 1.5 * dpr, p[1] - 1.5 * dpr, 3 * dpr, 3 * dpr);
            }
        }
    }

    // Mesh toolbar wiring (once at load).
    (function wireMeshToolbar() {
        const tb = document.getElementById('mesh-toolbar');
        if (!tb) return;
        tb.querySelectorAll('.scope-toggle[data-scope="mesh"] .scope').forEach(btn => {
            btn.addEventListener('click', () => {
                tb.querySelectorAll('.scope-toggle[data-scope="mesh"] .scope').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.meshStage = btn.dataset.val;
                state.meshCam.auto = true;
                renderMesh();
            });
        });
        const maxInput = document.getElementById('mesh-max');
        if (maxInput) {
            maxInput.addEventListener('change', () => {
                const raw = maxInput.value.trim();
                if (raw === '') {
                    state.meshMax = 0; // all
                } else {
                    const n = parseInt(raw, 10);
                    if (!isNaN(n) && n >= 0) {
                        state.meshMax = Math.min(4194304, n);
                    }
                }
                renderMesh();
            });
        }
        const reload = document.getElementById('mesh-refresh');
        if (reload) {
            reload.addEventListener('click', () => {
                const key = meshRequestKey();
                delete state.meshCache[key];
                delete state.meshPending[key];
                renderMesh();
            });
        }
        const reset = document.getElementById('mesh-reset-view');
        if (reset) {
            reset.addEventListener('click', () => {
                state.meshCam = { yaw: 0.6, pitch: 0.4, zoom: 1.0, panX: 0, panY: 0, auto: true };
                renderMeshPreview();
            });
        }
        const previewChk = document.getElementById('mesh-show-preview');
        if (previewChk) {
            previewChk.addEventListener('change', () => {
                state.meshShowPreview = previewChk.checked;
                renderMeshPreview();
            });
        }

        // Pointer camera on the canvas.
        const canvas = document.getElementById('mesh-canvas');
        if (canvas) {
            let dragging = false, sx = 0, sy = 0, panMode = false;
            canvas.addEventListener('pointerdown', e => {
                dragging = true;
                panMode = e.shiftKey || e.button === 1 || e.button === 2;
                sx = e.clientX; sy = e.clientY;
                canvas.setPointerCapture(e.pointerId);
            });
            canvas.addEventListener('pointermove', e => {
                if (!dragging) return;
                const dx = e.clientX - sx;
                const dy = e.clientY - sy;
                sx = e.clientX; sy = e.clientY;
                if (panMode) {
                    state.meshCam.panX += dx;
                    state.meshCam.panY += dy;
                } else {
                    state.meshCam.yaw   += dx * 0.01;
                    state.meshCam.pitch += dy * 0.01;
                    const limit = Math.PI / 2 - 0.01;
                    if (state.meshCam.pitch >  limit) state.meshCam.pitch =  limit;
                    if (state.meshCam.pitch < -limit) state.meshCam.pitch = -limit;
                }
                renderMeshPreview();
            });
            canvas.addEventListener('pointerup', e => {
                dragging = false;
                try { canvas.releasePointerCapture(e.pointerId); } catch {}
            });
            canvas.addEventListener('contextmenu', e => e.preventDefault());
            canvas.addEventListener('wheel', e => {
                e.preventDefault();
                const f = Math.exp(-e.deltaY * 0.001);
                state.meshCam.zoom = Math.max(0.05, Math.min(50, state.meshCam.zoom * f));
                renderMeshPreview();
            }, { passive: false });
        }

        // Redraw on resize.
        window.addEventListener('resize', () => {
            if (state.activeTab === 'mesh') renderMeshPreview();
        });
    })();

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
    