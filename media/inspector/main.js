
(() => {
    const vscode = acquireVsCodeApi();
    const TEXTURES_SPLIT_STORAGE_KEY = 'renderdoc.texturesPreviewHeight';
    const TEXTURES_PREVIEW_MIN_HEIGHT = 140;
    const TEXTURES_LIST_MIN_HEIGHT = 140;
    const SHADER_ENCODING = {
        Unknown: 0,
        DXBC: 1,
        GLSL: 2,
        SPIRV: 3,
        SPIRVAsm: 4,
        HLSL: 5,
        DXIL: 6,
        OpenGLSPIRV: 7,
        OpenGLSPIRVAsm: 8,
        Slang: 9,
    };
    const state = {
        captureInfo: null,
        drawCalls: [],
        resources: [],
        resourceAliases: {},
        eventId: null,
        drawCall: null,
        shaders: null,
        pipeline: null,
        shaderDrafts: {},
        shaderEditBusy: false,
        shaderEditStatus: null,
        shaderEditStatusStage: null,
        shaderDiagnostics: [],
        shaderDiagnosticsStage: null,
        shaderDiagnosticJump: null,
        shaderEditorSyncKey: null,
        shaderEditorContext: null,
        pendingShaderSelection: null,
        activeTab: 'textures',
        activeShaderStage: null,
        activeShaderFile: {}, // map: stage -> file index (or -1 for disassembly)
        activePipelineStage: null,
        pipelineConstantBuffer: null,
        pipelineConstantBufferBusyKey: null,
        eventFilter: '',
        texFilter: '',
        resFilter: '',
        resTypeFilter: 'all',
        modalResource: null,
        modalChannel: -1,
        currentPreviewChannel: -1,
        currentPreviewOverlay: 'none',
        currentPreviewBaseGammaEnabled: true,
        eventScope: 'all',   // 'all' | 'group'
        texScope: 'output',  // 'output' | 'input'
        meshStage: 'vsin',   // 'vsin' | 'vsout'
        meshMax: 0,          // 0 = all rows (matches RenderDoc desktop BufferViewer)
        meshCache: {},       // key -> { data } | { error }
        meshPending: {},
        meshShowPreview: true,
        meshCam: { yaw: 0.6, pitch: 0.4, zoom: 1.0, panX: 0, panY: 0, auto: true },
        graphZoom: 1,
        graphMinZoom: 0.05,
        graphMaxZoom: 2.5,
        timings: {},
        timingsAvailable: false,
        timingsError: null,
        graphFocus: null,
        replayStatus: {
            status: 'none',
            mode: 'none',
            hostUrl: null,
            hint: null,
            recommendRemote: false,
        },
        maliOfflineCompilerConfigured: false,
        maliOfflineCompilerHint: null,
        maliAnalysisByShader: {},
        pendingMaliAnalysis: null,
        maliSelectedDevice: '',
    };

    // Build resourceId -> resource info lookup (strings for consistent key match)
    const resById = () => {
        const m = new Map();
        for (const r of state.resources) m.set(String(r.resourceId), r);
        return m;
    };
    const resourceDisplayName = (resource) => {
        if (!resource) return '';
        return state.resourceAliases[String(resource.resourceId)] || resource.name || ('Resource ' + resource.resourceId);
    };
    const resName = (rid) => {
        const r = resById().get(String(rid));
        return r ? resourceDisplayName(r) : ('Resource ' + rid);
    };

    function shaderDraftBucket(stage, create) {
        if (!state.shaderDrafts[stage] && create) {
            state.shaderDrafts[stage] = {};
        }
        return state.shaderDrafts[stage] || null;
    }

    function getShaderDraft(stage, fileIndex, fallback) {
        const bucket = shaderDraftBucket(stage, false);
        const key = String(fileIndex);
        return bucket && Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
    }

    function setShaderDraft(stage, fileIndex, value, originalValue) {
        const key = String(fileIndex);
        const bucket = shaderDraftBucket(stage, true);
        if (value === originalValue) {
            delete bucket[key];
            if (Object.keys(bucket).length === 0) {
                delete state.shaderDrafts[stage];
            }
            return;
        }
        bucket[key] = value;
    }

    function clearShaderDraftsForStage(stage) {
        delete state.shaderDrafts[stage];
    }

    function clearAllShaderDrafts() {
        state.shaderDrafts = {};
    }

    function hasShaderDrafts(stage) {
        if (stage) {
            const bucket = shaderDraftBucket(stage, false);
            return !!(bucket && Object.keys(bucket).length > 0);
        }
        return Object.keys(state.shaderDrafts).length > 0;
    }

    function buildEditedShaderFiles(stage, files) {
        return files.map((file, index) => ({
            filename: file && file.filename ? file.filename : ('file ' + index),
            contents: getShaderDraft(stage, index, (file && file.contents) || ''),
        }));
    }

    function shaderLanguageForEncoding(encoding) {
        switch (encoding) {
            case SHADER_ENCODING.GLSL:
                return 'glsl';
            case SHADER_ENCODING.HLSL:
                return 'hlsl';
            case SHADER_ENCODING.Slang:
                return 'plaintext';
            case SHADER_ENCODING.SPIRVAsm:
            case SHADER_ENCODING.OpenGLSPIRVAsm:
                return 'plaintext';
            default:
                return 'plaintext';
        }
    }

    function renderShaderEditStatus() {
        return;
    }

    function renderMaliAnalysisPlaceholder(title, message) {
        return '<div class="shader-editor-card neutral">'
            + '<div class="shader-editor-eyebrow">Mali Analysis</div>'
            + '<div class="shader-editor-title">' + esc(title) + '</div>'
            + '<div class="shader-editor-copy">' + esc(message).replace(/\n/g, '<br>') + '</div>'
            + '</div>';
    }

    function renderMaliAnalysisResult(message) {
        if (maliModalEl && !maliModalEl.hidden) {
            renderMaliAnalysisModal();
        }
    }

    function openMaliOfflineSettings() {
        vscode.postMessage({ type: 'openMaliOfflineSettings' });
    }

    function getCurrentMaliDevice() {
        return String(state.maliSelectedDevice || '').trim();
    }

    function getMaliDeviceLabel(device) {
        const normalized = String(device || '').trim();
        return normalized || 'Default profile';
    }

    function shaderMaliAnalysisKey(eventId, stage, resourceId, device) {
        return [
            String(eventId ?? ''),
            String(stage ?? ''),
            String(resourceId ?? ''),
            String(device ?? ''),
        ].join('|');
    }

    function clearMaliAnalysisState() {
        state.maliAnalysisByShader = {};
        state.pendingMaliAnalysis = null;
    }

    function getPendingMaliAnalysisForShader(eventId, stage, resourceId, device) {
        const pending = state.pendingMaliAnalysis;
        if (!pending) return null;
        if (pending.eventId !== eventId || pending.stage !== stage) return null;
        if (String(pending.resourceId || '') !== String(resourceId || '')) return null;
        if (String(pending.device || '') !== String(device || '')) return null;
        return pending;
    }

    function getShaderMaliAnalysisRecord(eventId, stage, resourceId, device) {
        return state.maliAnalysisByShader[shaderMaliAnalysisKey(eventId, stage, resourceId, device)] || null;
    }

    function storePendingMaliAnalysisResult(message) {
        const pending = state.pendingMaliAnalysis;
        state.pendingMaliAnalysis = null;
        if (!pending || !message || message.notConfigured) {
            return null;
        }

        const record = {
            eventId: pending.eventId,
            stage: pending.stage,
            resourceId: pending.resourceId,
            device: pending.device || '',
            filename: pending.filename,
            source: pending.source,
            result: typeof message.result === 'string' ? message.result : '',
            error: typeof message.error === 'string' ? message.error : '',
            hint: typeof message.hint === 'string' ? message.hint : null,
            completedAt: Date.now(),
        };

        state.maliAnalysisByShader[shaderMaliAnalysisKey(record.eventId, record.stage, record.resourceId, record.device)] = record;
        return record;
    }

    function getMaliAnalyzeAvailability(selectedFileIndex, source, eventId, stage, resourceId, device) {
        const configured = !!state.maliOfflineCompilerConfigured;
        const pending = !!getPendingMaliAnalysisForShader(eventId, stage, resourceId, device);
        const busy = !!state.pendingMaliAnalysis;
        if (!configured) {
            const hint = state.maliOfflineCompilerHint || 'Set renderdoc.maliOfflineCompilerPath in VS Code Settings to enable Mali Offline Compiler analysis.';
            return {
                configured: false,
                canAnalyze: false,
                pending: false,
                busy: false,
                title: hint,
                reason: hint,
            };
        }
        if (pending) {
            return {
                configured: true,
                canAnalyze: false,
                pending: true,
                busy: true,
                title: 'Mali Offline Compiler analysis is already running for this shader stage',
                reason: 'Analysis is already running for this shader stage.',
            };
        }
        if (busy) {
            return {
                configured: true,
                canAnalyze: false,
                pending: false,
                busy: true,
                title: 'Mali Offline Compiler is already running',
                reason: 'Wait for the current Mali Offline Compiler run to finish before starting another analysis.',
            };
        }
        if (selectedFileIndex === -1) {
            return {
                configured: true,
                canAnalyze: false,
                pending: false,
                busy: false,
                title: 'Open Mali Offline Compiler analysis window',
                reason: 'Switch to a source file tab to analyze source code.',
            };
        }
        if (!source || !source.trim()) {
            return {
                configured: true,
                canAnalyze: false,
                pending: false,
                busy: false,
                title: 'Open Mali Offline Compiler analysis window',
                reason: 'No shader source is available to analyze.',
            };
        }
        return {
            configured: true,
            canAnalyze: true,
            pending: false,
            busy: false,
            title: 'Open Mali Offline Compiler analysis window',
            reason: '',
        };
    }

    function formatShaderStageLabel(stage) {
        return String(stage || 'unknown')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (match) => match.toUpperCase());
    }

    function formatShaderEncodingLabel(encoding) {
        switch (encoding) {
            case SHADER_ENCODING.DXBC:
                return 'DXBC';
            case SHADER_ENCODING.GLSL:
                return 'GLSL';
            case SHADER_ENCODING.SPIRV:
                return 'SPIR-V';
            case SHADER_ENCODING.SPIRVAsm:
                return 'SPIR-V ASM';
            case SHADER_ENCODING.HLSL:
                return 'HLSL';
            case SHADER_ENCODING.DXIL:
                return 'DXIL';
            case SHADER_ENCODING.OpenGLSPIRV:
                return 'OpenGL SPIR-V';
            case SHADER_ENCODING.OpenGLSPIRVAsm:
                return 'OpenGL SPIR-V ASM';
            case SHADER_ENCODING.Slang:
                return 'Slang';
            default:
                return 'Unknown';
        }
    }

    function getShaderTextMetrics(text) {
        const value = String(text || '');
        const lines = value.length > 0 ? value.split(/\r?\n/) : [];
        let nonEmptyLines = 0;
        for (const line of lines) {
            if (line.trim().length > 0) nonEmptyLines += 1;
        }
        return {
            lines: lines.length,
            nonEmptyLines,
            characters: value.length,
        };
    }

    function getShaderDiagnosticsSummary(stage) {
        const summary = { total: 0, error: 0, warning: 0, note: 0 };
        const diagnostics = state.shaderDiagnosticsStage === stage && Array.isArray(state.shaderDiagnostics)
            ? state.shaderDiagnostics
            : [];

        for (const diagnostic of diagnostics) {
            const severity = String(diagnostic && diagnostic.severity || 'note').toLowerCase();
            if (severity === 'error') summary.error += 1;
            else if (severity === 'warning') summary.warning += 1;
            else summary.note += 1;
            summary.total += 1;
        }

        return summary;
    }

    function getDirtyShaderFileCount(stage, files) {
        const sourceFiles = Array.isArray(files) ? files : [];
        let dirtyCount = 0;
        for (let index = 0; index < sourceFiles.length; index++) {
            const originalContents = (sourceFiles[index] && sourceFiles[index].contents) || '';
            const currentContents = getShaderDraft(stage, index, originalContents);
            if (currentContents !== originalContents) dirtyCount += 1;
        }
        return dirtyCount;
    }

    function normalizeMaliOutputLine(line) {
        return String(line || '')
            .replace(/\t/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractMaliNumericValue(value) {
        const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : null;
    }

    function parseMaliBooleanValue(value) {
        const normalized = normalizeMaliOutputLine(value).toLowerCase();
        if (!normalized) return null;
        if (/\b(no|false|disabled|none|off|not required|not needed|not present)\b/.test(normalized)) return false;
        if (/\b(yes|true|enabled|required|present|on)\b/.test(normalized)) return true;
        const numericValue = extractMaliNumericValue(normalized);
        if (numericValue != null) return numericValue > 0;
        return null;
    }

    function extractMaliHighlights(text, maxCount) {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map((line) => normalizeMaliOutputLine(line))
            .filter(Boolean);
        if (lines.length === 0) return [];

        const preferred = lines.filter((line) => /(cycle|instruction|register|varying|uniform|sampler|texture|spill|stack|bound|throughput|occup|thread|alu|latenc|work register|load\/store|ls)/i.test(line));
        const metricLines = preferred.length > 0 ? preferred : lines.filter((line) => line.includes(':'));
        const picked = (metricLines.length > 0 ? metricLines : lines)
            .filter((line, index, all) => all.indexOf(line) === index)
            .slice(0, Math.max(1, maxCount || 3));
        return picked;
    }

    function getMaliAnalysisOutputText(record) {
        if (!record) return '';

        const chunks = [];
        if (record.error) chunks.push(String(record.error));
        if (record.result && record.result !== record.error) chunks.push(String(record.result));

        return chunks.join('\n\n').trim();
    }

    function formatMaliMetricValue(spec, item) {
        if (!spec || !item) return '—';
        if (spec.kind === 'boolean') {
            if (item.booleanValue === true) return 'Yes';
            if (item.booleanValue === false) return 'No';
        }
        if (spec.unit === 'cycles' && item.numericValue != null) {
            return formatCompactNumber(item.numericValue) + ' cycles';
        }
        if (item.numericValue != null) {
            return formatCompactNumber(item.numericValue);
        }
        return item.rawValue || '—';
    }

    function parseMaliAnalysisSummary(text) {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map((line) => normalizeMaliOutputLine(line))
            .filter(Boolean);
        if (lines.length === 0) {
            return { metrics: [], signals: [], highlights: [] };
        }

        const specs = [
            {
                key: 'workRegisters',
                label: 'Work Registers',
                meta: 'Register pressure proxy',
                patterns: [/\bwork registers?\b\s*[:=]\s*(.+)$/i, /\bregisters used\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'uniformRegisters',
                label: 'Uniform Registers',
                meta: 'Uniform file usage',
                patterns: [/\buniform registers?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'longestCycles',
                label: 'Longest Path',
                meta: 'Estimated critical path length',
                unit: 'cycles',
                patterns: [/\blong(?:est)?(?: path)? cycles?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'shortestCycles',
                label: 'Shortest Path',
                meta: 'Best-case path length',
                unit: 'cycles',
                patterns: [/\bshort(?:est)?(?: path)? cycles?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'totalCycles',
                label: 'Total Cycles',
                meta: 'Aggregate cycle estimate',
                unit: 'cycles',
                patterns: [/\btotal(?: instruction)? cycles?\b\s*[:=]\s*(.+)$/i, /\binstruction cycles?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'varyings',
                label: 'Varyings',
                meta: 'Interpolator pressure',
                patterns: [/\bvaryings?\b\s*[:=]\s*(.+)$/i, /\binterpolators?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'samplers',
                label: 'Samplers',
                meta: 'Sampling descriptor pressure',
                patterns: [/\bsamplers?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'spill',
                label: 'Stack Spill',
                meta: 'Register overflow risk',
                kind: 'boolean',
                patterns: [/\bstack spill(?:ing)?\b\s*[:=]\s*(.+)$/i, /\bspilling\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'texture',
                label: 'Texture Pressure',
                meta: 'Sampling / texturing pressure',
                patterns: [/\btexture(?:\s+\w+)?\b\s*[:=]\s*(.+)$/i, /\btex(?:ture)? instructions?\b\s*[:=]\s*(.+)$/i],
            },
            {
                key: 'loadStore',
                label: 'Load / Store',
                meta: 'Memory pipeline pressure',
                patterns: [/\bload\/store\b\s*[:=]\s*(.+)$/i, /\bLS\b\s*[:=]\s*(.+)$/i],
            },
        ];

        const matches = new Map();
        const consumedLines = new Set();
        for (const spec of specs) {
            for (const line of lines) {
                let matchedValue = null;
                for (const pattern of spec.patterns) {
                    const match = line.match(pattern);
                    if (match) {
                        matchedValue = normalizeMaliOutputLine(match[1] || line);
                        break;
                    }
                }
                if (!matchedValue) continue;

                matches.set(spec.key, {
                    spec,
                    line,
                    rawValue: matchedValue,
                    numericValue: extractMaliNumericValue(matchedValue),
                    booleanValue: spec.kind === 'boolean' ? parseMaliBooleanValue(matchedValue) : null,
                });
                consumedLines.add(line);
                break;
            }
        }

        const orderedKeys = ['workRegisters', 'longestCycles', 'shortestCycles', 'totalCycles', 'uniformRegisters', 'varyings', 'samplers', 'spill', 'texture', 'loadStore'];
        const metrics = [];
        for (const key of orderedKeys) {
            const item = matches.get(key);
            if (!item) continue;
            metrics.push({
                label: item.spec.label,
                value: formatMaliMetricValue(item.spec, item),
                meta: item.spec.meta,
            });
        }

        const signals = [];
        const workRegisters = matches.get('workRegisters');
        if (workRegisters && workRegisters.numericValue != null) {
            if (workRegisters.numericValue >= 64) signals.push({ text: 'High Register Pressure', tone: 'danger' });
            else if (workRegisters.numericValue >= 32) signals.push({ text: 'Register Heavy', tone: 'warn' });
        }
        const samplers = matches.get('samplers');
        if (samplers && samplers.numericValue != null && samplers.numericValue >= 8) {
            signals.push({ text: 'Sampler Heavy', tone: 'warn' });
        }
        const spill = matches.get('spill');
        if (spill && spill.booleanValue === true) signals.push({ text: 'Spilling', tone: 'danger' });
        else if (spill && spill.booleanValue === false) signals.push({ text: 'No Spill', tone: 'good' });
        const longestCycles = matches.get('longestCycles') || matches.get('totalCycles');
        if (longestCycles && longestCycles.numericValue != null) {
            if (longestCycles.numericValue >= 64) signals.push({ text: 'Long Critical Path', tone: 'danger' });
            else if (longestCycles.numericValue >= 32) signals.push({ text: 'Long Path', tone: 'warn' });
        }
        const texture = matches.get('texture');
        if (texture && /bound|limit|heavy|latenc/i.test(texture.rawValue || '')) {
            signals.push({ text: 'Texture Bound', tone: 'warn' });
        }

        const highlights = extractMaliHighlights(text, 6)
            .filter((line) => !consumedLines.has(normalizeMaliOutputLine(line)))
            .slice(0, 4);

        return {
            metrics,
            signals: signals.filter((signal, index, all) => all.findIndex((entry) => entry.text === signal.text) === index),
            highlights,
        };
    }

    function getEmptyMaliAnalysisSummary() {
        return { metrics: [], signals: [], highlights: [] };
    }

    function getActiveMaliAnalysisContext() {
        const context = state.shaderEditorContext;
        const activeStage = state.activeShaderStage;
        if (!context || !activeStage) {
            return null;
        }
        return {
            eventId: state.eventId,
            stage: activeStage,
            resourceId: String(context.resourceId || ''),
            device: getCurrentMaliDevice(),
            source: String(context.currentCode || ''),
            filename: context.currentFileName || (activeStage + '-shader'),
            selectedFileIndex: typeof context.selectedFileIndex === 'number' ? context.selectedFileIndex : 0,
        };
    }

    function buildMaliAnalysisPresentation(context) {
        const availability = context
            ? getMaliAnalyzeAvailability(
                context.selectedFileIndex,
                context.source,
                context.eventId,
                context.stage,
                context.resourceId,
                context.device,
            )
            : {
                configured: !!state.maliOfflineCompilerConfigured,
                canAnalyze: false,
                pending: false,
                busy: !!state.pendingMaliAnalysis,
                title: state.maliOfflineCompilerConfigured
                    ? 'Open Mali Offline Compiler analysis window'
                    : (state.maliOfflineCompilerHint || 'Set renderdoc.maliOfflineCompilerPath in VS Code Settings to enable Mali Offline Compiler analysis.'),
                reason: state.maliOfflineCompilerConfigured
                    ? 'Select an event and a source file in the Shaders tab to analyze it with Mali Offline Compiler.'
                    : (state.maliOfflineCompilerHint || 'Set renderdoc.maliOfflineCompilerPath in VS Code Settings to enable Mali Offline Compiler analysis.'),
            };
        const selectedDeviceLabel = getMaliDeviceLabel(context ? context.device : getCurrentMaliDevice());

        const pendingMaliAnalysis = context
            ? getPendingMaliAnalysisForShader(context.eventId, context.stage, context.resourceId, context.device)
            : null;
        const maliRecord = context
            ? getShaderMaliAnalysisRecord(context.eventId, context.stage, context.resourceId, context.device)
            : null;
        const maliIsStale = !!(maliRecord && context && maliRecord.source !== context.source);
        const maliOutputText = getMaliAnalysisOutputText(maliRecord);
        const maliSummary = maliOutputText ? parseMaliAnalysisSummary(maliOutputText) : getEmptyMaliAnalysisSummary();
        const maliOutputLineCount = maliOutputText ? maliOutputText.split(/\r?\n/).length : 0;
        const sourceMetrics = getShaderTextMetrics(context ? context.source : '');
        const analysisSnapshotValue = context
            ? (context.filename || (context.stage + '-shader'))
            : 'No shader selected';

        let analysisTone = 'neutral';
        let analysisTitle = 'Ready to analyze';
        let analysisCopy = 'Run Mali Analyze to populate static performance-oriented findings for this source snapshot.';
        let analysisStatusValue = 'Ready';
        let analysisPills = [{ text: 'Mali Offline Compiler', tone: 'info' }];
        let analysisLines = [];
        let analysisMetrics = [
            {
                label: 'Status',
                value: analysisStatusValue,
                meta: 'Static source analysis',
            },
            {
                label: 'Device',
                value: selectedDeviceLabel,
                meta: context && context.device
                    ? 'Selected target GPU profile'
                    : 'Using malioc default device profile',
            },
            {
                label: 'Snapshot',
                value: analysisSnapshotValue,
                meta: sourceMetrics.lines > 0 ? (formatCompactNumber(sourceMetrics.lines) + ' current lines') : 'No source text loaded',
            },
        ];

        if (!context) {
            analysisTitle = availability.configured ? 'No shader source selected' : 'Tool not configured';
            analysisCopy = availability.reason;
            analysisStatusValue = availability.configured ? 'Idle' : 'Unavailable';
            if (availability.reason) {
                analysisLines = [availability.reason];
            }
            if (!availability.configured) {
                analysisPills.push({ text: 'Disabled', tone: 'neutral' });
            }
        } else if (!availability.configured) {
            analysisTitle = 'Tool not configured';
            analysisCopy = availability.reason;
            analysisStatusValue = 'Unavailable';
            analysisPills.push({ text: 'Disabled', tone: 'neutral' });
        } else if (pendingMaliAnalysis) {
            analysisTone = 'info';
            analysisTitle = 'Analysis in progress';
            analysisCopy = 'Mali Offline Compiler is processing the current source snapshot.';
            analysisStatusValue = 'Running';
            analysisPills.push({ text: 'Running', tone: 'info' });
            analysisLines = ['Results will appear here when the analysis finishes.'];
        } else if (maliRecord && maliRecord.error) {
            analysisTone = maliIsStale ? 'warn' : 'danger';
            analysisTitle = maliIsStale ? 'Last analysis failed and is stale' : 'Analysis failed';
            analysisCopy = maliIsStale
                ? 'The current source changed after the last failed Mali analysis run. Re-run the tool to refresh the status.'
                : 'Mali Offline Compiler returned an error for the latest source snapshot.';
            analysisStatusValue = maliIsStale ? 'Failed · Stale' : 'Failed';
            analysisPills.push({ text: 'Failed', tone: 'danger' });
            if (maliIsStale) analysisPills.push({ text: 'Stale', tone: 'warn' });
            if (maliSummary.highlights.length === 0) {
                const firstErrorLine = String(maliRecord.error || maliRecord.result || '').split(/\r?\n/).map((line) => normalizeMaliOutputLine(line)).find(Boolean);
                if (firstErrorLine) analysisLines = [firstErrorLine];
            } else {
                analysisLines = maliSummary.highlights;
            }
        } else if (maliRecord) {
            analysisTone = maliIsStale ? 'warn' : 'good';
            analysisTitle = maliIsStale ? 'Analysis is stale' : 'Analysis available';
            analysisCopy = maliIsStale
                ? 'The current source differs from the snapshot that produced the latest Mali findings. Re-run the analysis to refresh them.'
                : 'Latest Mali Offline Compiler findings are attached to this source snapshot.';
            analysisStatusValue = maliIsStale ? 'Stale' : 'Available';
            analysisPills.push({ text: maliIsStale ? 'Stale' : 'Available', tone: maliIsStale ? 'warn' : 'good' });
            analysisLines = maliSummary.highlights.length > 0
                ? maliSummary.highlights
                : ['Full compiler output is available in this window.'];
        }

        if (availability.configured && availability.reason && !availability.canAnalyze && !pendingMaliAnalysis) {
            if (!maliRecord) {
                analysisTone = 'warn';
                analysisTitle = 'Analysis unavailable';
                analysisCopy = availability.reason;
                analysisStatusValue = 'Blocked';
                analysisLines = [availability.reason];
            } else if (!analysisLines.includes(availability.reason)) {
                analysisLines = [availability.reason].concat(analysisLines).slice(0, 4);
            }
        }

        analysisMetrics[0].value = analysisStatusValue;
        analysisMetrics[1].value = analysisSnapshotValue;
        if (!pendingMaliAnalysis && maliRecord && maliSummary.signals.length > 0) {
            analysisPills = analysisPills.concat(maliSummary.signals);
        }
        if (!pendingMaliAnalysis && maliRecord && maliSummary.metrics.length > 0) {
            analysisMetrics = analysisMetrics.concat(maliSummary.metrics);
        } else {
            analysisMetrics.push({
                label: 'Highlights',
                value: formatCompactNumber(analysisLines.length),
                meta: maliRecord ? 'Summary lines extracted from latest result' : 'Awaiting tool output',
            });
        }

        const outputTone = pendingMaliAnalysis
            ? 'info'
            : (maliRecord && maliRecord.error)
                ? (maliIsStale ? 'warn' : 'danger')
                : (maliIsStale ? 'warn' : 'neutral');
        const outputTitle = pendingMaliAnalysis
            ? 'Compiler output pending'
            : (maliRecord && maliRecord.error)
                ? 'Compiler error output'
                : maliRecord
                    ? 'Complete compiler report'
                    : 'No compiler output yet';
        const outputCopy = pendingMaliAnalysis
            ? 'Full stdout/stderr from Mali Offline Compiler will appear here when the current run completes.'
            : maliRecord
                ? 'This is the verbatim output captured from Mali Offline Compiler for the analyzed shader snapshot.'
                : availability.configured
                    ? 'Run analysis to capture the full compiler stdout/stderr for this shader snapshot.'
                    : availability.reason;
        const outputMetrics = maliOutputText
            ? [
                {
                    label: 'Output Lines',
                    value: formatCompactNumber(maliOutputLineCount),
                    meta: 'Verbatim compiler stdout/stderr',
                },
                {
                    label: 'Characters',
                    value: formatCompactNumber(maliOutputText.length),
                    meta: 'Captured report size',
                },
            ]
            : [];
        const outputText = pendingMaliAnalysis
            ? 'Waiting for Mali Offline Compiler output…'
            : (maliOutputText || (availability.configured ? 'No analysis output yet.' : availability.reason));

        return {
            context,
            availability,
            pendingMaliAnalysis,
            maliRecord,
            maliIsStale,
            analysisTone,
            analysisTitle,
            analysisCopy,
            analysisPills,
            analysisMetrics,
            analysisLines,
            outputTone,
            outputTitle,
            outputCopy,
            outputMetrics,
            outputText,
        };
    }

    function shouldAutoRunMaliAnalysis(presentation) {
        return !!(
            presentation
            && presentation.context
            && presentation.availability.configured
            && presentation.availability.canAnalyze
            && !presentation.availability.busy
            && !presentation.pendingMaliAnalysis
            && (!presentation.maliRecord || presentation.maliIsStale || presentation.maliRecord.error)
        );
    }

    function startMaliAnalysisForContext(context) {
        if (!context) return false;

        const availability = getMaliAnalyzeAvailability(
            context.selectedFileIndex,
            context.source,
            context.eventId,
            context.stage,
            context.resourceId,
            context.device,
        );

        if (!availability.configured) {
            openMaliOfflineSettings();
            return false;
        }
        if (!availability.canAnalyze || availability.pending) {
            return false;
        }

        state.pendingMaliAnalysis = {
            eventId: context.eventId,
            stage: context.stage,
            resourceId: context.resourceId,
            device: context.device || '',
            filename: context.filename,
            source: context.source,
            startedAt: Date.now(),
        };

        if (state.activeTab === 'shaders') {
            renderShaders();
        }
        if (maliModalEl && !maliModalEl.hidden) {
            renderMaliAnalysisModal();
        }

        vscode.postMessage({
            type: 'analyzeMaliOffline',
            source: context.source,
            stage: context.stage,
            device: context.device || undefined,
        });
        return true;
    }

    function getShaderStageLookupAliases(stageKey) {
        const normalized = String(stageKey || '').trim();
        const shaderStages = GFX_PIPELINE.filter((stage) => stage.kind === 'Shader').concat([{ id: 'compute', aliases: [] }]);
        for (const stage of shaderStages) {
            const aliases = Array.isArray(stage.aliases) ? stage.aliases : [];
            if (stage.id === normalized || aliases.includes(normalized)) {
                return [stage.id].concat(aliases).filter((entry) => entry && entry !== normalized);
            }
        }
        return [];
    }

    function resolvePipelineStageResources(pipeline, stageKey) {
        const stageResources = pipeline && pipeline.stageResources;
        if (!stageResources) return null;
        const match = resolveShader(stageResources, stageKey, getShaderStageLookupAliases(stageKey));
        return match ? match.info : null;
    }

    function hasResolvedConstantBlock(entry) {
        if (!entry) return false;
        if (entry.bufferResourceId) return true;
        if (entry.compileConstants) return true;
        if (entry.inlineDataBytes) return true;
        if (entry.bufferBacked === false) return true;
        return false;
    }

    function buildShaderBindingSummary(pipeline, stageKey) {
        if (!pipeline) {
            return {
                tone: 'neutral',
                title: 'Waiting for pipeline state',
                copy: 'Pipeline reflection and binding summaries appear after the current event pipeline snapshot finishes loading.',
                pills: [{ text: 'Loading', tone: 'neutral' }],
                metrics: [
                    { label: 'Reflection', value: 'Pending', meta: 'Pipeline snapshot not loaded yet' },
                ],
                kvs: [],
                lines: [],
            };
        }

        if (pipeline.error) {
            return {
                tone: 'warn',
                title: 'Pipeline reflection unavailable',
                copy: 'The current event pipeline state could not be resolved, so binding summaries are unavailable for this stage.',
                pills: [{ text: 'Unavailable', tone: 'warn' }],
                metrics: [
                    { label: 'Reflection', value: 'Unavailable', meta: 'Pipeline state request failed' },
                ],
                kvs: [],
                lines: [String(pipeline.error)],
            };
        }

        const resources = resolvePipelineStageResources(pipeline, stageKey);
        if (!resources) {
            return {
                tone: 'neutral',
                title: 'No stage resource snapshot',
                copy: 'This shader stage has no reflected stageResources payload in the current pipeline snapshot.',
                pills: [{ text: 'Unavailable', tone: 'neutral' }],
                metrics: [
                    { label: 'Reflection', value: 'Missing', meta: 'No stageResources entry for this stage' },
                ],
                kvs: [],
                lines: [],
            };
        }

        const textures = Array.isArray(resources.textures) ? resources.textures : [];
        const samplers = Array.isArray(resources.samplers) ? resources.samplers : [];
        const constantBlocks = Array.isArray(resources.constantBlocks) ? resources.constantBlocks : [];
        const hasReflection = !!resources.hasReflection;
        const textureViews = textures.filter((entry) => String(entry && entry.kind || '').toLowerCase() === 'texture');
        const bufferViews = textures.filter((entry) => String(entry && entry.kind || '').toLowerCase() === 'buffer');
        const resolvedViews = textures.filter((entry) => !!(entry && entry.resourceId));
        const compareSamplers = samplers.filter((entry) => !!(entry && entry.compareEnable));
        const samplerObjects = samplers.filter((entry) => !!(entry && entry.resourceId));
        const resolvedBlocks = constantBlocks.filter((entry) => hasResolvedConstantBlock(entry));
        const directBlocks = constantBlocks.filter((entry) => entry && entry.bufferBacked === false);
        const compileConstantBlocks = constantBlocks.filter((entry) => !!(entry && entry.compileConstants));
        const inlineBlocks = constantBlocks.filter((entry) => !!(entry && entry.inlineDataBytes));
        const inputAttachments = textures.filter((entry) => !!(entry && entry.inputAttachment));
        const samplerBackedTextures = textures.filter((entry) => !!(entry && entry.hasSampler));
        const staticallyUnused = textures.concat(samplers, constantBlocks).filter((entry) => !!(entry && entry.staticallyUnused));
        const totalConstantBytes = constantBlocks.reduce((sum, entry) => sum + Number(entry && (entry.boundByteSize || entry.byteSize || entry.inlineDataBytes) || 0), 0);
        const reflectedBindingCount = textures.length + samplers.length + constantBlocks.length;
        const resolvedViewNames = resolvedViews
            .map((entry) => entry.resourceName || entry.name)
            .filter(Boolean)
            .slice(0, 3);
        const unusedNames = staticallyUnused
            .map((entry) => entry.name)
            .filter(Boolean)
            .slice(0, 3);

        let tone = 'info';
        if (!hasReflection) tone = 'neutral';
        else if (staticallyUnused.length > 0) tone = 'warn';
        else if (reflectedBindingCount > 0) tone = 'good';

        const lines = [];
        if (resolvedViewNames.length > 0) {
            lines.push('Resolved views: ' + resolvedViewNames.join(', ') + (resolvedViews.length > resolvedViewNames.length ? ' +' + (resolvedViews.length - resolvedViewNames.length) : ''));
        }
        if (unusedNames.length > 0) {
            lines.push('Statically unused: ' + unusedNames.join(', ') + (staticallyUnused.length > unusedNames.length ? ' +' + (staticallyUnused.length - unusedNames.length) : ''));
        }
        if (directBlocks.length > 0 || compileConstantBlocks.length > 0 || inlineBlocks.length > 0) {
            lines.push(
                formatCompactNumber(directBlocks.length + inlineBlocks.length) + ' direct / inline block' + ((directBlocks.length + inlineBlocks.length) === 1 ? '' : 's')
                + ' · '
                + formatCompactNumber(compileConstantBlocks.length) + ' compile-time constant block' + (compileConstantBlocks.length === 1 ? '' : 's')
            );
        }

        return {
            tone,
            title: hasReflection ? (formatCompactNumber(reflectedBindingCount) + ' reflected bindings') : 'Reflection unavailable',
            copy: hasReflection
                ? 'Binding counts come from the current pipeline reflection and resolved descriptor state for this stage.'
                : 'RenderDoc did not expose reflection metadata for the current stage at this event.',
            pills: [
                { text: hasReflection ? 'Reflection Ready' : 'No Reflection', tone: hasReflection ? 'good' : 'neutral' },
                staticallyUnused.length > 0 ? { text: staticallyUnused.length + ' Unused', tone: 'warn' } : null,
                inputAttachments.length > 0 ? { text: inputAttachments.length + ' Input Attachments', tone: 'info' } : null,
            ],
            metrics: [
                {
                    label: 'Read-Only Views',
                    value: formatCompactNumber(textures.length),
                    meta: textureViews.length + ' textures · ' + bufferViews.length + ' buffers',
                },
                {
                    label: 'Resolved Views',
                    value: formatCompactNumber(resolvedViews.length),
                    meta: textures.length > 0 ? (formatOverviewPercent(resolvedViews.length / Math.max(1, textures.length)) + ' currently bound') : 'No read-only resources',
                },
                {
                    label: 'Samplers',
                    value: formatCompactNumber(samplers.length),
                    meta: compareSamplers.length + ' compare · ' + samplerObjects.length + ' objects',
                },
                {
                    label: 'Uniform Blocks',
                    value: formatCompactNumber(constantBlocks.length),
                    meta: resolvedBlocks.length + ' resolved · ' + (directBlocks.length + inlineBlocks.length) + ' direct/inline',
                },
            ],
            kvs: [
                { label: 'Uniform Bytes', value: formatByteSize(totalConstantBytes) },
                { label: 'Sampler-backed Resources', value: formatCompactNumber(samplerBackedTextures.length) },
                { label: 'Compile Constants', value: formatCompactNumber(compileConstantBlocks.length) },
                { label: 'Unused Bindings', value: formatCompactNumber(staticallyUnused.length) },
            ],
            lines,
        };
    }

    function renderShaderStatusMetric(label, value, meta) {
        return '<div class="shader-status-metric">'
            + '<div class="shader-status-metric-label">' + esc(label) + '</div>'
            + '<div class="shader-status-metric-value">' + esc(value == null ? '—' : String(value)) + '</div>'
            + (meta ? '<div class="shader-status-metric-meta">' + esc(meta) + '</div>' : '')
            + '</div>';
    }

    function renderShaderStatusKv(label, value) {
        return '<div class="shader-status-k">' + esc(label) + '</div>'
            + '<div class="shader-status-v">' + esc(value == null ? '—' : String(value)) + '</div>';
    }

    function renderShaderStatusCard(options) {
        const pills = Array.isArray(options && options.pills) ? options.pills.filter((pill) => pill && pill.text) : [];
        const metrics = Array.isArray(options && options.metrics) ? options.metrics.filter(Boolean) : [];
        const kvs = Array.isArray(options && options.kvs) ? options.kvs.filter(Boolean) : [];
        const lines = Array.isArray(options && options.lines) ? options.lines.filter(Boolean) : [];
        const preformatted = typeof (options && options.preformatted) === 'string' ? options.preformatted : '';
        const className = options && options.className ? String(options.className).trim() : '';

        let html = '<section class="shader-status-card ' + esc(options && options.tone || 'neutral') + (className ? (' ' + esc(className)) : '') + '">';
        html += '<div class="shader-status-card-label">' + esc(options && options.label || 'Shader Status') + '</div>';
        html += '<div class="shader-status-card-title">' + esc(options && options.title || 'Overview') + '</div>';
        if (options && options.copy) {
            html += '<div class="shader-status-card-copy">' + esc(options.copy).replace(/\n/g, '<br>') + '</div>';
        }
        if (pills.length > 0) {
            html += '<div class="shader-status-pill-row">';
            for (const pill of pills) {
                html += '<span class="shader-status-pill' + (pill.tone ? ' ' + esc(pill.tone) : '') + '">' + esc(pill.text) + '</span>';
            }
            html += '</div>';
        }
        if (metrics.length > 0) {
            html += '<div class="shader-status-metrics">';
            for (const metric of metrics) {
                html += renderShaderStatusMetric(metric.label, metric.value, metric.meta);
            }
            html += '</div>';
        }
        if (kvs.length > 0) {
            html += '<div class="shader-status-kv-grid">';
            for (const item of kvs) {
                html += renderShaderStatusKv(item.label, item.value);
            }
            html += '</div>';
        }
        if (lines.length > 0) {
            html += '<div class="shader-status-lines">';
            for (const line of lines) {
                html += '<div class="shader-status-line">' + esc(line) + '</div>';
            }
            html += '</div>';
        }
        if (preformatted) {
            html += '<pre class="shader-status-preformatted">' + esc(preformatted) + '</pre>';
        }
        html += '</section>';
        return html;
    }

    function clearShaderDiagnostics() {
        state.shaderDiagnostics = [];
        state.shaderDiagnosticsStage = null;
        state.shaderDiagnosticJump = null;
    }

    function clearShaderEditorSync() {
        state.shaderEditorSyncKey = null;
        state.shaderEditorContext = null;
        state.pendingShaderSelection = null;
    }

    function invalidateShaderEditorSyncKey() {
        state.shaderEditorSyncKey = null;
    }

    function shaderEditorSyncKeyForPayload(payload) {
        return [
            String(payload.eventId ?? ''),
            String(payload.resourceId ?? ''),
            String(payload.stage ?? ''),
            String(payload.selectedFileIndex ?? ''),
            String(payload.filename ?? ''),
        ].join('|');
    }

    function postOpenShaderInEditor(payload) {
        if (!payload || !payload.source) {
            return;
        }

        vscode.postMessage({
            type: 'openShaderInEditor',
            source: payload.source,
            language: payload.language,
            eventId: payload.eventId,
            resourceId: payload.resourceId,
            stage: payload.stage,
            filename: payload.filename,
            files: payload.files,
            selectedFileIndex: payload.selectedFileIndex,
            preserveFocus: payload.preserveFocus,
            openToSide: payload.openToSide,
            preview: payload.preview,
            line: payload.line,
            column: payload.column,
        });
    }

    function syncLinkedShaderEditor(payload) {
        if (!payload || !payload.source) {
            return;
        }

        const syncKey = shaderEditorSyncKeyForPayload(payload);

        if (state.shaderEditorSyncKey === syncKey) {
            return;
        }

        state.shaderEditorSyncKey = syncKey;
        postOpenShaderInEditor({
            ...payload,
            preserveFocus: true,
            openToSide: true,
            preview: true,
        });
    }

    function jumpToShaderDiagnostic(diagnostic) {
        if (!diagnostic || typeof diagnostic.line !== 'number') return;

        const context = state.shaderEditorContext;
        if (!context) {
            return;
        }

        const activeStage = state.activeShaderStage;
        const fileIndex = typeof diagnostic.fileIndex === 'number'
            ? diagnostic.fileIndex
            : state.activeShaderFile[activeStage];

        const targetFileIndex = typeof fileIndex === 'number' ? fileIndex : context.selectedFileIndex;
        let targetSource = context.currentCode;
        let targetFilename = context.currentFileName || (activeStage + '-shader');
        let targetLanguage = context.language;

        if (typeof targetFileIndex === 'number' &&
            targetFileIndex >= 0 &&
            Array.isArray(context.files) &&
            targetFileIndex < context.files.length) {
            targetSource = context.files[targetFileIndex].contents;
            targetFilename = context.files[targetFileIndex].filename;
            targetLanguage = context.language;
        } else if (targetFileIndex === -1) {
            targetLanguage = 'plaintext';
        }

        const openPayload = {
            source: targetSource,
            language: targetLanguage,
            eventId: context.eventId,
            resourceId: context.resourceId,
            stage: context.stage,
            filename: targetFilename,
            files: context.files,
            selectedFileIndex: targetFileIndex,
            preserveFocus: false,
            openToSide: true,
            preview: false,
            line: diagnostic.line,
            column: diagnostic.column || 1,
        };

        state.shaderEditorSyncKey = shaderEditorSyncKeyForPayload(openPayload);

        if (typeof targetFileIndex === 'number' && state.activeShaderFile[activeStage] !== targetFileIndex) {
            state.shaderDiagnosticJump = {
                stage: activeStage,
                fileIndex: targetFileIndex,
                line: diagnostic.line,
                column: diagnostic.column || 1,
            };
            state.activeShaderFile[activeStage] = targetFileIndex;
            renderShaders();
        }

        postOpenShaderInEditor(openPayload);
    }

    function applyPendingShaderSelection() {
        const pending = state.pendingShaderSelection;
        if (!pending || pending.eventId !== state.eventId || !state.shaders || !state.shaders.shaders) {
            return false;
        }

        const shaders = state.shaders.shaders || {};
        if (!shaders[pending.stage]) {
            return false;
        }

        state.activeShaderStage = pending.stage;
        state.activeShaderFile[pending.stage] = pending.fileIndex;
        state.pendingShaderSelection = null;

        if (state.activeTab !== 'shaders') {
            switchTab('shaders');
        } else {
            renderShaders();
        }
        return true;
    }

    function renderShaderDiagnostics() {
        const diagnosticsEl = document.getElementById('shader-diagnostics');
        if (!diagnosticsEl) return;

        const diagnostics = state.shaderDiagnosticsStage === state.activeShaderStage
            ? state.shaderDiagnostics
            : [];

        diagnosticsEl.innerHTML = '';
        if (!diagnostics || diagnostics.length === 0) {
            diagnosticsEl.hidden = true;
            return;
        }

        diagnosticsEl.hidden = false;
        for (const diagnostic of diagnostics) {
            const clickable = typeof diagnostic.line === 'number';
            const item = document.createElement(clickable ? 'button' : 'div');
            if (clickable) {
                item.type = 'button';
                item.addEventListener('click', () => jumpToShaderDiagnostic(diagnostic));
            }
            item.className = 'shader-diagnostic ' + (diagnostic.severity || 'note');

            const header = document.createElement('div');
            header.className = 'shader-diagnostic-head';

            const severity = document.createElement('span');
            severity.className = 'shader-diagnostic-severity';
            severity.textContent = String(diagnostic.severity || 'note');
            header.appendChild(severity);

            const location = document.createElement('span');
            location.className = 'shader-diagnostic-location';
            const locationParts = [];
            if (diagnostic.filename) {
                locationParts.push(diagnostic.filename);
            } else if (typeof diagnostic.fileIndex === 'number') {
                locationParts.push('file ' + diagnostic.fileIndex);
            }
            if (typeof diagnostic.line === 'number') {
                let lineText = String(diagnostic.line);
                if (typeof diagnostic.column === 'number') {
                    lineText += ':' + diagnostic.column;
                }
                locationParts.push(lineText);
            }
            location.textContent = locationParts.join(' · ') || 'Compile log';
            header.appendChild(location);

            const message = document.createElement('div');
            message.className = 'shader-diagnostic-message';
            message.textContent = diagnostic.message || diagnostic.raw || '';

            item.appendChild(header);
            item.appendChild(message);
            diagnosticsEl.appendChild(item);
        }
    }

    function clearShaderReplayViews() {
        state.shaders = null;
        state.pipeline = null;
        state.activePipelineStage = null;
        state.pipelineConstantBuffer = null;
        state.pipelineConstantBufferBusyKey = null;
        state.meshCache = {};
        state.meshPending = {};
        thumbCache.clear();
        thumbErrors.clear();
        thumbPending.clear();
        rtPreviewCache.clear();
        rtPreviewErrors.clear();
        rtPreviewPending.clear();
        resetCurrentRTPreviewView();
    }

    function updateShaderAliasesFromPipeline(pipeline) {
        const shaders = pipeline && pipeline.shaders;
        if (!shaders) return false;
        let changed = false;
        for (const info of Object.values(shaders)) {
            if (!info || info.resourceId == null) continue;
            const alias = info.programName || info.shaderName || info.name;
            if (!alias) continue;
            const resourceId = String(info.resourceId);
            if (state.resourceAliases[resourceId] === alias) continue;
            state.resourceAliases[resourceId] = alias;
            changed = true;
        }
        return changed;
    }

    function effectiveFramebuffer(pipe) {
        const fb = (pipe && pipe.framebuffer) || {};
        const colorTargets = Array.isArray(fb.colorTargets) ? fb.colorTargets.filter(Boolean) : [];
        const actionOutputs = Array.isArray(pipe && pipe.actionOutputs) ? pipe.actionOutputs.filter(Boolean) : [];
        const presentationColorTarget = pipe && pipe.presentationColorTarget;
        const presentationDepthTarget = pipe && pipe.presentationDepthTarget;
        const hasFramebufferOutputs = colorTargets.length || fb.depthTarget || fb.depthResolveTarget || fb.stencilTarget;
        const hasActionFallback = !!(actionOutputs.length || (pipe && pipe.actionDepth) || (pipe && pipe.actionCopyDestination));
        const usesPresentationFallback = !hasFramebufferOutputs && !hasActionFallback && !!(presentationColorTarget || presentationDepthTarget);
        return {
            colorTargets: hasFramebufferOutputs
                ? colorTargets
                : (hasActionFallback ? actionOutputs : (presentationColorTarget ? [presentationColorTarget] : [])),
            depthTarget: fb.depthTarget || (hasFramebufferOutputs ? null : ((pipe && pipe.actionDepth) || (usesPresentationFallback ? presentationDepthTarget : null))),
            depthResolveTarget: fb.depthResolveTarget || null,
            stencilTarget: fb.stencilTarget || null,
            copyDestination: hasFramebufferOutputs ? (pipe && pipe.actionCopyDestination) : (hasActionFallback ? (pipe && pipe.actionCopyDestination) : null),
            usesActionFallback: !hasFramebufferOutputs && hasActionFallback,
            usesPresentationFallback,
        };
    }

    function currentOutputInfo(pipe) {
        const fb = effectiveFramebuffer(pipe);
        if (fb.colorTargets && fb.colorTargets.length) {
            return { resourceId: fb.colorTargets[0], label: fb.usesPresentationFallback ? 'Presentation' : 'Cur Output 0', framebuffer: fb };
        }
        if (fb.depthResolveTarget) {
            return { resourceId: fb.depthResolveTarget, label: 'Cur Depth Resolve', framebuffer: fb };
        }
        if (fb.depthTarget) {
            return { resourceId: fb.depthTarget, label: fb.usesPresentationFallback ? 'Presentation Depth' : 'Cur Depth', framebuffer: fb };
        }
        if (fb.copyDestination) {
            return { resourceId: fb.copyDestination, label: 'Cur Copy Dest', framebuffer: fb };
        }
        return null;
    }

    function currentOverlayTargetInfo(pipe) {
        const fb = effectiveFramebuffer(pipe);
        if (fb.colorTargets && fb.colorTargets.length) {
            return {
                resourceId: String(fb.colorTargets[0]),
                label: fb.usesPresentationFallback ? 'Presentation' : 'Current Draw Output',
            };
        }

        if (pipe && pipe.presentationColorTarget) {
            return {
                resourceId: String(pipe.presentationColorTarget),
                label: 'Presentation',
            };
        }

        return null;
    }

    function currentPresentationInfo(pipe) {
        if (!pipe || pipe.error) return null;
        if (pipe.presentationColorTarget) {
            return {
                resourceId: String(pipe.presentationColorTarget),
                label: 'Presentation',
                metaBadge: 'backbuffer',
            };
        }
        if (pipe.presentationDepthTarget) {
            return {
                resourceId: String(pipe.presentationDepthTarget),
                label: 'Presentation Depth',
                metaBadge: 'backbuffer',
            };
        }
        return null;
    }

    function textureResourceById(resourceId) {
        if (resourceId == null) return null;
        const id = String(resourceId);
        const resource = resById().get(id);
        if (!resource) {
            return {
                resourceId: id,
                type: 'Texture',
                name: 'Texture ' + id,
                format: '',
                width: 0,
                height: 0,
                depth: 0,
                mipLevels: 0,
                byteSize: 0,
            };
        }
        if (resource.type && resource.type !== 'Texture') {
            return null;
        }
        return {
            resourceId: id,
            type: 'Texture',
            name: resource.name || ('Texture ' + id),
            format: resource.format || '',
            width: resource.width || 0,
            height: resource.height || 0,
            depth: resource.depth || 0,
            mipLevels: resource.mipLevels || 0,
            byteSize: resource.byteSize || 0,
        };
    }

    function collectScopedTextures(scopeIds, allTex) {
        const textureMap = new Map(allTex.map(t => [String(t.resourceId), t]));
        return Array.from(scopeIds)
            .map(id => textureMap.get(String(id)) || textureResourceById(id))
            .filter(Boolean);
    }

    function isOutputLikeResource(resourceId) {
        if (resourceId == null) return false;
        const pipe = state.pipeline;
        if (!pipe || pipe.error) return false;
        const fb = effectiveFramebuffer(pipe);
        const targets = new Set([
            ...((fb.colorTargets || []).map(id => String(id))),
            ...(fb.depthTarget ? [String(fb.depthTarget)] : []),
            ...(fb.depthResolveTarget ? [String(fb.depthResolveTarget)] : []),
            ...(fb.stencilTarget ? [String(fb.stencilTarget)] : []),
            ...(fb.copyDestination ? [String(fb.copyDestination)] : []),
        ]);
        return targets.has(String(resourceId));
    }

    function textureRequestEventId(resourceId, purpose) {
        if (purpose === 'preview') return state.eventId || 0;
        if (purpose === 'thumb') return state.eventId || 0;
        return state.eventId || 0;
    }

    // ── Tab switching ──────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
    function switchTab(tab) {
        state.activeTab = tab;
        if (tab === 'shaders') {
            invalidateShaderEditorSyncKey();
        }
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
        document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
        render();
        if (tab === 'textures') {
            requestAnimationFrame(() => {
                applyTexturesPreviewHeight(loadTexturesPreviewHeight());
                updateCurrentRTPreviewImageScale();
            });
        }
    }

    // ── Toolbar ────────────────────────────────────────────────────
    document.getElementById('btn-prev-event').addEventListener('click', () => navigateEvent(-1));
    document.getElementById('btn-next-event').addEventListener('click', () => navigateEvent(+1));
    document.getElementById('btn-jump').addEventListener('click', () => {
        const v = parseInt(document.getElementById('event-jump').value, 10);
        if (!isNaN(v)) vscode.postMessage({ type: 'selectEvent', eventId: v });
    });
    document.getElementById('replay-banner-action').addEventListener('click', () => {
        vscode.postMessage({ type: 'useRecommendedReplayHost' });
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
            if (dc.children?.length) {
                const found = findParentGroup(dc.children, eventId, dc);
                if (found !== null) return found;
                const contains = flattenEvents(dc.children).some(c => c.eventId === eventId);
                if (contains) return dc;
            }
            if (dc.eventId === eventId) return parent;
        }
        return null;
    }
    function findEventPath(list, eventId, trail = []) {
        for (const dc of list) {
            const next = trail.concat(dc);
            if (dc.children?.length) {
                const found = findEventPath(dc.children, eventId, next);
                if (found) return found;
            }
            if (dc.eventId === eventId) return next;
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
                {
                    const previousCapturePath = state.captureInfo?.filePath || null;
                    const nextCapturePath = m.captureInfo?.filePath || null;
                    const sameCapture = previousCapturePath === nextCapturePath;
                    if (!sameCapture) {
                        state.eventId = null;
                        state.drawCall = null;
                        state.shaders = null;
                        state.pipeline = null;
                        state.activePipelineStage = null;
                        state.pipelineConstantBuffer = null;
                        state.pipelineConstantBufferBusyKey = null;
                        clearAllShaderDrafts();
                        clearShaderDiagnostics();
                        clearShaderEditorSync();
                        state.shaderEditBusy = false;
                        state.shaderEditStatus = null;
                        state.shaderEditStatusStage = null;
                        clearMaliAnalysisState();
                        state.meshCache = {};
                        state.meshPending = {};
                    }
                }
                state.captureInfo = m.captureInfo;
                state.drawCalls = m.drawCalls || [];
                state.resources = m.resources || [];
                state.maliOfflineCompilerConfigured = !!m.maliOfflineCompilerConfigured;
                state.maliOfflineCompilerHint = m.maliOfflineCompilerHint || null;
                state.resourceAliases = {};
                state.currentPreviewChannel = -1;
                state.timings = {};
                state.timingsAvailable = false;
                state.timingsError = null;
                thumbCache.clear();
                thumbErrors.clear();
                thumbPending.clear();
                rtPreviewCache.clear();
                rtPreviewErrors.clear();
                rtPreviewPending.clear();
                resetCurrentRTPreviewView();
                render();
                if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                break;
            case 'replayStatus':
                state.replayStatus = {
                    status: m.status || 'none',
                    mode: m.mode || 'none',
                    hostUrl: m.hostUrl || null,
                    hint: m.hint || null,
                    recommendRemote: !!m.recommendRemote,
                };
                renderReplayBanner();
                break;
            case 'maliConfigChanged':
                state.maliOfflineCompilerConfigured = !!m.configured;
                state.maliOfflineCompilerHint = m.hint || null;
                if (state.activeTab === 'shaders') renderShaders();
                if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                break;
            case 'eventChanged':
                {
                    const sameEvent = state.eventId === m.eventId;
                    state.eventId = m.eventId;
                    state.drawCall = m.drawCall;
                    if (!sameEvent) {
                        state.shaders = null;
                        state.pipeline = null;
                        state.activePipelineStage = null;
                        state.pipelineConstantBuffer = null;
                        state.pipelineConstantBufferBusyKey = null;
                        clearAllShaderDrafts();
                        clearShaderDiagnostics();
                        clearShaderEditorSync();
                        state.shaderEditBusy = false;
                        state.shaderEditStatus = null;
                        state.shaderEditStatusStage = null;
                        state.meshCache = {};
                        state.meshPending = {};
                        state.meshCam.auto = true;
                        thumbCache.clear();
                        thumbErrors.clear();
                        thumbPending.clear();
                        rtPreviewCache.clear();
                        rtPreviewErrors.clear();
                        rtPreviewPending.clear();
                        resetCurrentRTPreviewView();
                    }
                    updateHeader();
                    render();
                    if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                    if (state.modalResource) {
                        textureModalPreviewEl.innerHTML = '<div class="muted">Loading…</div>';
                        requestTexture();
                    }
                }
                break;
            case 'shadersLoaded':
                if (m.eventId === state.eventId) {
                    state.shaders = m.data;
                    applyPendingShaderSelection();
                    if (state.activeTab === 'shaders') renderShaders();
                    if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                }
                break;
            case 'shaderEditResult':
                state.shaderEditBusy = false;
                state.shaderDiagnostics = Array.isArray(m.diagnostics) ? m.diagnostics : [];
                state.shaderDiagnosticsStage = m.stage || null;
                state.shaderDiagnosticJump = null;
                clearShaderEditorSync();
                state.shaderEditStatusStage = m.stage || null;
                state.shaderEditStatus = {
                    kind: m.ok ? 'success' : 'error',
                    message: m.message || (m.ok ? 'Shader update complete.' : 'Shader update failed.'),
                };
                if (m.ok && m.refresh) {
                    clearShaderDraftsForStage(m.stage);
                    clearShaderReplayViews();
                    render();
                    if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                    if (state.modalResource) {
                        textureModalPreviewEl.innerHTML = '<div class="muted">Loading…</div>';
                        requestTexture();
                    }
                } else if (state.activeTab === 'shaders') {
                    renderShaders();
                } else if (maliModalEl && !maliModalEl.hidden) {
                    renderMaliAnalysisModal();
                }
                break;
            case 'syncShaderSelection':
                state.pendingShaderSelection = {
                    eventId: m.eventId,
                    stage: m.stage,
                    fileIndex: m.fileIndex,
                };
                applyPendingShaderSelection();
                break;
            case 'pipelineLoaded':
                if (m.eventId === state.eventId) {
                    state.pipeline = m.data;
                    state.pipelineConstantBuffer = null;
                    state.pipelineConstantBufferBusyKey = null;
                    const aliasesChanged = updateShaderAliasesFromPipeline(m.data);
                    syncActivePipelineStage(m.data);
                    if (state.activeTab === 'pipeline' || state.activeTab === 'overview' || state.activeTab === 'pipelinegraph' || state.activeTab === 'textures') render();
                    else if (aliasesChanged && state.activeTab === 'resources') renderResources();
                    if (state.modalResource && isOutputLikeResource(state.modalResource.resourceId)) {
                        textureModalPreviewEl.innerHTML = '<div class="muted">Loading…</div>';
                        requestTexture();
                    }
                }
                break;
            case 'pipelineConstantBufferLoaded':
                if (m.eventId === state.eventId) {
                    const arrayElement = m.arrayElement || 0;
                    const requestKey = pipelineConstantBufferRequestKey(m.stage, m.cbufferIndex, arrayElement);
                    if (state.pipelineConstantBufferBusyKey === requestKey) {
                        state.pipelineConstantBufferBusyKey = null;
                    }
                    state.pipelineConstantBuffer = m.error
                        ? {
                            stage: m.stage,
                            cbufferIndex: m.cbufferIndex,
                            arrayElement,
                            error: m.error,
                        }
                        : (m.data || null);
                    if (state.activeTab === 'pipeline') {
                        renderPipeline();
                    }
                }
                break;
            case 'texturePreview':
                handleTexturePreview(m);
                break;
            case 'currentDrawPreview':
                handleCurrentDrawPreview(m);
                break;
            case 'meshLoaded':
                if (m.key) {
                    state.meshCache[m.key] = m.error ? { error: m.error } : { data: m.data };
                    delete state.meshPending[m.key];
                    if (state.activeTab === 'mesh') renderMesh();
                }
                break;
            case 'maliAnalysisResult':
                storePendingMaliAnalysisResult(m);
                renderMaliAnalysisResult(m);
                if (state.activeTab === 'shaders') renderShaders();
                if (maliModalEl && !maliModalEl.hidden) renderMaliAnalysisModal();
                break;
            case 'timingsLoaded':
                state.timings = m.timings || {};
                state.timingsAvailable = !!m.available;
                state.timingsError = m.error || null;
                if (state.activeTab === 'overview') renderOverview();
                if (state.activeTab === 'pipelinegraph') renderPipelineGraph();
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

    function renderReplayBanner() {
        const banner = document.getElementById('replay-banner');
        const badge = document.getElementById('replay-banner-badge');
        const text = document.getElementById('replay-banner-text');
        const action = document.getElementById('replay-banner-action');
        const replay = state.replayStatus || { status: 'none', mode: 'none' };

        if (!state.captureInfo || replay.status === 'none') {
            banner.hidden = true;
            return;
        }

        let tone = 'neutral';
        let label = 'Replay';
        let message = '';

        if (replay.status === 'active' && replay.mode === 'remote') {
            tone = 'good';
            label = 'Remote Replay';
            message = replay.hostUrl
                ? `Replaying on ${replay.hostUrl}. Inspection requests are using the remote renderer.`
                : 'Remote replay is active.';
        } else if (replay.status === 'active') {
            tone = replay.recommendRemote ? 'warn' : 'good';
            label = 'Local Replay';
            message = replay.hint || 'Replaying locally on this machine.';
        } else if (replay.status === 'unavailable') {
            tone = 'warn';
            label = 'Replay Pending';
            message = replay.hint || 'Replay is not active yet for this capture.';
        } else if (replay.status === 'failed') {
            tone = 'danger';
            label = 'Replay Failed';
            message = replay.hint || 'Inspection features are currently unavailable.';
        }

        banner.dataset.tone = tone;
        badge.textContent = label;
        text.textContent = message;
        action.hidden = !replay.recommendRemote;
        banner.hidden = false;
    }

    // ── Overview ───────────────────────────────────────────────────
    function buildDerivedOverviewStatistics() {
        const events = flattenEvents(state.drawCalls);
        const drawCount = events.filter(dc => String(dc.flags || '').toLowerCase().includes('drawcall')).length;
        const dispatchCount = events.filter(dc => String(dc.flags || '').toLowerCase().includes('dispatch')).length;
        const diagnosticCount = events.filter(dc => String(dc.flags || '').toLowerCase().includes('marker')).length;
        const maxEventId = events.reduce((max, dc) => Math.max(max, dc.eventId || 0), 0);
        const apiCallCount = Math.max(0, maxEventId - drawCount - dispatchCount - diagnosticCount);
        const textureResources = state.resources.filter(r => r.type === 'Texture');
        const bufferResources = state.resources.filter(r => r.type === 'Buffer');
        const textureBytes = textureResources.reduce((sum, resource) => sum + (resource.byteSize || 0), 0);
        const bufferBytes = bufferResources.reduce((sum, resource) => sum + (resource.byteSize || 0), 0);
        const avgTextureWidth = textureResources.length
            ? textureResources.reduce((sum, resource) => sum + (resource.width || 0), 0) / textureResources.length
            : 0;
        const avgTextureHeight = textureResources.length
            ? textureResources.reduce((sum, resource) => sum + (resource.height || 0), 0) / textureResources.length
            : 0;
        return {
            compressedFileSize: 0,
            uncompressedFileSize: 0,
            persistentSize: 0,
            initDataSize: 0,
            drawCount,
            dispatchCount,
            apiCallCount,
            apiDrawDispatchRatio: (drawCount + dispatchCount) > 0 ? (apiCallCount / (drawCount + dispatchCount)) : 0,
            textureCount: textureResources.length,
            textureBytes,
            largeTextureBytes: 0,
            renderTargetCount: 0,
            renderTargetBytes: 0,
            bufferCount: bufferResources.length,
            bufferBytes,
            indexBufferBytes: 0,
            vertexBufferBytes: 0,
            avgTextureWidth,
            avgTextureHeight,
            avgLargeTextureWidth: 0,
            avgLargeTextureHeight: 0,
            totalGpuBytes: textureBytes + bufferBytes,
            renderTargetSwitches: 0,
            estimatedGpuTimeAvailable: false,
        };
    }

    function formatCompactNumber(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return '0';
        if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(number >= 10000000 ? 0 : 1) + 'M';
        if (Math.abs(number) >= 1000) return (number / 1000).toFixed(number >= 10000 ? 0 : 1) + 'K';
        return String(Math.round(number));
    }

    function formatOverviewRatio(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return '0.00';
        return number.toFixed(2);
    }

    function formatOverviewPercent(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return '0%';
        return (number * 100).toFixed(number >= 0.1 ? 0 : 1) + '%';
    }

    function makeGraphFocusKey(kind, stats, title) {
        return [kind || 'pass', stats?.minEid ?? 'na', stats?.maxEid ?? 'na', title || 'untitled'].join('|');
    }

    function formatDurationUs(durationUs) {
        const value = Number(durationUs || 0);
        if (!Number.isFinite(value) || value <= 0) return '0 us';
        if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + ' ms';
        return value.toFixed(0) + ' us';
    }

    function collectNodeGpuTimeUs(node) {
        if (!node) return 0;
        let total = Number(state.timings[String(node.eventId)] || 0);
        (node.children || []).forEach((child) => {
            total += collectNodeGpuTimeUs(child);
        });
        return total;
    }

    function buildGraphPassCandidates() {
        const rootNodes = Array.isArray(state.drawCalls) ? state.drawCalls : [];
        const totalEventCount = flattenEvents(rootNodes).length;
        const candidates = [];
        const hasTimingData = state.timingsAvailable && Object.keys(state.timings || {}).length > 0;

        function visit(nodes, depth) {
            (nodes || []).forEach((node) => {
                if (!node) return;
                const hasChildren = !!(node.children && node.children.length);
                const stats = collectNodeStats(node);
                const workload = stats.draws + stats.dispatches + stats.clears + stats.copies + stats.presents;
                const gpuTimeUs = collectNodeGpuTimeUs(node);
                const kind = inferFlowKind(node.name, node.flags, stats, hasChildren);
                const title = node.name || (hasChildren ? 'Unnamed pass' : 'Inline commands');
                const isWrapper = depth === 0 && rootNodes.length === 1 && stats.events >= Math.max(12, totalEventCount * 0.9);

                if (workload > 0 && !isWrapper) {
                    const score = stats.draws + stats.dispatches * 1.4 + stats.copies * 0.55 + stats.clears * 0.3 + stats.presents * 0.2;
                    const previewLeaf = gatherLeafPreview(node, 1)[0];
                    const hints = [];
                    if (kind === 'transparent' || kind === 'ui' || kind === 'postfx') hints.push('Overdraw-prone');
                    if (kind === 'shadow' || kind === 'postfx') hints.push('Bandwidth-heavy');
                    if (stats.dispatches > stats.draws) hints.push('Compute-heavy');
                    if (stats.copies > 0) hints.push('Transfer activity');
                    if (stats.clears > 1) hints.push('Frequent clears');

                    candidates.push({
                        key: makeGraphFocusKey(kind, stats, title),
                        title,
                        kind,
                        stats,
                        score,
                        gpuTimeUs,
                        depth,
                        summary: summarizeStats(stats),
                        hints,
                        representativeEid: previewLeaf?.eventId || node.eventId || stats.minEid,
                    });
                }

                if (hasChildren) visit(node.children, depth + 1);
            });
        }

        visit(rootNodes, 0);

        const deduped = [];
        const seen = new Set();
        candidates
            .sort((a, b) => {
                if (hasTimingData && (a.gpuTimeUs !== b.gpuTimeUs)) return b.gpuTimeUs - a.gpuTimeUs;
                return b.score - a.score || a.depth - b.depth || a.stats.minEid - b.stats.minEid;
            })
            .forEach((candidate) => {
                if (seen.has(candidate.key)) return;
                seen.add(candidate.key);
                deduped.push(candidate);
            });

        return { all: deduped, hasTimingData };
    }

    function clamp01(value) {
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(1, value));
    }

    function buildOverviewInsights(stats, hasNativeStats) {
        const insights = [];
        const totalGpuBytes = Math.max(1, Number(stats.totalGpuBytes || 0));
        const drawCount = Math.max(1, Number(stats.drawCount || 0));
        const workCount = Math.max(1, Number(stats.drawCount || 0) + Number(stats.dispatchCount || 0));
        const textureShare = Number(stats.textureBytes || 0) / totalGpuBytes;
        const renderTargetShare = Number(stats.renderTargetBytes || 0) / totalGpuBytes;
        const bufferShare = Number(stats.bufferBytes || 0) / totalGpuBytes;
        const largeTextureShare = Number(stats.textureBytes || 0) > 0 ? Number(stats.largeTextureBytes || 0) / Number(stats.textureBytes || 0) : 0;
        const apiSummary = stats.apiSummary || {};
        const outputSetsPerDraw = Number(apiSummary.outputSets || 0) / drawCount;
        const shaderSetsPerDraw = Number(apiSummary.shaderSets || 0) / drawCount;
        const resourceUpdatesPerWork = Number(apiSummary.resourceUpdates || 0) / workCount;
        const resourceSetsPerDraw = Number(apiSummary.resourceSets || 0) / drawCount;

        if (textureShare >= 0.58) {
            insights.push({
                tone: 'accent',
                title: 'Texture memory dominates the frame footprint',
                text: formatOverviewPercent(textureShare) + ' of tracked GPU residency is textures. Prioritise large atlases, streaming policy, and compression wins first.',
            });
        }
        if (renderTargetShare >= 0.3) {
            insights.push({
                tone: 'warn',
                title: 'Render target pressure is elevated',
                text: 'Render targets account for ' + formatOverviewPercent(renderTargetShare) + ' of tracked GPU bytes. This often correlates with bandwidth-heavy post FX or multi-pass accumulation.',
            });
        }
        if (bufferShare >= 0.45) {
            insights.push({
                tone: 'info',
                title: 'Buffer residency is unusually high',
                text: 'Buffers make up ' + formatOverviewPercent(bufferShare) + ' of tracked memory. Large geometry streams or upload-heavy workloads may be dominating this frame.',
            });
        }
        if (largeTextureShare >= 0.45) {
            insights.push({
                tone: 'warn',
                title: 'Large textures are carrying most texture cost',
                text: formatOverviewPercent(largeTextureShare) + ' of texture memory comes from textures above 32×32. Mip policy and render-target reuse are good places to check next.',
            });
        }
        if (outputSetsPerDraw >= 0.22) {
            insights.push({
                tone: 'warn',
                title: 'Output-state churn is high',
                text: 'Output bindings change about ' + formatOverviewRatio(outputSetsPerDraw) + ' times per draw. Frequent RT switches or pass fragmentation are likely hurting locality.',
            });
        }
        if (shaderSetsPerDraw >= 0.18) {
            insights.push({
                tone: 'info',
                title: 'Shader switching density is noticeable',
                text: 'Shader programs change about ' + formatOverviewRatio(shaderSetsPerDraw) + ' times per draw. Sorting by material/pipeline may reduce driver overhead.',
            });
        }
        if (resourceUpdatesPerWork >= 0.16) {
            insights.push({
                tone: 'warn',
                title: 'Resource updates are heavy for this frame',
                text: 'Updates occur at roughly ' + formatOverviewRatio(resourceUpdatesPerWork) + ' per draw/dispatch. Dynamic uploads or transient resource rebuilds may be inflating cost.',
            });
        }
        if (resourceSetsPerDraw >= 1.5) {
            insights.push({
                tone: 'info',
                title: 'Descriptor / binding churn is high',
                text: 'Resource bindings change ' + formatOverviewRatio(resourceSetsPerDraw) + ' times per draw on average. Binding tables may need consolidation.',
            });
        }
        if (Number(stats.dispatchCount || 0) > Number(stats.drawCount || 0)) {
            insights.push({
                tone: 'accent',
                title: 'This frame is compute-leaning',
                text: 'Dispatch calls exceed draw calls, so compute queues or post-processing kernels may be driving the dominant GPU cost.',
            });
        }
        if (!insights.length) {
            insights.push({
                tone: hasNativeStats ? 'info' : 'accent',
                title: hasNativeStats ? 'Frame balance looks relatively even' : 'Showing derived metrics until native stats are available',
                text: hasNativeStats
                    ? 'No single pressure source stands out from the current capture statistics. Use Pipeline and resource tabs for per-event investigation.'
                    : 'Counts and memory totals are inferred from the loaded replay data, so this view is directionally useful but not yet authoritative.',
            });
        }

        return insights.slice(0, 4);
    }

    function buildOverviewOverdrawRisk(stats) {
        const drawCount = Math.max(1, Number(stats.drawCount || 0));
        const apiSummary = stats.apiSummary || {};
        const flatEvents = flattenEvents(state.drawCalls);
        const drawEvents = flatEvents.filter((dc) => /drawcall/i.test(String(dc.flags || '')));
        const transparentLikeDraws = drawEvents.filter((dc) => {
            const text = ((dc.name || '') + ' ' + (dc.flags || '')).toLowerCase();
            return /transparent|translucent|alpha|particle|glass|ui|overlay|postfx|post fx|post-process|bloom|tonemap/.test(text);
        }).length;
        const transparentRatio = drawEvents.length ? transparentLikeDraws / drawEvents.length : 0;
        const blendDensity = clamp01(Number(apiSummary.blendSets || 0) / drawCount / 0.35);
        const rtPressure = clamp01(Number(stats.renderTargetBytes || 0) / Math.max(1, Number(stats.totalGpuBytes || 0)) / 0.35);
        const outputChurn = clamp01(Number(stats.renderTargetSwitches || 0) / drawCount / 0.2);
        const score = clamp01(transparentRatio * 0.4 + blendDensity * 0.25 + rtPressure * 0.2 + outputChurn * 0.15);

        let label = 'Low';
        let tone = 'info';
        let rationale = 'Opaque and stable render passes dominate the frame.';
        if (score >= 0.67) {
            label = 'High';
            tone = 'warn';
            rationale = 'Transparent/post FX style draws, blend churn, and RT pressure suggest elevated overdraw risk.';
        } else if (score >= 0.34) {
            label = 'Medium';
            tone = 'accent';
            rationale = 'Some blend-heavy or screen-space work is present, but it does not dominate the frame yet.';
        }

        return { score, label, tone, rationale, transparentRatio };
    }

    function buildOverviewPassBreakdown() {
        const graphPasses = buildGraphPassCandidates();
        const top = graphPasses.all.slice(0, 4);
        const totalMetric = graphPasses.hasTimingData
            ? top.reduce((sum, candidate) => sum + candidate.gpuTimeUs, 0)
            : top.reduce((sum, candidate) => sum + candidate.score, 0);
        return { top, totalMetric, hasTimingData: graphPasses.hasTimingData, allCandidates: graphPasses.all };
    }

    function findBestPassCandidateForResource(resource, passCandidates) {
        if (!resource || !Array.isArray(passCandidates) || !passCandidates.length) return null;
        const text = [resourceDisplayName(resource), resource.name, resource.format, resource.type]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        const keywords = text.match(/[a-z0-9_]{4,}/g) || [];
        const preferredKinds = [];
        if (/shadow|depth/.test(text)) preferredKinds.push('shadow', 'opaque');
        if (/bloom|tonemap|taa|fxaa|blur|post|ssao|ssr|dof|upscale/.test(text)) preferredKinds.push('postfx');
        if (/ui|hud|overlay|canvas|font/.test(text)) preferredKinds.push('ui');
        if (/alpha|transparent|particle|glass/.test(text)) preferredKinds.push('transparent');
        if (/swap|present|backbuffer/.test(text)) preferredKinds.push('present', 'postfx');
        if (resource.type === 'Buffer') preferredKinds.push('compute', 'opaque');
        if (!preferredKinds.length) preferredKinds.push('opaque', 'camera', 'transparent', 'postfx');

        let best = null;
        let bestScore = -Infinity;
        passCandidates.forEach((candidate, index) => {
            let score = candidate.gpuTimeUs > 0 ? candidate.gpuTimeUs / 1000 : candidate.score;
            const candidateText = (candidate.title || '').toLowerCase();
            const kindIdx = preferredKinds.indexOf(candidate.kind);
            if (kindIdx >= 0) score += (preferredKinds.length - kindIdx) * 250;
            keywords.forEach((keyword) => {
                if (candidateText.includes(keyword)) score += 45;
            });
            if (resource.type === 'Texture' && /render target|gbuffer|color|scene color|main color/.test(text) && (candidate.kind === 'postfx' || candidate.kind === 'opaque')) score += 120;
            if (resource.type === 'Texture' && /depth|shadow/.test(text) && candidate.kind === 'shadow') score += 160;
            if (resource.type === 'Buffer' && candidate.kind === 'compute') score += 80;
            score -= index * 2;
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        });
        return best;
    }

    function buildOverviewResourceHotspots(passCandidates) {
        const topTextures = state.resources
            .filter((resource) => resource.type === 'Texture')
            .sort((left, right) => Number(right.byteSize || 0) - Number(left.byteSize || 0))
            .slice(0, 4)
            .map((resource) => ({
                resource,
                hint: resource.isColorTarget || resource.isDepthTarget ? 'Render target candidate' : 'Texture residency',
                passCandidate: findBestPassCandidateForResource(resource, passCandidates),
            }));
        const topBuffers = state.resources
            .filter((resource) => resource.type === 'Buffer')
            .sort((left, right) => Number(right.byteSize || 0) - Number(left.byteSize || 0))
            .slice(0, 3)
            .map((resource) => ({ resource, hint: 'Buffer residency', passCandidate: findBestPassCandidateForResource(resource, passCandidates) }));
        return { topTextures, topBuffers };
    }

    function renderOverviewPassCard(candidate, totalMetric, hasTimingData) {
        const primaryValue = hasTimingData && candidate.gpuTimeUs > 0
            ? (candidate.gpuTimeUs >= 1000 ? (candidate.gpuTimeUs / 1000).toFixed(2) + ' ms' : candidate.gpuTimeUs.toFixed(0) + ' us')
            : candidate.summary;
        const share = totalMetric > 0 ? (hasTimingData ? candidate.gpuTimeUs / totalMetric : candidate.score / totalMetric) : 0;
        const tone = candidate.kind === 'transparent' || candidate.kind === 'postfx' || candidate.kind === 'ui'
            ? 'warn'
            : candidate.kind === 'compute' || candidate.kind === 'camera'
                ? 'accent'
                : 'info';
        const badges = [
            renderGraphBadge(kindLabel(candidate.kind), candidate.kind),
            renderGraphBadge('EID ' + formatEidRange(candidate.stats.minEid, candidate.stats.maxEid), 'mono'),
        ];
        if (candidate.stats.draws) badges.push(renderGraphBadge(candidate.stats.draws + ' draws', 'mono'));
        if (candidate.stats.dispatches) badges.push(renderGraphBadge(candidate.stats.dispatches + ' dispatches', 'mono'));

        let html = '<article class="ov-pass-card ' + tone + '" data-eid="' + esc(String(candidate.representativeEid || candidate.stats.minEid)) + '" data-focus-key="' + esc(candidate.key) + '">';
        html += '<div class="ov-pass-head">';
        html += '<div class="ov-pass-title">' + esc(candidate.title) + '</div>';
        html += '<div class="ov-pass-meta">' + esc(primaryValue) + '</div>';
        html += '</div>';
        html += '<div class="ov-pass-badges">' + badges.join('') + '</div>';
        html += '<div class="ov-bars ov-pass-bars">';
        html += renderOverviewBar(hasTimingData ? 'GPU Time Share' : 'Workload Share', hasTimingData ? candidate.gpuTimeUs : candidate.score, Math.max(totalMetric, hasTimingData ? candidate.gpuTimeUs : candidate.score, 1), formatOverviewPercent(share), tone);
        html += '</div>';
        html += '<div class="ov-pass-hints">';
        if (candidate.hints.length) {
            html += candidate.hints.map((hint) => renderGraphTextChip(hint, tone)).join('');
        } else {
            html += renderGraphTextChip('Stable pass signature', 'mono');
        }
        html += '</div>';
        html += '</article>';
        return html;
    }

    function renderOverviewResourceCard(entry, tone) {
        const resource = entry.resource;
        let html = '<article class="ov-resource-card ' + tone + '" data-resid="' + esc(String(resource.resourceId)) + '"';
        if (entry.passCandidate?.key) html += ' data-focus-key="' + esc(entry.passCandidate.key) + '"';
        if (entry.passCandidate?.representativeEid) html += ' data-eid="' + esc(String(entry.passCandidate.representativeEid)) + '"';
        html += '>';
        html += '<div class="ov-resource-type">' + esc(resource.type || 'Resource') + '</div>';
        html += '<div class="ov-resource-title">' + esc(resourceDisplayName(resource) || resource.name || ('Resource ' + resource.resourceId)) + '</div>';
        html += '<div class="ov-resource-meta">' + esc(formatByteSize(resource.byteSize)) + ' · ' + esc(resource.format || 'Unknown format') + '</div>';
        if (resource.width || resource.height) {
            html += '<div class="ov-resource-submeta">' + esc(formatResourceExtent(resource)) + ' · ' + esc(entry.hint || '') + '</div>';
        } else {
            html += '<div class="ov-resource-submeta">' + esc(entry.hint || '') + '</div>';
        }
        if (entry.passCandidate) {
            html += '<div class="ov-resource-pass">Likely pass · ' + esc(entry.passCandidate.title) + '</div>';
        }
        html += '</article>';
        return html;
    }

    function renderOverviewMetricCard(label, value, meta, tone) {
        return '<article class="ov-metric-card' + (tone ? ' ' + tone : '') + '">' +
            '<div class="ov-metric-label">' + esc(label) + '</div>' +
            '<div class="ov-metric-value">' + esc(value) + '</div>' +
            '<div class="ov-metric-meta">' + esc(meta || '') + '</div>' +
            '</article>';
    }

    function renderOverviewMiniMetric(label, value, meta) {
        return '<article class="ov-mini-card">' +
            '<div class="ov-mini-label">' + esc(label) + '</div>' +
            '<div class="ov-mini-value">' + esc(value) + '</div>' +
            '<div class="ov-mini-meta">' + esc(meta || '') + '</div>' +
            '</article>';
    }

    function renderOverviewSection(title, subtitle, body, extraClass) {
        let html = '<section class="ov-section' + (extraClass ? ' ' + extraClass : '') + '">';
        html += '<div class="ov-section-head">';
        html += '<div class="ov-section-title">' + esc(title) + '</div>';
        if (subtitle) html += '<div class="ov-section-subtitle">' + esc(subtitle) + '</div>';
        html += '</div>';
        html += '<div class="ov-section-body">' + body + '</div>';
        html += '</section>';
        return html;
    }

    function renderOverviewBar(label, value, total, meta, tone) {
        const safeValue = Number(value || 0);
        const safeTotal = Math.max(Number(total || 0), safeValue, 1);
        const ratio = clamp01(safeValue / safeTotal);
        return '<div class="ov-bar-row">' +
            '<div class="ov-bar-labels"><span>' + esc(label) + '</span><span>' + esc(meta || '') + '</span></div>' +
            '<div class="ov-bar-track"><div class="ov-bar-fill' + (tone ? ' ' + tone : '') + '" style="width:' + (ratio * 100).toFixed(1) + '%"></div></div>' +
            '</div>';
    }

    function renderOverview() {
        const body = document.getElementById('overview-body');
        if (!state.captureInfo) { body.textContent = 'Load a capture to begin.'; body.className = 'empty-state'; return; }
        body.className = '';
        const info = state.captureInfo;
        const stats = info.statistics || buildDerivedOverviewStatistics();
        const hasNativeStats = !!info.statistics;
        const fileName = info.filePath.split(/[/\\]/).pop() || info.filePath;
        const eventCount = flattenEvents(state.drawCalls).length;
        const texCount = state.resources.filter(r => r.type === 'Texture').length;
        const bufCount = state.resources.filter(r => r.type === 'Buffer').length;
        const shdCount = state.resources.filter(r => r.type === 'Shader').length;
        const bandwidthWorkingSet = Number(stats.textureBytes || 0) + Number(stats.renderTargetBytes || 0);
        const totalGpuBytes = Math.max(0, Number(stats.totalGpuBytes || 0));
        const textureShare = totalGpuBytes > 0 ? Number(stats.textureBytes || 0) / totalGpuBytes : 0;
        const rtShare = totalGpuBytes > 0 ? Number(stats.renderTargetBytes || 0) / totalGpuBytes : 0;
        const bufferShare = totalGpuBytes > 0 ? Number(stats.bufferBytes || 0) / totalGpuBytes : 0;
        const apiSummary = stats.apiSummary || {};
        const stateChangeTotal = Number(apiSummary.shaderSets || 0) + Number(apiSummary.blendSets || 0) + Number(apiSummary.depthStencilSets || 0) + Number(apiSummary.rasterizationSets || 0) + Number(apiSummary.outputSets || 0);
        const findings = buildOverviewInsights(stats, hasNativeStats);
        const overdrawRisk = buildOverviewOverdrawRisk(stats);
        const passBreakdown = buildOverviewPassBreakdown();
        const resourceHotspots = buildOverviewResourceHotspots(passBreakdown.allCandidates);
        const estimatedGpuTimeText = stats.estimatedGpuTimeAvailable && stats.estimatedGpuTimeUs != null
            ? (stats.estimatedGpuTimeUs >= 1000 ? (stats.estimatedGpuTimeUs / 1000).toFixed(2) + ' ms' : stats.estimatedGpuTimeUs.toFixed(0) + ' us')
            : 'Unavailable';

        let frameSummary = 'Balanced frame composition with no dominant pressure source.';
        if (textureShare >= 0.58) frameSummary = 'Texture residency is the dominant pressure source in this frame.';
        else if (rtShare >= 0.3) frameSummary = 'Render-target footprint suggests a bandwidth-heavy multi-pass frame.';
        else if (Number(stats.dispatchCount || 0) > Number(stats.drawCount || 0)) frameSummary = 'Compute dispatch work is heavier than graphics draw submission in this frame.';
        else if (stateChangeTotal > Math.max(1, Number(stats.drawCount || 0)) * 0.75) frameSummary = 'Driver-facing state churn is elevated relative to the draw count.';

        let html = '<div class="overview-shell">';
        html += '<section class="ov-hero">';
        html += '<div class="ov-hero-main">';
        html += '<div class="ov-eyebrow">Frame Performance Overview</div>';
        html += '<h2 class="ov-title">' + esc(fileName) + '</h2>';
        html += '<p class="ov-summary">' + esc(frameSummary) + '</p>';
        html += '<div class="ov-badges">';
        for (const badge of [
            info.api ? ('API · ' + info.api) : '',
            info.driver ? ('Driver · ' + info.driver) : '',
            'Stats · ' + (hasNativeStats ? 'Native' : 'Derived'),
            info.frameCount != null ? ('Frames · ' + info.frameCount) : '',
            info.sectionCount != null ? ('Sections · ' + info.sectionCount) : '',
        ]) {
            if (!badge) continue;
            html += '<span class="ov-badge">' + esc(badge) + '</span>';
        }
        html += '</div>';
        html += '</div>';
        html += '<div class="ov-hero-side">';
        html += renderOverviewMiniMetric('Events', formatCompactNumber(eventCount), 'Replay event graph size');
        html += renderOverviewMiniMetric('Textures', formatCompactNumber(texCount), 'Tracked texture resources');
        html += renderOverviewMiniMetric('Buffers', formatCompactNumber(bufCount), 'Tracked buffer resources');
        html += renderOverviewMiniMetric('Shaders', formatCompactNumber(shdCount), 'Shader resource count');
        html += '</div>';
        html += '</section>';

        html += '<div class="ov-metric-grid">';
        html += renderOverviewMetricCard('Draw Calls', formatCompactNumber(stats.drawCount), 'Graphics submissions in frame', 'accent');
        html += renderOverviewMetricCard('API Calls', formatCompactNumber(stats.apiCallCount), 'Driver-facing call volume', 'accent');
        html += renderOverviewMetricCard('Dispatch Calls', formatCompactNumber(stats.dispatchCount), 'Compute submissions in frame', 'info');
        html += renderOverviewMetricCard('Estimated GPU Time', estimatedGpuTimeText, stats.estimatedGpuTimeAvailable ? 'Summed workload event durations' : 'EventGPUDuration counter unavailable', stats.estimatedGpuTimeAvailable ? 'accent' : 'info');
        html += renderOverviewMetricCard('GPU Footprint', formatByteSize(stats.totalGpuBytes), 'Tracked texture + buffer residency', 'accent');
        html += renderOverviewMetricCard('Bandwidth Working Set', formatByteSize(bandwidthWorkingSet), 'Texture + RT residency proxy', 'warn');
        html += renderOverviewMetricCard('Render Target Memory', formatByteSize(stats.renderTargetBytes), formatCompactNumber(stats.renderTargetCount) + ' tracked RTs', 'warn');
        html += renderOverviewMetricCard('RT Switches', formatCompactNumber(stats.renderTargetSwitches), 'Coarse pass changes from action outputs', 'warn');
        html += renderOverviewMetricCard('Overdraw Risk', overdrawRisk.label, overdrawRisk.rationale, overdrawRisk.tone);
        html += '</div>';

        html += '<div class="ov-grid ov-grid-2">';
        html += renderOverviewSection(
            'Memory & Bandwidth',
            'Frame footprint split by major residency buckets. This is the fastest way to see what is likely stressing memory and bandwidth.',
            '<div class="ov-mini-grid">' +
                renderOverviewMiniMetric('Textures', formatByteSize(stats.textureBytes), formatCompactNumber(stats.textureCount) + ' resources') +
                renderOverviewMiniMetric('Large Textures', formatByteSize(stats.largeTextureBytes), formatOverviewPercent((stats.textureBytes || 0) > 0 ? (stats.largeTextureBytes || 0) / stats.textureBytes : 0) + ' of texture memory') +
                renderOverviewMiniMetric('Buffers', formatByteSize(stats.bufferBytes), formatCompactNumber(stats.bufferCount) + ' resources') +
                renderOverviewMiniMetric('Vertex Buffers', formatByteSize(stats.vertexBufferBytes), 'Geometry streaming footprint') +
                renderOverviewMiniMetric('Index Buffers', formatByteSize(stats.indexBufferBytes), 'Index topology footprint') +
                renderOverviewMiniMetric('Avg Texture Size', Math.round(stats.avgTextureWidth || 0) + ' × ' + Math.round(stats.avgTextureHeight || 0), hasNativeStats ? 'Tracked native average' : 'Derived from resource list') +
            '</div>' +
            '<div class="ov-bars">' +
                renderOverviewBar('Texture Share', stats.textureBytes, totalGpuBytes, formatOverviewPercent(textureShare), 'accent') +
                renderOverviewBar('Render Target Share', stats.renderTargetBytes, totalGpuBytes, formatOverviewPercent(rtShare), 'warn') +
                renderOverviewBar('Buffer Share', stats.bufferBytes, totalGpuBytes, formatOverviewPercent(bufferShare), 'info') +
            '</div>'
        );

        html += renderOverviewSection(
            'Execution Density',
            'Submission volume and driver churn indicators pulled from the capture statistics summary.',
            '<div class="ov-mini-grid">' +
                renderOverviewMiniMetric('API / Work Ratio', formatOverviewRatio(stats.apiDrawDispatchRatio), 'API calls per draw + dispatch') +
                renderOverviewMiniMetric('Shader Sets', formatCompactNumber(apiSummary.shaderSets || 0), 'Pipeline program changes') +
                renderOverviewMiniMetric('Output Sets', formatCompactNumber(apiSummary.outputSets || 0), 'Render target / OM changes') +
                renderOverviewMiniMetric('RT Switches', formatCompactNumber(stats.renderTargetSwitches), 'Transitions between output sets') +
                renderOverviewMiniMetric('Resource Updates', formatCompactNumber(apiSummary.resourceUpdates || 0), 'Upload / update activity') +
                renderOverviewMiniMetric('Sampler Sets', formatCompactNumber(apiSummary.samplerSets || 0), 'Sampler state changes') +
                renderOverviewMiniMetric('Resource Sets', formatCompactNumber(apiSummary.resourceSets || 0), 'Descriptor / resource bindings') +
                renderOverviewMiniMetric('Overdraw Signal', formatOverviewPercent(overdrawRisk.score), formatOverviewPercent(overdrawRisk.transparentRatio) + ' transparent-like draw ratio') +
            '</div>' +
            '<div class="ov-bars">' +
                renderOverviewBar('Shader Churn', apiSummary.shaderSets || 0, Math.max(1, stats.drawCount), formatOverviewRatio((apiSummary.shaderSets || 0) / Math.max(1, stats.drawCount)) + ' / draw', 'accent') +
                renderOverviewBar('Output Churn', apiSummary.outputSets || 0, Math.max(1, stats.drawCount), formatOverviewRatio((apiSummary.outputSets || 0) / Math.max(1, stats.drawCount)) + ' / draw', 'warn') +
                renderOverviewBar('RT Switch Density', stats.renderTargetSwitches || 0, Math.max(1, stats.drawCount), formatOverviewRatio((stats.renderTargetSwitches || 0) / Math.max(1, stats.drawCount)) + ' / draw', 'warn') +
                renderOverviewBar('Update Density', apiSummary.resourceUpdates || 0, Math.max(1, stats.drawCount + stats.dispatchCount), formatOverviewRatio((apiSummary.resourceUpdates || 0) / Math.max(1, stats.drawCount + stats.dispatchCount)) + ' / work item', 'info') +
            '</div>'
        );
        html += '</div>';

        html += renderOverviewSection(
            'Pass Hotspots',
            'Most workload-heavy marker groups inferred from the EventBrowser hierarchy. Use this to see which passes are most likely driving frame cost before drilling into Pipeline or Events.',
            passBreakdown.top.length
                ? '<div class="ov-pass-grid">' + passBreakdown.top.map((candidate) => renderOverviewPassCard(candidate, passBreakdown.totalMetric, passBreakdown.hasTimingData)).join('') + '</div>'
                : '<div class="pipe-empty">No pass groups with meaningful workload were detected in the current event tree.</div>'
        );

        html += '<div class="ov-grid ov-grid-2">';
        html += renderOverviewSection(
            'Resource Hotspots',
            'Largest tracked textures and buffers in the current capture. These are good first candidates when memory or bandwidth pressure is high.',
            '<div class="ov-resource-grid">' +
                resourceHotspots.topTextures.map((entry) => renderOverviewResourceCard(entry, 'warn')).join('') +
                resourceHotspots.topBuffers.map((entry) => renderOverviewResourceCard(entry, 'info')).join('') +
            '</div>'
        );
        html += renderOverviewSection(
            'Capture Context',
            'Replay, capture, and storage metadata for this frame. Useful for correlating footprint changes with the actual capture artifact size.',
            '<div class="ov-kv-grid">' +
                '<div class="k">File</div><div class="v">' + esc(info.filePath) + '</div>' +
                (info.timestamp ? '<div class="k">Timestamp</div><div class="v">' + esc(String(info.timestamp)) + '</div>' : '') +
                (info.machineIdent ? '<div class="k">Machine ID</div><div class="v">' + esc(String(info.machineIdent)) + '</div>' : '') +
                (info.rdocVersion ? '<div class="k">RenderDoc</div><div class="v">' + esc(String(info.rdocVersion)) + '</div>' : '') +
                '<div class="k">Compressed</div><div class="v">' + esc(formatByteSize(stats.compressedFileSize)) + '</div>' +
                '<div class="k">Uncompressed</div><div class="v">' + esc(formatByteSize(stats.uncompressedFileSize)) + '</div>' +
                '<div class="k">Persistent Data</div><div class="v">' + esc(formatByteSize(stats.persistentSize)) + '</div>' +
                '<div class="k">Init Data</div><div class="v">' + esc(formatByteSize(stats.initDataSize)) + '</div>' +
            '</div>'
        );

        html += renderOverviewSection(
            'Auto Findings',
            'Short conclusions inferred from the current frame statistics. These are heuristic summaries intended to speed up triage, not replace detailed profiling.',
            '<div class="ov-findings">' + findings.map((finding) =>
                '<article class="ov-finding ' + esc(finding.tone) + '">' +
                    '<div class="ov-finding-title">' + esc(finding.title) + '</div>' +
                    '<div class="ov-finding-text">' + esc(finding.text) + '</div>' +
                '</article>'
            ).join('') + '</div>'
        );
        html += '</div>';
        html += '</div>';
        body.innerHTML = html;
        body.querySelectorAll('.ov-pass-card[data-eid]').forEach((el) => {
            el.addEventListener('click', () => {
                const eventId = parseInt(el.dataset.eid || '', 10);
                if (!Number.isNaN(eventId) && eventId > 0) {
                    state.graphFocus = { key: el.dataset.focusKey || null, eventId };
                    switchTab('pipelinegraph');
                }
            });
        });
        body.querySelectorAll('.ov-resource-card[data-resid]').forEach((el) => {
            el.addEventListener('click', () => {
                const eventId = parseInt(el.dataset.eid || '', 10);
                if (!Number.isNaN(eventId) && eventId > 0 && el.dataset.focusKey) {
                    state.graphFocus = { key: el.dataset.focusKey, eventId };
                    switchTab('pipelinegraph');
                    return;
                }
                activateResourceById(el.dataset.resid);
            });
        });
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
    function getPipelineStageOptions(pipeline) {
        const shaders = (pipeline && pipeline.shaders) || {};
        const stageResources = (pipeline && pipeline.stageResources) || {};
        const options = [];

        GFX_PIPELINE.forEach((stage) => {
            if (stage.kind !== 'Shader') return;
            const shaderMatch = resolveShader(shaders, stage.id, stage.aliases);
            const resourceMatch = resolveShader(stageResources, stage.id, stage.aliases);
            if (!shaderMatch && !resourceMatch) return;
            options.push({
                id: stage.id,
                label: stage.label,
                key: (resourceMatch || shaderMatch).key,
                shader: shaderMatch ? shaderMatch.info : null,
                resources: resourceMatch ? resourceMatch.info : { textures: [], samplers: [], constantBlocks: [] },
            });
        });

        const computeShader = resolveShader(shaders, 'compute', []);
        const computeResources = resolveShader(stageResources, 'compute', []);
        if (computeShader || computeResources) {
            options.push({
                id: 'compute',
                label: 'Compute Shader',
                key: (computeResources || computeShader).key,
                shader: computeShader ? computeShader.info : null,
                resources: computeResources ? computeResources.info : { textures: [], samplers: [], constantBlocks: [] },
            });
        }

        return options;
    }
    function syncActivePipelineStage(pipeline) {
        const options = getPipelineStageOptions(pipeline);
        if (state.pipelineConstantBuffer && !options.some((option) => option.key === state.pipelineConstantBuffer.stage)) {
            state.pipelineConstantBuffer = null;
            state.pipelineConstantBufferBusyKey = null;
        }
        if (!options.length) {
            state.activePipelineStage = null;
            return { options, active: null };
        }
        let active = options.find((option) => option.key === state.activePipelineStage) || null;
        if (!active) {
            active = options[0];
            state.activePipelineStage = active.key;
        }
        return { options, active };
    }
    function pipelineConstantBufferRequestKey(stage, cbufferIndex, arrayElement) {
        return [String(stage || ''), String(cbufferIndex), String(arrayElement || 0)].join(':');
    }
    function requestPipelineConstantBuffer(stage, cbufferIndex, arrayElement) {
        if (state.eventId == null) return;
        const requestKey = pipelineConstantBufferRequestKey(stage, cbufferIndex, arrayElement);
        state.pipelineConstantBufferBusyKey = requestKey;
        state.pipelineConstantBuffer = {
            stage,
            cbufferIndex,
            arrayElement: arrayElement || 0,
            loading: true,
        };
        renderPipeline();
        vscode.postMessage({
            type: 'requestPipelineConstantBuffer',
            eventId: state.eventId,
            stage,
            cbufferIndex,
            arrayElement: arrayElement || 0,
        });
    }
    function pipelineBindingLabel(binding, prefix) {
        const slot = binding && binding.slot != null ? binding.slot : null;
        const bindingIndex = binding && binding.bindingIndex != null ? binding.bindingIndex : null;
        const baseIndex = slot != null ? slot : (bindingIndex != null ? bindingIndex : '?');
        let label = prefix + baseIndex;
        if ((binding && binding.bindArraySize > 1) || (binding && binding.arrayElement)) {
            label += '[' + (binding.arrayElement || 0) + ']';
        }
        const extras = [];
        if (binding && binding.space) {
            extras.push('space ' + binding.space);
        }
        if (bindingIndex != null && bindingIndex !== slot) {
            extras.push('idx ' + bindingIndex);
        }
        return extras.length ? label + ' · ' + extras.join(' · ') : label;
    }
    function renderPipelineStageTabs(options, activeKey) {
        return '<div class="stage-tabs pipe-stage-tabs">' + options.map((option) =>
            '<button type="button" class="stage-tab' + (option.key === activeKey ? ' active' : '') + '" data-pipeline-stage="' + esc(option.key) + '">' + esc(option.label) + '</button>'
        ).join('') + '</div>';
    }
    function renderPipelineStageSummary(activeStage) {
        const resources = activeStage && activeStage.resources ? activeStage.resources : {};
        const textures = Array.isArray(resources.textures) ? resources.textures : [];
        const samplers = Array.isArray(resources.samplers) ? resources.samplers : [];
        const constantBlocks = Array.isArray(resources.constantBlocks) ? resources.constantBlocks : [];
        let html = '<div class="stat-row">';
        html += stat(textures.length, 'Textures');
        html += stat(samplers.length, 'Samplers');
        html += stat(constantBlocks.length, 'Uniform Blocks');
        html += '</div>';
        return html;
    }
    function renderPipelineResourceName(entry, fallbackLabel) {
        const meta = [];
        if (entry && entry.kind) meta.push(entry.kind);
        if (entry && entry.compileConstants) meta.push('Compile-time');
        else if (entry && entry.inlineDataBytes) meta.push('Inline');
        else if (entry && entry.bufferBacked === false) meta.push('Direct');
        if (entry && entry.staticallyUnused) meta.push('Unused');
        let html = '<div>' + esc((entry && entry.name) || fallbackLabel || 'Unnamed') + '</div>';
        if (meta.length) {
            html += '<div class="pipe-muted">' + esc(meta.join(' · ')) + '</div>';
        }
        return html;
    }
    function renderPipelineResourceBinding(entry, resourceIdField, resourceNameField, emptyLabel) {
        const resourceId = entry && entry[resourceIdField];
        if (!resourceId) {
            return '<span class="pipe-muted">' + esc(emptyLabel || 'Unbound') + '</span>';
        }
        let html = renderResourceChip(resourceId, (entry && entry[resourceNameField]) || resName(resourceId));
        const offset = entry && (entry.byteOffset != null ? entry.byteOffset : 0);
        const size = entry && (entry.boundByteSize != null ? entry.boundByteSize : entry.byteSize);
        const meta = [];
        if (offset) meta.push(offset + ' B offset');
        if (size) meta.push(formatByteSize(size));
        if (meta.length) {
            html += '<div class="pipe-muted">' + esc(meta.join(' · ')) + '</div>';
        }
        return html;
    }
    function renderStageTexturesSection(resources) {
        const textures = Array.isArray(resources && resources.textures) ? resources.textures : [];
        const rows = textures.map((entry, idx) => [
            esc(pipelineBindingLabel(entry, 't')),
            renderPipelineResourceName(entry, 'Texture ' + idx),
            renderPipelineResourceBinding(entry, 'resourceId', 'resourceName', 'Unbound'),
        ]);
        return renderPipelineTable(['Binding', 'Resource', 'Bound View'], rows);
    }
    function renderStageSamplersSection(resources) {
        const samplers = Array.isArray(resources && resources.samplers) ? resources.samplers : [];
        const rows = samplers.map((entry, idx) => {
            const filter = [entry.minFilter, entry.magFilter, entry.mipFilter].filter(Boolean).join(' / ');
            const address = [entry.addressU, entry.addressV, entry.addressW].filter(Boolean).join(' / ');
            return [
                esc(pipelineBindingLabel(entry, 's')),
                renderPipelineResourceName(entry, 'Sampler ' + idx),
                esc(filter || '—'),
                esc(address || '—'),
                entry.compareEnable ? esc(entry.compareFunc || 'Enabled') : '<span class="pipe-muted">Disabled</span>',
            ];
        });
        return renderPipelineTable(['Binding', 'Sampler', 'Filter', 'Address', 'Compare'], rows);
    }
    function renderPipelineConstantBufferBacking(entry) {
        if (entry && entry.bufferResourceId) {
            return renderPipelineResourceBinding(entry, 'bufferResourceId', 'bufferResourceName', 'Unbound');
        }
        if (entry && entry.compileConstants) {
            return '<span class="pipe-muted">Compile-time constants</span>';
        }
        if (entry && entry.inlineDataBytes) {
            return '<span class="pipe-muted">Inline data bytes</span>';
        }
        if (entry && entry.bufferBacked === false) {
            return '<span class="pipe-muted">Direct uniforms</span>';
        }
        return '<span class="pipe-muted">Unbound</span>';
    }
    function renderStageConstantBlocksSection(stageKey, resources) {
        const constantBlocks = Array.isArray(resources && resources.constantBlocks) ? resources.constantBlocks : [];
        const rows = constantBlocks.map((entry, idx) => {
            const arrayElement = entry && entry.arrayElement != null ? entry.arrayElement : 0;
            const requestKey = pipelineConstantBufferRequestKey(stageKey, entry.cbufferIndex, arrayElement);
            const loading = state.pipelineConstantBufferBusyKey === requestKey;
            const activeDetails = state.pipelineConstantBuffer && !state.pipelineConstantBuffer.error &&
                state.pipelineConstantBuffer.stage === stageKey &&
                Number(state.pipelineConstantBuffer.cbufferIndex) === Number(entry.cbufferIndex) &&
                Number(state.pipelineConstantBuffer.arrayElement || 0) === Number(arrayElement);
            return [
                esc(pipelineBindingLabel(entry, 'b')),
                renderPipelineResourceName(entry, 'Block ' + idx),
                renderPipelineConstantBufferBacking(entry),
                esc(formatByteSize((entry && (entry.boundByteSize || entry.byteSize)) || 0)),
                '<button type="button" class="pipe-inline-action' + (activeDetails ? ' active' : '') + '" data-pipeline-cbuffer-stage="' + esc(stageKey) + '" data-pipeline-cbuffer-index="' + esc(String(entry.cbufferIndex)) + '" data-pipeline-cbuffer-array="' + esc(String(arrayElement)) + '"' + (loading ? ' disabled' : '') + '>' + esc(loading ? 'Loading…' : (activeDetails ? 'Refresh' : 'Inspect')) + '</button>',
            ];
        });
        return renderPipelineTable(['Binding', 'Block', 'Backing', 'Size', 'View'], rows);
    }
    function formatPipelineVariableRow(row) {
        if (!Array.isArray(row)) return row == null ? '—' : String(row);
        return row.map((cell) => String(cell)).join(', ');
    }
    function flattenPipelineVariables(variables, depth, rows) {
        (variables || []).forEach((variable, index) => {
            const members = Array.isArray(variable && variable.members) ? variable.members : [];
            const displayRows = Array.isArray(variable && variable.displayRows) ? variable.displayRows : [];
            const indent = '&nbsp;'.repeat(depth * 4);
            let valueCell = '<span class="pipe-muted">—</span>';
            if (!members.length) {
                if (displayRows.length <= 1) {
                    valueCell = esc(displayRows.length ? formatPipelineVariableRow(displayRows[0]) : '—');
                } else {
                    valueCell = '<span class="pipe-muted">' + esc(displayRows.length + ' rows') + '</span>';
                }
            }
            rows.push([
                indent + esc((variable && variable.name) || ('var ' + index)),
                esc((variable && (variable.type || variable.baseType)) || '—'),
                valueCell,
            ]);
            if (members.length) {
                flattenPipelineVariables(members, depth + 1, rows);
            } else if (displayRows.length > 1) {
                displayRows.forEach((row, rowIndex) => {
                    rows.push([
                        '&nbsp;'.repeat((depth + 1) * 4) + esc('[' + rowIndex + ']'),
                        '<span class="pipe-muted">row</span>',
                        esc(formatPipelineVariableRow(row)),
                    ]);
                });
            }
        });
        return rows;
    }
    function renderPipelineConstantBufferDetails(activeStageKey) {
        const details = state.pipelineConstantBuffer;
        if (!details || details.stage !== activeStageKey) return '';
        if (details.loading) {
            return '<div class="pipe-empty">Loading buffer details…</div>';
        }
        if (details.error) {
            return '<div class="pipe-empty">Buffer details unavailable: ' + esc(details.error) + '</div>';
        }

        const variables = Array.isArray(details.variables) ? details.variables : [];
        const flattened = flattenPipelineVariables(variables, 0, []);
        const meta = renderPipelineKvGrid([
            ['Block', formatPipelineValue(details.name)],
            ['Binding', formatPipelineValue(pipelineBindingLabel(details, 'b'))],
            ['Entry Point', formatPipelineValue(details.entryPoint)],
            ['Backing', renderPipelineConstantBufferBacking(details)],
            ['Declared Size', formatPipelineValue(formatByteSize(details.byteSize || 0))],
            ['Resolved Size', formatPipelineValue(details.boundByteSize ? formatByteSize(details.boundByteSize) : undefined)],
        ]);

        if (!flattened.length) {
            return meta + '<div class="pipe-empty">No decoded variables were reported for this buffer.</div>';
        }

        return meta + renderPipelineTable(['Variable', 'Type', 'Value'], flattened);
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
        const rasterizer = p.rasterizer || {};
        const depthStencil = p.depthStencil || {};
        const blendState = p.blendState || {};
        const blendTargets = Array.isArray(blendState.targets) ? blendState.targets : [];
        const samplers = Array.isArray(p.samplers) ? p.samplers : [];
        const boundTextures = Array.isArray(p.boundTextures) ? p.boundTextures : [];
        const resMap = resById();
        const stageState = syncActivePipelineStage(p);

        let html = '<div class="info-grid">';
        html += '<div class="k">API</div><div class="v">' + esc(p.api || '?') + '</div>';
        html += '<div class="k">Event</div><div class="v">' + state.eventId + '</div>';
        if (state.drawCall) html += '<div class="k">Draw</div><div class="v">' + esc(state.drawCall.name) + '</div>';
        html += '</div>';

        html += '<div class="stat-row">';
        html += stat(stageState.options.length || Object.keys(shaders).length, 'Bound Stages');
        html += stat((fb.colorTargets || []).length, 'Color Targets');
        html += stat((vi.vertexBuffers || []).length, 'Vertex Buffers');
        html += stat(boundTextures.length, 'Bound Textures');
        html += stat(samplers.length, 'Samplers');
        html += '</div>';

        const diagnostics = buildPipelineDiagnostics(p, vi, fb, shaders, boundTextures, samplers);
        if (diagnostics.length) {
            html += renderPipelineCard(
                'State Diagnostics',
                'Quick heuristics to highlight suspicious or noteworthy fixed-function state at this event.',
                '<div class="pipe-diagnostic-list">' + diagnostics.map((diag) =>
                    '<div class="pipe-diagnostic ' + diag.kind + '"><div class="pipe-diagnostic-title">' + esc(diag.title) + '</div><div class="pipe-diagnostic-text">' + esc(diag.text) + '</div></div>'
                ).join('') + '</div>',
                'pipe-card-compact'
            );
        }

        html += renderPipelineCard(
            'Graphics Pipeline',
            'Bound programmable stages and fixed-function flow at the selected event.',
            (() => {
                let flowHtml = '<div class="pipe-flow">';
                GFX_PIPELINE.forEach((stage, idx) => {
                    if (idx > 0) flowHtml += '<span class="pipe-arrow">▼</span>';
                    flowHtml += renderPipelineStage(stage, shaders, fb, vi, stageState.active ? stageState.active.key : null);
                });
                flowHtml += '</div>';
                return flowHtml;
            })(),
            'pipe-card-flow'
        );

        const cs = resolveShader(shaders, 'compute', []);
        if (cs) {
            html += renderPipelineCard(
                'Compute Pipeline',
                'Standalone compute state when the selected event uses a compute shader.',
                '<div class="pipe-flow">' + renderPipelineStage({ id: 'compute', kind: 'Shader', label: 'Compute Shader' }, shaders, fb, vi, stageState.active ? stageState.active.key : null) + '</div>',
                'pipe-card-flow'
            );
        }

        if (stageState.active) {
            html += renderPipelineCard(
                'Stage Resources',
                'RenderDoc-style per-stage textures, samplers, and uniform buffers for the selected shader stage.',
                renderPipelineStageTabs(stageState.options, stageState.active.key) + renderPipelineStageSummary(stageState.active),
                'pipe-card-compact'
            );

            html += '<div class="pipe-grid pipe-grid-3">';
            html += renderPipelineCard(
                'Textures',
                'Shader-visible textures and read-only buffers for the selected stage.',
                renderStageTexturesSection(stageState.active.resources),
                'pipe-card-compact'
            );
            html += renderPipelineCard(
                'Samplers',
                'Sampler bindings and resolved filter/address state for the selected stage.',
                renderStageSamplersSection(stageState.active.resources),
                'pipe-card-compact'
            );
            html += renderPipelineCard(
                'Uniforms and Buffers',
                'Constant blocks, direct uniforms, and specialization constants for the selected stage.',
                renderStageConstantBlocksSection(stageState.active.key, stageState.active.resources),
                'pipe-card-compact'
            );
            html += '</div>';

            const detailsHtml = renderPipelineConstantBufferDetails(stageState.active.key);
            if (detailsHtml) {
                html += renderPipelineCard(
                    'Buffer Details',
                    'Expanded variable values for the selected constant/uniform block.',
                    detailsHtml
                );
            }
        }

        const colorRTs = fb.colorTargets || [];
        const vbs = vi.vertexBuffers || [];

        const fixedStateCards = [];
        fixedStateCards.push(renderPipelineCard('Rasterizer State', 'Cull/fill/depth-bias setup for the current draw.', renderPipelineKvGrid([
            ['Fill Mode', formatPipelineValue(rasterizer.fillMode)],
            ['Cull Mode', formatPipelineValue(rasterizer.cullMode)],
            ['Front CCW', formatPipelineBool(rasterizer.frontCCW)],
            ['Depth Bias', formatPipelineValue(rasterizer.depthBias)],
            ['Slope Bias', formatPipelineValue(rasterizer.slopeScaledDepthBias)],
            ['Depth Clamp', formatPipelineValue(rasterizer.depthClampEnable ?? rasterizer.depthClamp)],
            ['Depth Clip', formatPipelineValue(rasterizer.depthClipEnable ?? rasterizer.depthClip)],
            ['Scissor', formatPipelineBool(rasterizer.scissorEnable)],
            ['MSAA', formatPipelineBool(rasterizer.multisampleEnable)],
            ['Raster Discard', formatPipelineBool(rasterizer.rasterizerDiscard)],
            ['Line Width', formatPipelineValue(rasterizer.lineWidth)],
            ['Point Size', formatPipelineValue(rasterizer.pointSize)],
        ]), 'pipe-card-compact'));

        fixedStateCards.push(renderPipelineCard('Depth / Stencil', 'Depth test, writes, and front/back stencil operations.', renderPipelineKvGrid([
            ['Depth Test', formatPipelineBool(depthStencil.depthEnable)],
            ['Depth Write', formatPipelineBool(depthStencil.depthWrites)],
            ['Depth Func', formatPipelineValue(depthStencil.depthFunc)],
            ['Stencil Test', formatPipelineBool(depthStencil.stencilEnable)],
            ['Front Face', formatStencilFace(depthStencil.frontFace)],
            ['Back Face', formatStencilFace(depthStencil.backFace)],
        ]), 'pipe-card-compact'));

        fixedStateCards.push(renderPipelineCard('Blend State', 'Blend factor and per-target color/alpha blend setup.', renderPipelineKvGrid([
            ['Alpha To Coverage', formatPipelineBool(blendState.alphaToCoverage)],
            ['Independent Blend', formatPipelineBool(blendState.independentBlend)],
            ['Blend Factor', formatPipelineArray(blendState.blendFactor)],
            ['Targets', formatPipelineValue(blendTargets.length)],
        ]) + renderBlendTargets(blendTargets), 'pipe-card-compact'));

        html += '<div class="pipe-grid pipe-grid-3">' + fixedStateCards.join('') + '</div>';

        if (colorRTs.length || fb.depthTarget || fb.stencilTarget) {
            html += renderPipelineCard(
                'Render Targets',
                'Current color, depth, and stencil attachments used by the output-merger/framebuffer stage.',
                renderRenderTargetSection(colorRTs, fb, resMap)
            );
        }

        if (vbs.length || vi.indexBuffer) {
            html += renderPipelineCard(
                'Vertex Input',
                'Index and vertex buffers feeding the input assembler at this event.',
                renderVertexInputSection(vi, resMap)
            );
        }

        if (boundTextures.length || samplers.length) {
            html += '<div class="pipe-grid pipe-grid-2">';
            if (boundTextures.length) {
                html += renderPipelineCard(
                    'Bound Textures',
                    'Sampler-visible textures referenced by the currently selected pipeline state.',
                    '<div class="pipe-chip-wrap">' + boundTextures.map((rid) => renderResourceChip(rid)).join('') + '</div>',
                    'pipe-card-compact'
                );
            }
            if (samplers.length) {
                html += renderPipelineCard(
                    'Samplers',
                    'Resolved sampler descriptor state including filters, addressing, compare, and LOD range.',
                    renderSamplerSection(samplers),
                    'pipe-card-compact'
                );
            }
            html += '</div>';
        }

        body.innerHTML = html;
        body.querySelectorAll('.pipe-stage.clickable').forEach(el => {
            el.addEventListener('click', () => {
                const stageKey = el.dataset.stage;
                if (stageKey) {
                    state.activePipelineStage = stageKey;
                    if (state.pipelineConstantBuffer && state.pipelineConstantBuffer.stage !== stageKey) {
                        state.pipelineConstantBuffer = null;
                        state.pipelineConstantBufferBusyKey = null;
                    }
                    renderPipeline();
                }
            });
        });
        body.querySelectorAll('.stage-tab[data-pipeline-stage]').forEach(el => {
            el.addEventListener('click', () => {
                const stageKey = el.dataset.pipelineStage;
                if (!stageKey || state.activePipelineStage === stageKey) return;
                state.activePipelineStage = stageKey;
                if (state.pipelineConstantBuffer && state.pipelineConstantBuffer.stage !== stageKey) {
                    state.pipelineConstantBuffer = null;
                    state.pipelineConstantBufferBusyKey = null;
                }
                renderPipeline();
            });
        });
        body.querySelectorAll('[data-pipeline-cbuffer-stage]').forEach(el => {
            el.addEventListener('click', () => {
                const stageKey = el.dataset.pipelineCbufferStage;
                const cbufferIndex = Number(el.dataset.pipelineCbufferIndex);
                const arrayElement = Number(el.dataset.pipelineCbufferArray || '0');
                if (!stageKey || !Number.isFinite(cbufferIndex)) return;
                requestPipelineConstantBuffer(stageKey, cbufferIndex, Number.isFinite(arrayElement) ? arrayElement : 0);
            });
        });
        body.querySelectorAll('.resource-chip[data-resid]').forEach(el => {
            el.addEventListener('click', () => activateResourceById(el.dataset.resid));
        });
    }
    function renderPipelineStage(stage, shaders, fb, vi, activePipelineStageKey) {
        let shaderInfo = null;
        let stageKey = stage.id;
        if (stage.kind === 'Shader') {
            const res = resolveShader(shaders, stage.id, stage.aliases);
            if (res) { shaderInfo = res.info; stageKey = res.key; }
        }
        const active = stage.fixed ? true : !!shaderInfo;
        const clickable = stage.kind === 'Shader' && shaderInfo;
        const selected = clickable && activePipelineStageKey && stageKey === activePipelineStageKey;
        let cls = 'pipe-stage' + (stage.fixed ? ' fixed' : '') + (!active ? ' inactive' : '') + (clickable ? ' clickable' : '') + (selected ? ' selected' : '');
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
            const topo = vi.topology ? (' · ' + vi.topology) : '';
            html += '<span class="ps-meta">' + vbCount + ' VB' + (vbCount === 1 ? '' : 's') + (vi.indexBuffer ? ' + IB' : '') + topo + '</span>';
        } else if (stage.id === 'raster') {
            html += '<span class="ps-meta">fixed-function</span>';
        } else if (stage.id === 'om') {
            const nRT = (fb.colorTargets || []).length;
            html += '<span class="ps-meta">' + nRT + ' RT' + (nRT === 1 ? '' : 's') + (fb.depthTarget ? ' + DS' : '') + '</span>';
        }
        html += '</div>';
        return html;
    }

    function activateResourceById(resId) {
        if (!resId) return;
        const resource = resById().get(String(resId));
        if (resource) {
            handleResourceActivation(resource);
            return;
        }
        openTextureModal(String(resId));
    }
    function renderPipelineCard(title, subtitle, body, extraClass) {
        let html = '<section class="pipe-card' + (extraClass ? ' ' + extraClass : '') + '">';
        html += '<div class="pipe-card-header">';
        html += '<div class="pipe-card-title">' + esc(title) + '</div>';
        if (subtitle) html += '<div class="pipe-card-subtitle">' + esc(subtitle) + '</div>';
        html += '</div>';
        html += '<div class="pipe-card-body">' + body + '</div>';
        html += '</section>';
        return html;
    }
    function renderPipelineKvGrid(entries) {
        const filtered = entries.filter((entry) => entry[1] !== '' && entry[1] !== undefined && entry[1] !== null);
        if (!filtered.length) {
            return '<div class="pipe-empty">No state reported for this section.</div>';
        }
        return '<div class="pipe-kv-grid">' + filtered.map(([label, value]) =>
            '<div class="pipe-k">' + esc(label) + '</div><div class="pipe-v">' + value + '</div>'
        ).join('') + '</div>';
    }
    function renderPipelineTable(headers, rows) {
        if (!rows.length) return '<div class="pipe-empty">No entries.</div>';
        let html = '<div class="pipe-table-wrap"><table class="pipe-table"><thead><tr>';
        html += headers.map((header) => '<th>' + esc(header) + '</th>').join('');
        html += '</tr></thead><tbody>';
        html += rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('');
        html += '</tbody></table></div>';
        return html;
    }
    function renderRenderTargetSection(colorRTs, framebuffer, resMap) {
        const rows = [];
        colorRTs.forEach((rid, idx) => {
            const resource = resMap.get(String(rid));
            rows.push([
                esc('RT' + idx),
                renderResourceChip(rid),
                esc(resource?.format || 'Unknown'),
                esc(formatResourceExtent(resource)),
                esc(formatByteSize(resource?.byteSize)),
            ]);
        });
        if (framebuffer.depthTarget) {
            const resource = resMap.get(String(framebuffer.depthTarget));
            rows.push([
                esc('Depth'),
                renderResourceChip(framebuffer.depthTarget, 'DS: ' + resName(framebuffer.depthTarget), 'depth'),
                esc(resource?.format || 'Unknown'),
                esc(formatResourceExtent(resource)),
                esc(formatByteSize(resource?.byteSize)),
            ]);
        }
        if (framebuffer.stencilTarget && String(framebuffer.stencilTarget) !== String(framebuffer.depthTarget)) {
            const resource = resMap.get(String(framebuffer.stencilTarget));
            rows.push([
                esc('Stencil'),
                renderResourceChip(framebuffer.stencilTarget, 'ST: ' + resName(framebuffer.stencilTarget), 'depth'),
                esc(resource?.format || 'Unknown'),
                esc(formatResourceExtent(resource)),
                esc(formatByteSize(resource?.byteSize)),
            ]);
        }
        return renderPipelineTable(['Slot', 'Resource', 'Format', 'Extent', 'Bytes'], rows);
    }
    function renderVertexInputSection(vertexInput, resMap) {
        const body = [];
        const indexResource = vertexInput.indexBuffer ? resMap.get(String(vertexInput.indexBuffer)) : null;
        body.push(renderPipelineKvGrid([
            ['Topology', formatPipelineValue(vertexInput.topology)],
            ['Primitive Restart', formatPipelineBool(vertexInput.primitiveRestart)],
            ['Restart Index', formatPipelineValue(vertexInput.restartIndex)],
            ['Index Buffer', vertexInput.indexBuffer ? renderResourceChip(vertexInput.indexBuffer, 'IB: ' + resName(vertexInput.indexBuffer)) : '<span class="pipe-muted">—</span>'],
            ['Index Stride', formatPipelineValue(vertexInput.indexStride != null ? vertexInput.indexStride + ' B' : undefined)],
            ['Index Bytes', formatPipelineValue(formatByteSize(indexResource?.byteSize))],
        ]));
        const rows = (vertexInput.vertexBuffers || []).map((vb, idx) => {
            const resource = resMap.get(String(vb.resourceId));
            return [
                esc('VB' + idx),
                renderResourceChip(vb.resourceId),
                esc(vb.stride != null ? vb.stride + ' B' : '—'),
                esc(vb.offset != null ? vb.offset + ' B' : '0 B'),
                esc(formatResourceExtent(resource)),
                esc(formatByteSize(resource?.byteSize)),
            ];
        });
        body.push(renderPipelineTable(['Slot', 'Resource', 'Stride', 'Offset', 'Extent', 'Bytes'], rows));
        if (Array.isArray(vertexInput.attributes) && vertexInput.attributes.length) {
            body.push(renderAttributeSection(vertexInput.attributes));
        }
        return body.join('');
    }
    function renderAttributeSection(attributes) {
        const rows = attributes.map((attr, idx) => [
            esc(attr.name || ('Attr ' + idx)),
            esc(attr.location != null ? String(attr.location) : '—'),
            esc(attr.slot != null ? String(attr.slot) : '—'),
            esc(attr.format || 'Unknown'),
            esc(attr.offset != null ? attr.offset + ' B' : '0 B'),
            attr.enabled === false ? '<span class="pipe-muted">Disabled</span>' : formatPipelineBool(!!attr.used),
            attr.perInstance ? esc('Per-instance ×' + (attr.instanceRate != null ? attr.instanceRate : 1)) : '<span class="pipe-muted">Per-vertex</span>',
        ]);
        return '<div class="pipe-section-subtitle">Attributes</div>' + renderPipelineTable(['Attribute', 'Location', 'VB Slot', 'Format', 'Offset', 'Used', 'Rate'], rows);
    }
    function renderBlendTargets(targets) {
        if (!targets.length) return '<div class="pipe-empty">No per-target blend descriptors were reported.</div>';
        const rows = targets.map((target) => [
            esc('RT' + target.index),
            formatPipelineBool(target.enabled),
            esc(formatWriteMask(target.writeMask)),
            esc(formatBlendOp(target.colorBlend)),
            esc(formatBlendOp(target.alphaBlend)),
            formatPipelineBool(target.logicOpEnabled),
        ]);
        return renderPipelineTable(['Target', 'Enabled', 'Write Mask', 'Color Blend', 'Alpha Blend', 'Logic Op'], rows);
    }
    function renderSamplerSection(samplers) {
        const rows = samplers.map((sampler, idx) => [
            esc(sampler.name || ('Sampler ' + idx)),
            esc([sampler.minFilter, sampler.magFilter, sampler.mipFilter].filter(Boolean).join(' / ') || '—'),
            esc([sampler.addressU, sampler.addressV, sampler.addressW].filter(Boolean).join(' / ') || '—'),
            sampler.compareEnable ? esc(sampler.compareFunc || 'Enabled') : '<span class="pipe-muted">Disabled</span>',
            esc((sampler.minLOD != null ? sampler.minLOD : '0') + ' → ' + (sampler.maxLOD != null ? sampler.maxLOD : '∞')),
            esc(sampler.maxAnisotropy != null ? String(sampler.maxAnisotropy) : '—'),
        ]);
        return renderPipelineTable(['Sampler', 'Filter', 'Address', 'Compare', 'LOD Range', 'Aniso'], rows);
    }
    function renderResourceChip(resourceId, label, extraClass) {
        return '<span class="resource-chip' + (extraClass ? ' ' + extraClass : '') + '" data-resid="' + esc(String(resourceId)) + '">' + esc(label || resName(resourceId)) + '</span>';
    }
    function formatPipelineValue(value) {
        if (value === undefined || value === null || value === '') return '<span class="pipe-muted">—</span>';
        if (typeof value === 'boolean') return formatPipelineBool(value);
        if (Array.isArray(value)) return esc(value.join(', '));
        return esc(String(value));
    }
    function formatPipelineBool(value) {
        if (value === undefined || value === null) return '<span class="pipe-muted">—</span>';
        return '<span class="pipe-bool ' + (value ? 'on' : 'off') + '">' + (value ? 'Enabled' : 'Disabled') + '</span>';
    }
    function formatPipelineArray(value) {
        if (!Array.isArray(value) || value.length === 0) return '<span class="pipe-muted">—</span>';
        return esc(value.join(', '));
    }
    function formatStencilFace(face) {
        if (!face || typeof face !== 'object') return '<span class="pipe-muted">—</span>';
        const parts = [];
        if (face.compareFunc) parts.push('Cmp ' + face.compareFunc);
        if (face.passOp) parts.push('Pass ' + face.passOp);
        if (face.failOp) parts.push('Fail ' + face.failOp);
        if (face.depthFailOp) parts.push('DepthFail ' + face.depthFailOp);
        return esc(parts.join(' · ') || 'Configured');
    }
    function formatBlendOp(blend) {
        if (!blend || typeof blend !== 'object') return '—';
        return [blend.src, blend.dst, blend.op].filter(Boolean).join(' / ');
    }
    function formatWriteMask(mask) {
        if (mask === undefined || mask === null || mask === '') return '—';
        if (typeof mask === 'string') return mask;
        if (typeof mask !== 'number') return String(mask);
        const channels = [];
        if (mask & 0x1) channels.push('R');
        if (mask & 0x2) channels.push('G');
        if (mask & 0x4) channels.push('B');
        if (mask & 0x8) channels.push('A');
        return channels.length ? channels.join('') : 'None';
    }
    function formatResourceExtent(resource) {
        if (!resource) return '—';
        if (resource.width || resource.height || resource.depth) {
            return [resource.width || 0, resource.height || 0].concat(resource.depth > 1 ? [resource.depth] : []).join(' × ');
        }
        return resource.format || '—';
    }
    function formatByteSize(bytes) {
        if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) return '—';
        const value = Number(bytes);
        if (value < 1024) return value + ' B';
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
        if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + ' MB';
        return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    function buildPipelineDiagnostics(pipeline, vertexInput, framebuffer, shaders, boundTextures, samplers) {
        const diagnostics = [];
        const colorTargets = framebuffer.colorTargets || [];
        const blendTargets = Array.isArray(pipeline.blendState?.targets) ? pipeline.blendState.targets : [];
        if (!colorTargets.length && !framebuffer.depthTarget) {
            diagnostics.push({
                kind: 'warn',
                title: 'No framebuffer attachments reported',
                text: 'The current event has no color or depth attachments in the pipeline snapshot. This can happen on setup/clear events or indicate incomplete state.',
            });
        }
        if (pipeline.depthStencil?.depthEnable && !framebuffer.depthTarget) {
            diagnostics.push({
                kind: 'warn',
                title: 'Depth test enabled without depth target',
                text: 'Depth testing is on, but no depth attachment is currently reported. This often explains missing geometry or unexpected overdraw.',
            });
        }
        if (blendTargets.some((target) => target.enabled) && !colorTargets.length) {
            diagnostics.push({
                kind: 'warn',
                title: 'Blend enabled without color RT',
                text: 'At least one blend target is active, but no color render target is bound in the current pipeline snapshot.',
            });
        }
        if ((vertexInput.vertexBuffers || []).length > 0 && !Object.keys(shaders || {}).some((key) => key === 'vertex')) {
            diagnostics.push({
                kind: 'warn',
                title: 'Vertex input without vertex shader',
                text: 'Vertex buffers are bound, but there is no vertex shader stage reported. This can happen on compute events or indicate incomplete replay state.',
            });
        }
        if ((boundTextures || []).length > 0 && !(samplers || []).length) {
            diagnostics.push({
                kind: 'info',
                title: 'Textures are bound with no sampler descriptors',
                text: 'Read-only textures are visible in the descriptor walk, but no distinct sampler objects were reported. The API may be using inline/default sampler state.',
            });
        }
        const unusedAttrs = (vertexInput.attributes || []).filter((attr) => attr.enabled !== false && attr.used === false);
        if (unusedAttrs.length) {
            diagnostics.push({
                kind: 'info',
                title: 'Unused vertex attributes present',
                text: unusedAttrs.length + ' vertex attribute(s) are enabled in the input layout but do not appear in shader reflection for the current vertex stage.',
            });
        }
        if (vertexInput.primitiveRestart && !vertexInput.indexBuffer) {
            diagnostics.push({
                kind: 'warn',
                title: 'Primitive restart enabled without index buffer',
                text: 'Primitive restart is only relevant for indexed draws, but no index buffer is reported in the current input assembler state.',
            });
        }
        return diagnostics;
    }

    function renderGraphStat(label, value) {
        return '<div class="stat-card pg-stat"><div class="n">' + esc(value) + '</div><div class="l">' + esc(label) + '</div></div>';
    }
    function renderGraphBadge(label, kind) {
        return '<span class="pg-badge' + (kind ? ' ' + kind : '') + '">' + esc(label) + '</span>';
    }
    function renderGraphTextChip(label, kind) {
        return '<span class="pg-chip' + (kind ? ' ' + kind : '') + '">' + esc(label) + '</span>';
    }
    function truncateGraphLabel(text, maxLength = 28) {
        const value = String(text || '');
        if (value.length <= maxLength) return value;
        return value.slice(0, Math.max(1, maxLength - 1)) + '...';
    }
    function renderGraphList(items) {
        if (!items || items.length === 0) return '<div class="pg-note">None</div>';
        return '<div class="pg-list">' + items.map(item => '<div class="pg-list-item">' + esc(item) + '</div>').join('') + '</div>';
    }
    function renderGraphSection(title, items) {
        return '<div class="pg-section">'
            + '<div class="pg-section-title">' + esc(title) + '</div>'
            + renderGraphList(items)
            + '</div>';
    }
    function formatEidRange(min, max) {
        if (!isFinite(min) || !isFinite(max)) return 'n/a';
        return min === max ? String(min) : (min + '-' + max);
    }
    function inferFlowKind(name, flags, stats, hasChildren) {
        const text = ((name || '') + ' ' + (flags || '')).toLowerCase();
        if (/present|swapchain|backbuffer/.test(text)) return 'present';
        if (/shadow|cascade|depth prepass|depthprepass|depth-only|depth only|shadowmap/.test(text)) return 'shadow';
        if (/opaque|gbuffer|deferred|prepass|depthnormal/.test(text)) return 'opaque';
        if (/transparent|translucent|alpha|particle|glass/.test(text)) return 'transparent';
        if (/imageeffect|postfx|post fx|post-process|post process|bloom|tonemap|taa|fxaa|smaa|dof|ssao|ssr|blur|upscale|color.?grading/.test(text)) return 'postfx';
        if (/ui|canvas|imgui|hud|overlay|gizmo/.test(text)) return 'ui';
        if (/copy|blit|resolve|genmips/.test(text)) return 'transfer';
        if (/clear/.test(text) && (!stats || stats.draws === 0)) return 'clear';
        if (/compute|dispatch/.test(text) || (stats && stats.dispatches > 0 && stats.draws === 0)) return 'compute';
        if (/camera|render view|main pass|render scene/.test(text) && hasChildren) return 'camera';
        if (hasChildren) return 'group';
        return 'draw';
    }
    function kindLabel(kind) {
        const map = {
            camera: 'Camera / View',
            shadow: 'Shadow Pass',
            opaque: 'Opaque Pass',
            transparent: 'Transparent Pass',
            postfx: 'Post FX',
            ui: 'UI / Overlay',
            compute: 'Compute',
            transfer: 'Copy / Resolve',
            clear: 'Clear',
            present: 'Present',
            group: 'Marker Group',
            draw: 'Draw Sequence',
        };
        return map[kind] || 'Pass';
    }
    function computeGraphNodeWorkload(stats) {
        if (!stats) return 0;
        return stats.draws + stats.dispatches * 1.4 + stats.copies * 0.55 + stats.clears * 0.3 + stats.presents * 0.2;
    }
    function describeFlowNode(node) {
        const synthetic = !!node?.synthetic;
        const stats = synthetic ? node.stats : collectNodeStats(node);
        const gpuTimeUs = collectNodeGpuTimeUs(node);
        const hasChildren = synthetic ? false : !!(node?.children && node.children.length);
        const kind = synthetic ? node.kind : inferFlowKind(node?.name, node?.flags, stats, hasChildren);
        const title = synthetic ? node.title : (node?.name || 'Unnamed pass');
        return {
            synthetic,
            stats,
            gpuTimeUs,
            hasChildren,
            kind,
            title,
            focusKey: makeGraphFocusKey(kind, stats, title),
            metric: gpuTimeUs > 0 ? gpuTimeUs : computeGraphNodeWorkload(stats),
        };
    }
    function buildPipelineGraphHeat(topLevel) {
        const candidates = [];

        function visit(node, depth) {
            const descriptor = describeFlowNode(node);
            candidates.push({ ...descriptor, node, depth });
            if (!descriptor.synthetic) {
                getFlowChildren(node).forEach((child) => visit(child, depth + 1));
            }
        }

        function buildPath(node, depth) {
            const descriptor = describeFlowNode(node);
            const result = { metric: descriptor.metric, nodes: [{ ...descriptor, node, depth }] };
            if (descriptor.synthetic) return result;
            const children = getFlowChildren(node);
            if (!children.length) return result;
            let bestChildPath = null;
            children.forEach((child) => {
                const childPath = buildPath(child, depth + 1);
                if (!bestChildPath || childPath.metric > bestChildPath.metric) bestChildPath = childPath;
            });
            if (bestChildPath?.nodes?.length) result.nodes.push(...bestChildPath.nodes);
            return result;
        }

        (topLevel || []).forEach((node) => visit(node, 0));
        const meaningful = candidates.filter((candidate) => candidate.metric > 0);
        const preferredPasses = meaningful.filter((candidate) => !candidate.synthetic || candidate.depth === 0);
        const passPool = preferredPasses.length ? preferredPasses : meaningful;
        const hottestPass = passPool.sort((left, right) => right.metric - left.metric || left.depth - right.depth)[0] || null;

        let hottestPath = null;
        (topLevel || []).forEach((node) => {
            const path = buildPath(node, 0);
            if (!hottestPath || path.metric > hottestPath.metric) hottestPath = path;
        });

        const hottestPathKeys = new Set((hottestPath?.nodes || []).map((node) => node.focusKey));
        return {
            hottestPass,
            hottestPath,
            hottestPathKeys,
            hottestPathMetric: hottestPath?.metric || 0,
            hasTimingData: !!meaningful.find((candidate) => candidate.gpuTimeUs > 0),
        };
    }
    function formatPipelineGraphHeatValue(metric, hasTimingData) {
        return hasTimingData ? formatDurationUs(metric) : ('score ' + Number(metric || 0).toFixed(1));
    }
    function formatPipelineGraphHotPathLabel(path) {
        const labels = (path?.nodes || []).map((node) => truncateGraphLabel(node.title, 24));
        if (!labels.length) return 'Unavailable';
        if (labels.length <= 3) return labels.join(' > ');
        return labels[0] + ' > ' + labels[1] + ' > ...';
    }
    function collectNodeStats(node) {
        const stats = {
            minEid: node && node.eventId != null ? node.eventId : Infinity,
            maxEid: node && node.eventId != null ? node.eventId : -Infinity,
            events: node ? 1 : 0,
            draws: /drawcall/i.test(node?.flags || '') ? 1 : 0,
            dispatches: /dispatch/i.test(node?.flags || '') ? 1 : 0,
            clears: /clear/i.test(node?.flags || '') ? 1 : 0,
            copies: /(copy|resolve|genmips)/i.test(node?.flags || '') ? 1 : 0,
            presents: /present/i.test(node?.flags || '') ? 1 : 0,
            markers: node?.children?.length ? 1 : 0,
            leaves: !node?.children?.length ? 1 : 0,
        };
        (node.children || []).forEach(child => {
            const sub = collectNodeStats(child);
            stats.minEid = Math.min(stats.minEid, sub.minEid);
            stats.maxEid = Math.max(stats.maxEid, sub.maxEid);
            stats.events += sub.events;
            stats.draws += sub.draws;
            stats.dispatches += sub.dispatches;
            stats.clears += sub.clears;
            stats.copies += sub.copies;
            stats.presents += sub.presents;
            stats.markers += sub.markers;
            stats.leaves += sub.leaves;
        });
        return stats;
    }
    function gatherLeafPreview(node, limit, out = []) {
        if (!node || out.length >= limit) return out;
        if (!node.children?.length) {
            out.push(node);
            return out;
        }
        node.children.forEach(child => {
            if (out.length < limit) gatherLeafPreview(child, limit, out);
        });
        return out;
    }
    function isDrawCommand(node) {
        return /drawcall/i.test(node?.flags || '');
    }
    function filterDrawCommandTree(nodes) {
        const filtered = [];
        (nodes || []).forEach(node => {
            if (!node) return;
            if (node.children?.length) {
                const children = filterDrawCommandTree(node.children);
                if (children.length) filtered.push({ ...node, children });
            } else if (isDrawCommand(node)) {
                filtered.push(node);
            }
        });
        return filtered;
    }
    function compressLeafNodes(nodes) {
        if (!nodes.length) return [];
        const groups = [];
        let bucket = [];
        const flush = () => {
            if (!bucket.length) return;
            const first = bucket[0];
            const last = bucket[bucket.length - 1];
            const stats = bucket.reduce((acc, node) => {
                acc.minEid = Math.min(acc.minEid, node.eventId);
                acc.maxEid = Math.max(acc.maxEid, node.eventId);
                if (/drawcall/i.test(node.flags || '')) acc.draws += 1;
                if (/dispatch/i.test(node.flags || '')) acc.dispatches += 1;
                if (/clear/i.test(node.flags || '')) acc.clears += 1;
                if (/(copy|resolve|genmips)/i.test(node.flags || '')) acc.copies += 1;
                if (/present/i.test(node.flags || '')) acc.presents += 1;
                return acc;
            }, { minEid: Infinity, maxEid: -Infinity, draws: 0, dispatches: 0, clears: 0, copies: 0, presents: 0 });
            const selected = bucket.some(node => node.eventId === state.eventId);
            const labelParts = [];
            if (stats.draws) labelParts.push(stats.draws + ' draw' + (stats.draws === 1 ? '' : 's'));
            if (stats.dispatches) labelParts.push(stats.dispatches + ' dispatch' + (stats.dispatches === 1 ? '' : 'es'));
            if (stats.clears) labelParts.push(stats.clears + ' clear' + (stats.clears === 1 ? '' : 's'));
            if (stats.copies) labelParts.push(stats.copies + ' copy/resolve');
            if (stats.presents) labelParts.push(stats.presents + ' present');
            groups.push({
                synthetic: true,
                title: bucket.length === 1 ? first.name : 'Inline Commands',
                subtitle: bucket.length === 1 ? (first.flags || 'Event') : labelParts.join(' · '),
                kind: inferFlowKind(first.name, first.flags, stats, false),
                stats,
                events: bucket,
                selected,
                preview: bucket.slice(0, 5),
                eid: first.eventId,
            });
            bucket = [];
        };
        nodes.forEach(node => {
            if (node.children?.length) {
                flush();
                groups.push(node);
            } else {
                bucket.push(node);
            }
        });
        flush();
        return groups;
    }
    function getFlowChildren(node) {
        const rawChildren = (node.children || []).filter(child => child != null);
        return compressLeafNodes(rawChildren);
    }
    function summarizeStats(stats) {
        const parts = [];
        if (stats.draws) parts.push(stats.draws + ' draw' + (stats.draws === 1 ? '' : 's'));
        if (stats.dispatches) parts.push(stats.dispatches + ' dispatch' + (stats.dispatches === 1 ? '' : 'es'));
        if (stats.clears) parts.push(stats.clears + ' clear' + (stats.clears === 1 ? '' : 's'));
        if (stats.copies) parts.push(stats.copies + ' copy/resolve');
        if (stats.presents) parts.push(stats.presents + ' present');
        if (!parts.length) parts.push(stats.events + ' event' + (stats.events === 1 ? '' : 's'));
        return parts.join(' · ');
    }
    function renderLeafPreview(items) {
        if (!items || !items.length) return '<div class="pg-note">No representative commands.</div>';
        return '<div class="pg-list">' + items.map(item => {
            const current = item.eventId === state.eventId ? ' current' : '';
            return '<div class="pg-list-item pg-command' + current + '">'
                + '<span class="pg-command-eid">EID ' + esc(item.eventId) + '</span>'
                + '<span class="pg-command-name">' + esc(item.name || '(unnamed)') + '</span>'
                + '<span class="pg-command-flag">' + esc(item.flags || 'Event') + '</span>'
                + '</div>';
        }).join('') + '</div>';
    }
    function renderCommandSection(title, items) {
        return '<div class="pg-section pg-command-section"><div class="pg-section-title">' + esc(title) + '</div>' + renderLeafPreview(items) + '</div>';
    }
    function renderFlowNode(node, depth, selectedSet, focusedGraphKey, heat) {
        const descriptor = describeFlowNode(node);
        const synthetic = descriptor.synthetic;
        const stats = descriptor.stats;
        const gpuTimeUs = descriptor.gpuTimeUs;
        const hasChildren = descriptor.hasChildren;
        const kind = descriptor.kind;
        const current = synthetic
            ? !!node.selected
            : (selectedSet.has(node.eventId) || (state.eventId != null && stats.minEid <= state.eventId && state.eventId <= stats.maxEid && selectedSet.has(node.eventId)));
        const title = descriptor.title;
        const focusKey = descriptor.focusKey;
        const hotPass = !!(heat?.hottestPass && heat.hottestPass.focusKey === focusKey);
        const hotPath = !!heat?.hottestPathKeys?.has(focusKey);
        const subtitle = synthetic
            ? node.subtitle
            : (kindLabel(kind) + ' · ' + summarizeStats(stats));
        const badges = [
            renderGraphBadge(kindLabel(kind), kind),
            renderGraphBadge('EID ' + formatEidRange(stats.minEid, stats.maxEid), 'mono'),
        ];
        if (gpuTimeUs > 0) badges.push(renderGraphBadge(formatDurationUs(gpuTimeUs), 'mono'));
        if (hotPass) badges.push(renderGraphBadge('Hot Pass', 'hot'));
        else if (hotPath) badges.push(renderGraphBadge('Hot Path', 'hot-path'));
        if (stats.draws) badges.push(renderGraphBadge(stats.draws + ' draws', 'mono'));
        if (stats.dispatches) badges.push(renderGraphBadge(stats.dispatches + ' dispatches', 'mono'));
        const childModels = synthetic ? [] : getFlowChildren(node);
        const nestedGroups = synthetic ? [] : childModels.filter(child => !child.synthetic);
        const directDrawEvents = synthetic ? [] : childModels.flatMap(child => child.synthetic ? (child.events || []) : []);
        const preview = synthetic ? (node.events || node.preview) : gatherLeafPreview(node, hasChildren ? 5 : 3);
        const sections = [
            renderGraphSection('Summary', [
                summarizeStats(stats),
                gpuTimeUs > 0 ? ('GPU time ' + formatDurationUs(gpuTimeUs)) : 'GPU time unavailable',
                stats.markers > 1 ? (stats.markers - 1) + ' nested pass groups' : 'No nested pass groups',
                'Leaf events ' + stats.leaves,
            ]),
        ];
        if (synthetic) {
            sections.push(renderCommandSection('Draw Commands', preview));
        } else if (directDrawEvents.length) {
            sections.push(renderCommandSection('Draw Commands In This Pass', directDrawEvents));
        } else {
            sections.push(renderCommandSection('Representative Commands', preview));
        }
        let html = '<div class="pg-tree-node depth-' + depth + '">';
        html += renderGraphNode({
            kind: 'flow-' + kind + (current ? ' current' : '') + (hotPass ? ' hot-pass' : '') + (hotPath ? ' hot-path' : ''),
            active: true,
            title,
            subtitle,
            badges,
            chips: [
                current && state.eventId != null ? renderGraphTextChip('Selected EID ' + state.eventId, 'current') : '',
                hotPass ? renderGraphTextChip('Highest cost node', 'hot') : '',
                (!hotPass && hotPath) ? renderGraphTextChip('On hottest chain', 'hot-path') : '',
            ].filter(Boolean),
            note: !synthetic && node.flags && !hasChildren ? node.flags : undefined,
            sections,
            focusKey,
            focused: focusedGraphKey === focusKey,
            eventId: synthetic ? (node.eid || stats.minEid) : stats.minEid,
        });
        if (nestedGroups.length) {
            html += '<div class="pg-children">';
            nestedGroups.forEach((child, idx) => {
                const childDescriptor = describeFlowNode(child);
                const connectorHot = hotPath && !!heat?.hottestPathKeys?.has(childDescriptor.focusKey);
                html += '<div class="pg-child-link">';
                if (idx > 0) html += '<div class="pg-child-spacer"></div>';
                html += '<div class="pg-child-connector' + (connectorHot ? ' hot' : '') + '"></div>';
                html += renderFlowNode(child, Math.min(depth + 1, 4), selectedSet, focusedGraphKey, heat);
                html += '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        return html;
    }
    function renderGraphNode(options) {
        const badges = options.badges || [];
        const breadcrumbs = options.breadcrumbs || [];
        const chips = options.chips || [];
        const sections = options.sections || [];
        const attrs = [];
        if (options.focusKey) attrs.push('data-focus-key="' + esc(options.focusKey) + '"');
        if (options.eventId != null) attrs.push('data-eid="' + esc(String(options.eventId)) + '"');
        let html = '<div class="pg-node' + (options.kind ? ' ' + options.kind : '') + (!options.active ? ' inactive' : '') + (options.focused ? ' focused' : '') + (options.eventId != null ? ' clickable' : '') + '" ' + attrs.join(' ') + '>';
        html += '<div class="pg-node-header">';
        html += '<div class="pg-node-title-wrap">';
        html += '<div class="pg-node-title">' + esc(options.title || '') + '</div>';
        if (options.subtitle) html += '<div class="pg-node-subtitle">' + esc(options.subtitle) + '</div>';
        html += '</div>';
        if (badges.length) {
            html += '<div class="pg-badges">' + badges.join('') + '</div>';
        }
        html += '</div>';
        if (breadcrumbs.length) {
            html += '<div class="pg-breadcrumbs">' + breadcrumbs.map(label => '<span class="pg-crumb">' + esc(label) + '</span>').join('') + '</div>';
        }
        if (chips.length) {
            html += '<div class="pg-chip-row">' + chips.join('') + '</div>';
        }
        if (sections.length) {
            html += '<div class="pg-sections">' + sections.join('') + '</div>';
        }
        if (options.note) {
            html += '<div class="pg-note">' + esc(options.note) + '</div>';
        }
        html += '</div>';
        return html;
    }
    function renderGraphConnector(label) {
        return '<div class="pg-connector">'
            + '<span class="pg-connector-line"></span>'
            + '<span class="pg-connector-arrow"></span>'
            + (label ? '<span class="pg-connector-label">' + esc(label) + '</span>' : '')
            + '</div>';
    }
    function focusPipelineGraphNode() {
        if (state.activeTab !== 'pipelinegraph' || !state.graphFocus?.key) return;
        const viewport = document.getElementById('pipeline-graph-viewport');
        if (!viewport) return;
        const target = viewport.querySelector('.pg-node[data-focus-key="' + CSS.escape(state.graphFocus.key) + '"]');
        if (!target) return;

        requestAnimationFrame(() => {
            const viewportRect = viewport.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const offsetLeft = (targetRect.left - viewportRect.left) + viewport.scrollLeft - Math.max(24, (viewport.clientWidth - targetRect.width) * 0.5);
            const offsetTop = (targetRect.top - viewportRect.top) + viewport.scrollTop - Math.max(24, (viewport.clientHeight - targetRect.height) * 0.25);
            viewport.scrollLeft = Math.max(0, offsetLeft);
            viewport.scrollTop = Math.max(0, offsetTop);
        });
    }
    function clampGraphZoom(zoom) {
        return Math.max(state.graphMinZoom, Math.min(state.graphMaxZoom, zoom));
    }
    function updatePipelineGraphZoomUi() {
        const resetBtn = document.getElementById('pg-zoom-reset');
        const zoomLabel = document.getElementById('pg-zoom-label');
        const percent = Math.round(state.graphZoom * 100);
        if (resetBtn) {
            resetBtn.textContent = percent + '%';
            resetBtn.classList.toggle('active', Math.abs(state.graphZoom - 1) < 0.001);
        }
        if (zoomLabel) zoomLabel.textContent = percent + '%';
    }
    function applyPipelineGraphTransform() {
        const viewport = document.getElementById('pipeline-graph-viewport');
        const stage = document.getElementById('pipeline-graph-stage');
        const body = document.getElementById('pipeline-graph-body');
        if (!viewport || !stage || !body) return;
        const naturalWidth = Math.max(body.scrollWidth, body.offsetWidth, 1);
        const naturalHeight = Math.max(body.scrollHeight, body.offsetHeight, 1);
        const scaledWidth = Math.ceil(naturalWidth * state.graphZoom);
        const scaledHeight = Math.ceil(naturalHeight * state.graphZoom);
        const horizontalPad = 32;
        const verticalPad = 24;
        const stageWidth = Math.max(viewport.clientWidth, scaledWidth + horizontalPad * 2);
        const stageHeight = Math.max(viewport.clientHeight, scaledHeight + verticalPad * 2);
        stage.style.width = stageWidth + 'px';
        stage.style.height = stageHeight + 'px';
        body.style.transform = 'scale(' + state.graphZoom + ')';
        body.style.transformOrigin = 'top left';
        body.style.left = Math.max(horizontalPad, Math.floor((stageWidth - scaledWidth) * 0.5)) + 'px';
        body.style.top = verticalPad + 'px';
        updatePipelineGraphZoomUi();
    }
    function setPipelineGraphZoom(nextZoom, anchor) {
        const viewport = document.getElementById('pipeline-graph-viewport');
        const body = document.getElementById('pipeline-graph-body');
        if (!viewport || !body) return;
        const prevZoom = state.graphZoom;
        const zoom = clampGraphZoom(nextZoom);
        if (Math.abs(prevZoom - zoom) < 0.0001) {
            updatePipelineGraphZoomUi();
            return;
        }
        const anchorX = anchor?.x ?? viewport.clientWidth * 0.5;
        const anchorY = anchor?.y ?? viewport.clientHeight * 0.5;
        const contentX = (viewport.scrollLeft + anchorX) / prevZoom;
        const contentY = (viewport.scrollTop + anchorY) / prevZoom;
        state.graphZoom = zoom;
        applyPipelineGraphTransform();
        viewport.scrollLeft = Math.max(0, contentX * zoom - anchorX);
        viewport.scrollTop = Math.max(0, contentY * zoom - anchorY);
    }
    function fitPipelineGraphToWidth() {
        const viewport = document.getElementById('pipeline-graph-viewport');
        const body = document.getElementById('pipeline-graph-body');
        if (!viewport || !body) return;
        const naturalWidth = Math.max(body.scrollWidth, body.offsetWidth, 1);
        const fitted = clampGraphZoom((viewport.clientWidth - 24) / naturalWidth);
        setPipelineGraphZoom(fitted, { x: 0, y: 0 });
        viewport.scrollLeft = 0;
    }
    function renderPipelineGraph() {
        const body = document.getElementById('pipeline-graph-body');
        if (!state.captureInfo || !state.drawCalls.length) {
            body.textContent = 'Load a capture to view its draw command graph.';
            body.className = 'empty-state';
            return;
        }
        const drawOnlyCalls = filterDrawCommandTree(state.drawCalls);
        if (!drawOnlyCalls.length) {
            body.textContent = 'No draw commands in this capture.';
            body.className = 'empty-state';
            return;
        }
        const selectedPath = state.eventId != null ? (findEventPath(drawOnlyCalls, state.eventId) || []) : [];
        const selectedSet = new Set(selectedPath.map(dc => dc.eventId));
        const focusedGraphKey = state.graphFocus?.key || null;
        const topLevel = compressLeafNodes(drawOnlyCalls);
        const heat = buildPipelineGraphHeat(topLevel);
        const graphGpuTimeUs = state.timingsAvailable ? topLevel.reduce((sum, node) => sum + collectNodeGpuTimeUs(node), 0) : 0;
        const topStats = drawOnlyCalls.reduce((acc, node) => {
            const sub = collectNodeStats(node);
            acc.events += sub.events;
            acc.draws += sub.draws;
            return acc;
        }, { events: 0, draws: 0 });
        const topKinds = new Set();
        topLevel.forEach(node => {
            if (node.synthetic) topKinds.add(node.kind);
            else topKinds.add(inferFlowKind(node.name, node.flags, collectNodeStats(node), !!node.children?.length));
        });

        let html = '<div class="pipeline-graph-shell">';
        html += '<div class="stat-row pg-summary">';
        html += renderGraphStat('Top-Level Steps', topLevel.length);
        html += renderGraphStat('Draw Commands', topStats.draws);
        html += renderGraphStat('Context Nodes', topStats.events - topStats.draws);
        html += renderGraphStat('Pass Kinds', topKinds.size);
        if (graphGpuTimeUs > 0) html += renderGraphStat('GPU Time', formatDurationUs(graphGpuTimeUs));
        if (heat.hottestPass) html += renderGraphStat('Hot Pass', formatPipelineGraphHeatValue(heat.hottestPass.metric, heat.hasTimingData));
        html += '</div>';
        html += '<div class="pg-hero">';
        html += '<div class="pg-hero-title">Capture Draw Commands</div>';
        html += '<div class="pg-hero-text">This graph keeps only DrawCall events from the RDC EventBrowser hierarchy. Marker groups are retained only when they contain draw commands, and consecutive draw leaves are compressed into inline command blocks.</div>';
        html += '<div class="pg-chip-row">';
        html += renderGraphTextChip('API: ' + (state.captureInfo.api || 'Unknown'));
        html += renderGraphTextChip('Driver: ' + (state.captureInfo.driver || 'Unknown'));
        html += renderGraphTextChip(state.timingsAvailable ? ('Timings: ' + formatDurationUs(graphGpuTimeUs)) : ('Timings: ' + (state.timingsError || 'Unavailable')));
        if (heat.hottestPass) html += renderGraphTextChip('Hot Pass: ' + truncateGraphLabel(heat.hottestPass.title, 26) + ' · ' + formatPipelineGraphHeatValue(heat.hottestPass.metric, heat.hasTimingData), 'hot');
        if (heat.hottestPath?.nodes?.length) html += renderGraphTextChip('Hot Chain: ' + formatPipelineGraphHotPathLabel(heat.hottestPath), 'hot-path');
        if (state.eventId != null) html += renderGraphTextChip('Focused EID ' + state.eventId, 'current');
        html += '</div>';
        html += '</div>';

        html += '<div class="pg-tree">';
        topLevel.forEach((node, idx) => {
            if (idx > 0) html += renderGraphConnector('next stage');
            html += renderFlowNode(node, 0, selectedSet, focusedGraphKey, heat);
        });
        html += '</div>';

        html += '</div>';
        body.className = '';
        body.innerHTML = html;
        applyPipelineGraphTransform();
        focusPipelineGraphNode();
        body.querySelectorAll('.pg-node.clickable[data-eid]').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.stopPropagation();
                const eventId = parseInt(el.dataset.eid || '', 10);
                if (!Number.isNaN(eventId) && eventId > 0) {
                    state.graphFocus = { key: el.dataset.focusKey || null, eventId };
                    vscode.postMessage({ type: 'selectEvent', eventId });
                }
            });
        });
    }

    // ── Shaders ────────────────────────────────────────────────────
    function renderShaders() {
        const body = document.getElementById('shaders-body');
        const toolbar = document.getElementById('shaders-toolbar');
        const shaderPaneMeta = document.getElementById('shader-pane-meta');
        const stageTabs = document.getElementById('shader-stage-tabs');
        const editorActions = document.getElementById('shader-editor-actions');
        const analysisActions = document.getElementById('shader-analysis-actions');
        const fileBar = document.getElementById('shader-file-tabs');
        if (!body || !toolbar || !stageTabs || !editorActions || !analysisActions || !fileBar) return;

        const setReadOnlyState = (message, metaText) => {
            body.textContent = message;
            body.className = 'shader-editor-panel empty-state';
            toolbar.hidden = true;
            stageTabs.innerHTML = '';
            editorActions.innerHTML = '';
            analysisActions.innerHTML = '';
            fileBar.innerHTML = '';
            fileBar.hidden = true;
            if (shaderPaneMeta) shaderPaneMeta.textContent = metaText;
            renderShaderEditStatus();
            renderShaderDiagnostics();
        };

        if (state.eventId == null) {
            setReadOnlyState('Select an event.', 'Select an event to inspect bound shader stages.');
            return;
        }
        if (!state.shaders) {
            setReadOnlyState('Loading shaders…', 'Collecting shader source and stage metadata from the current event.');
            return;
        }
        if (state.shaders.error) {
            setReadOnlyState(
                'Shader sources unavailable: ' + state.shaders.error + '\n\n(Local replay required.)',
                'Shader extraction needs an active local replay for this capture.',
            );
            return;
        }

        const shaders = state.shaders.shaders || {};
        const stages = Object.keys(shaders);
        const vertexStageIndex = stages.indexOf('vertex');
        const fragmentStageIndex = stages.indexOf('fragment');
        if (vertexStageIndex !== -1 && fragmentStageIndex !== -1 && vertexStageIndex > fragmentStageIndex) {
            stages.splice(vertexStageIndex, 1);
            stages.splice(fragmentStageIndex, 0, 'vertex');
        }
        if (stages.length === 0) {
            setReadOnlyState('No bound shaders at this event.', 'No shader stages are bound at the selected event.');
            return;
        }

        toolbar.hidden = false;
        stageTabs.innerHTML = '';
        editorActions.innerHTML = '';
        analysisActions.innerHTML = '';
        if (!state.activeShaderStage || !stages.includes(state.activeShaderStage)) {
            state.activeShaderStage = stages[0];
        }

        for (const stage of stages) {
            const btn = document.createElement('button');
            btn.className = 'stage-tab' + (stage === state.activeShaderStage ? ' active' : '');
            btn.textContent = stage;
            btn.addEventListener('click', () => {
                if (stage === state.activeShaderStage) {
                    invalidateShaderEditorSyncKey();
                }
                state.activeShaderStage = stage;
                renderShaders();
            });
            stageTabs.appendChild(btn);
        }

        const activeStage = state.activeShaderStage;
        const info = shaders[activeStage] || {};
        const sourceFiles = Array.isArray(info.sourceFiles) ? info.sourceFiles : [];
        const currentFiles = buildEditedShaderFiles(activeStage, sourceFiles);
        const hasDisasm = typeof info.disassembly === 'string' && info.disassembly.length > 0;
        const entryFileIndex = (typeof info.entryFileIndex === 'number' && info.entryFileIndex >= 0)
            ? info.entryFileIndex
            : 0;
        const linkedSourceFiles = buildEditedShaderFiles(activeStage, sourceFiles);

        let cur = state.activeShaderFile[activeStage];
        const maxIdx = currentFiles.length - 1;
        if (cur === undefined || cur === null || (cur >= 0 && cur > maxIdx) || (cur === -1 && !hasDisasm)) {
            cur = currentFiles.length > 0 ? entryFileIndex : (hasDisasm ? -1 : 0);
            state.activeShaderFile[activeStage] = cur;
        }
        const currentLanguage = cur === -1 && hasDisasm ? 'plaintext' : shaderLanguageForEncoding(info.sourceEncoding);

        const editableStage = !!info.editable && currentFiles.length > 0;
        const currentFile = cur >= 0 && cur < currentFiles.length ? currentFiles[cur] : null;
        const currentFileName = currentFile
            ? (currentFile.filename || ('file ' + cur))
            : (cur === -1 && hasDisasm ? (info.disassemblyTarget || 'Disassembly') : '');
        const currentCode = cur === -1 && hasDisasm
            ? info.disassembly
            : currentFile
                ? (currentFile.contents || '')
                : (info.source || info.disassembly || ('// No source available for ' + activeStage));

        const pipeStage = state.pipeline && state.pipeline.shaders && state.pipeline.shaders[activeStage];
        const shaderResourceId = info.resourceId || (pipeStage && pipeStage.resourceId) || '';
        const shaderResourceKey = String(shaderResourceId || '');
        const shaderLabel = info.name
            || (pipeStage && (pipeStage.programName || pipeStage.shaderName || pipeStage.name))
            || (shaderResourceId ? resName(shaderResourceId) : '');

        const applyBtn = document.createElement('button');
        applyBtn.className = 'icon-btn';
        applyBtn.textContent = 'Apply';
        applyBtn.disabled = !editableStage || state.shaderEditBusy;
        applyBtn.title = editableStage
            ? 'Compile this shader source and apply it only if compilation succeeds'
            : 'This shader stage is not editable';
        applyBtn.addEventListener('click', () => {
            if (!editableStage || state.shaderEditBusy) return;
            state.shaderEditBusy = true;
            state.shaderEditStatusStage = activeStage;
            state.shaderEditStatus = { kind: 'info', message: 'Compiling and applying shader…' };
            renderShaders();
            vscode.postMessage({
                type: 'applyShaderEdit',
                eventId: state.eventId,
                stage: activeStage,
                resourceId: String(info.resourceId || ''),
                shaderStage: typeof info.shaderStage === 'number' ? info.shaderStage : 0,
                sourceEncoding: typeof info.sourceEncoding === 'number' ? info.sourceEncoding : SHADER_ENCODING.Unknown,
                entryPoint: info.entryPoint || 'main',
                entryFileIndex,
                compileFlags: Array.isArray(info.compileFlags) ? info.compileFlags : [],
                files: linkedSourceFiles,
            });
        });
        editorActions.appendChild(applyBtn);

        const revertBtn = document.createElement('button');
        revertBtn.className = 'icon-btn';
        revertBtn.textContent = 'Revert';
        revertBtn.disabled = state.shaderEditBusy || !info.hasReplacement;
        revertBtn.title = info.hasReplacement
            ? 'Remove the applied replacement shader from the current replay session'
            : 'No applied shader replacement is active for this stage';
        revertBtn.addEventListener('click', () => {
            if (state.shaderEditBusy) return;
            if (info.hasReplacement) {
                state.shaderEditBusy = true;
                state.shaderEditStatusStage = activeStage;
                state.shaderEditStatus = { kind: 'info', message: 'Reverting shader replacement…' };
                renderShaders();
                vscode.postMessage({
                    type: 'revertShaderEdit',
                    eventId: state.eventId,
                    stage: activeStage,
                    resourceId: String(info.resourceId || ''),
                });
                return;
            }
        });
        editorActions.appendChild(revertBtn);

        const analyzeBtn = document.createElement('button');
        analyzeBtn.className = 'icon-btn mali-analyze-btn';
        const maliAnalyzeState = getMaliAnalyzeAvailability(
            cur,
            currentCode,
            state.eventId,
            activeStage,
            shaderResourceKey,
            getCurrentMaliDevice(),
        );
        analyzeBtn.classList.toggle('configured', maliAnalyzeState.configured);
        analyzeBtn.classList.toggle('unconfigured', !maliAnalyzeState.configured);
        analyzeBtn.classList.toggle('pending', maliAnalyzeState.pending);
        analyzeBtn.textContent = maliAnalyzeState.pending ? 'Mali Running' : 'Mali Analyze';
        analyzeBtn.title = maliAnalyzeState.title;
        analyzeBtn.addEventListener('click', () => {
            if (!maliAnalyzeState.configured) {
                openMaliOfflineSettings();
                return;
            }
            openMaliAnalysisModal({ autoAnalyze: true });
        });
        analysisActions.appendChild(analyzeBtn);

        fileBar.innerHTML = '';
        const makeTab = (label, idx, isDirty) => {
            const tab = document.createElement('button');
            tab.className = 'stage-tab shader-file-tab' + (idx === cur ? ' active' : '');
            if (isDirty) tab.classList.add('dirty');
            tab.textContent = label;
            tab.title = label;
            tab.addEventListener('click', () => {
                if (idx === state.activeShaderFile[activeStage]) {
                    invalidateShaderEditorSyncKey();
                }
                state.activeShaderFile[activeStage] = idx;
                renderShaders();
            });
            fileBar.appendChild(tab);
            return tab;
        };

        for (let i = 0; i < currentFiles.length; i++) {
            const fn = (currentFiles[i] && currentFiles[i].filename) || ('file ' + i);
            const label = fn + (i === entryFileIndex ? ' *' : '');
            const originalContents = (sourceFiles[i] && sourceFiles[i].contents) || '';
            const currentContents = getShaderDraft(activeStage, i, originalContents);
            makeTab(label, i, currentContents !== originalContents);
        }
        if (hasDisasm) {
            makeTab(info.disassemblyTarget || 'Disassembly', -1, false);
        }
        fileBar.hidden = (currentFiles.length + (hasDisasm ? 1 : 0)) <= 0;

        const resourceText = shaderLabel
            ? (' · ' + shaderLabel)
            : (shaderResourceId ? (' · Resource ' + shaderResourceId) : '');
        const fileCount = currentFiles.length;
        const fileText = currentFileName ? (' · ' + currentFileName) : '';
        const modeText = cur === -1 && hasDisasm
            ? ' · disassembly preview'
            : (editableStage ? ' · linked editor preview' : ' · read-only preview');
        const replacementText = info.hasReplacement ? ' · replacement active' : '';
        const updateShaderPaneMeta = () => {
            if (!shaderPaneMeta) return;
            shaderPaneMeta.textContent = activeStage + ' stage' + resourceText + fileText + ' · ' + fileCount + ' source file' + (fileCount === 1 ? '' : 's') + (hasDisasm ? ' · disassembly available' : '') + modeText + replacementText;
        };
        updateShaderPaneMeta();

        state.shaderEditorContext = {
            eventId: state.eventId,
            resourceId: String(info.resourceId || ''),
            stage: activeStage,
            language: currentLanguage,
            currentCode,
            currentFileName: currentFileName || (activeStage + '-shader'),
            selectedFileIndex: cur,
            files: linkedSourceFiles,
        };

        const diagnosticsSummary = getShaderDiagnosticsSummary(activeStage);
        const dirtyFileCount = getDirtyShaderFileCount(activeStage, sourceFiles);
        const currentMetrics = getShaderTextMetrics(currentCode);
        const aggregateMetrics = currentFiles.length > 0
            ? currentFiles.reduce((acc, file) => {
                const metrics = getShaderTextMetrics((file && file.contents) || '');
                acc.lines += metrics.lines;
                acc.nonEmptyLines += metrics.nonEmptyLines;
                acc.characters += metrics.characters;
                return acc;
            }, { lines: 0, nonEmptyLines: 0, characters: 0 })
            : currentMetrics;
        const shaderModeLabel = cur === -1 && hasDisasm
            ? 'Disassembly Preview'
            : (editableStage ? 'Linked Source' : 'Read-only Source');
        const compileFlagsCount = Array.isArray(info.compileFlags) ? info.compileFlags.length : 0;
        const rawBytesLabel = info.hasRawBytes ? formatByteSize(info.rawBytesSize) : 'Unavailable';
        const entrySourceLabel = info.entrySourceName
            || (sourceFiles[entryFileIndex] && sourceFiles[entryFileIndex].filename)
            || 'Unavailable';
        const shaderDisplayName = shaderLabel || (shaderResourceKey ? ('Resource ' + shaderResourceKey) : (formatShaderStageLabel(activeStage) + ' Stage'));
        const shaderStatus = state.shaderEditStatusStage === activeStage ? state.shaderEditStatus : null;
        const bindingSummary = buildShaderBindingSummary(state.pipeline, activeStage);

        let buildTone = 'neutral';
        let buildTitle = 'Linked editor ready';
        let buildCopy = 'Edit the linked shader file in VS Code, then use Apply here to rebuild the replay session.';
        let buildStatusValue = editableStage ? 'Ready' : 'Read Only';

        if (state.shaderEditBusy && state.shaderEditStatusStage === activeStage) {
            buildTone = 'info';
            buildTitle = 'Shader update in progress';
            buildCopy = (shaderStatus && shaderStatus.message) || 'RenderDoc is compiling the current shader source snapshot.';
            buildStatusValue = 'Running';
        } else if (shaderStatus && shaderStatus.message) {
            if (shaderStatus.kind === 'error') {
                buildTone = 'danger';
                buildTitle = 'Shader compilation failed';
                buildStatusValue = 'Failed';
            } else if (shaderStatus.kind === 'success') {
                buildTone = info.hasReplacement ? 'good' : 'info';
                buildTitle = info.hasReplacement ? 'Replacement shader active' : 'Shader build succeeded';
                buildStatusValue = info.hasReplacement ? 'Applied' : 'Succeeded';
            } else {
                buildTone = 'info';
                buildTitle = 'Shader update in progress';
                buildStatusValue = 'Running';
            }
            buildCopy = shaderStatus.message;
        } else if (diagnosticsSummary.error > 0) {
            buildTone = 'danger';
            buildTitle = 'Diagnostics require attention';
            buildCopy = 'Errors from the latest compile are still attached to this stage. Review the diagnostics list below before applying again.';
            buildStatusValue = 'Issues';
        } else if (info.hasReplacement) {
            buildTone = 'good';
            buildTitle = 'Replacement shader active';
            buildCopy = 'The replay session is currently using an applied replacement for this stage.';
            buildStatusValue = 'Applied';
        } else if (!editableStage) {
            buildTone = 'neutral';
            buildTitle = cur === -1 ? 'Disassembly preview' : 'Read-only shader preview';
            buildCopy = cur === -1
                ? 'This tab shows the selected disassembly target. Switch back to a source file to edit or analyze the shader.'
                : 'This shader stage exposes source as read-only in the current replay context.';
            buildStatusValue = cur === -1 ? 'Disassembly' : 'Read Only';
        } else if (dirtyFileCount > 0) {
            buildTone = 'warn';
            buildTitle = 'Edits pending apply';
            buildCopy = dirtyFileCount + ' source file' + (dirtyFileCount === 1 ? ' differs' : 's differ') + ' from the replay snapshot. Apply to rebuild the current session.';
            buildStatusValue = 'Dirty';
        }

        const selectedMaliDevice = getCurrentMaliDevice();
        const selectedMaliDeviceLabel = getMaliDeviceLabel(selectedMaliDevice);
        const pendingMaliAnalysis = getPendingMaliAnalysisForShader(state.eventId, activeStage, shaderResourceKey, selectedMaliDevice);
        const maliRecord = getShaderMaliAnalysisRecord(state.eventId, activeStage, shaderResourceKey, selectedMaliDevice);
        const maliIsStale = !!(maliRecord && maliRecord.source !== currentCode);
        const maliOutputText = getMaliAnalysisOutputText(maliRecord);
        const maliSummary = maliOutputText ? parseMaliAnalysisSummary(maliOutputText) : { metrics: [], signals: [], highlights: [] };
        const maliOutputLineCount = maliOutputText ? maliOutputText.split(/\r?\n/).length : 0;
        const maliOutputMetrics = maliOutputText
            ? [
                {
                    label: 'Output Lines',
                    value: formatCompactNumber(maliOutputLineCount),
                    meta: 'Verbatim compiler stdout/stderr',
                },
                {
                    label: 'Characters',
                    value: formatCompactNumber(maliOutputText.length),
                    meta: 'Captured report size',
                },
            ]
            : [];

        let analysisTone = 'neutral';
        let analysisTitle = 'Ready to analyze';
        let analysisCopy = 'Run Mali Analyze to populate static performance-oriented findings for this source snapshot.';
        let analysisStatusValue = 'Ready';
        let analysisSnapshotValue = currentFileName || (activeStage + '-shader');
        let analysisPills = [{ text: 'Mali Offline Compiler', tone: 'info' }];
        let analysisLines = [];
        let analysisMetrics = [
            {
                label: 'Status',
                value: analysisStatusValue,
                meta: 'Static source analysis',
            },
            {
                label: 'Device',
                value: selectedMaliDeviceLabel,
                meta: selectedMaliDevice
                    ? 'Selected target GPU profile'
                    : 'Using malioc default device profile',
            },
            {
                label: 'Snapshot',
                value: analysisSnapshotValue,
                meta: currentMetrics.lines > 0 ? (formatCompactNumber(currentMetrics.lines) + ' current lines') : 'No source text loaded',
            },
        ];

        if (!state.maliOfflineCompilerConfigured) {
            analysisTitle = 'Tool not configured';
            analysisCopy = state.maliOfflineCompilerHint || 'Set renderdoc.maliOfflineCompilerPath in VS Code Settings to enable Mali analysis.';
            analysisStatusValue = 'Unavailable';
            analysisPills.push({ text: 'Disabled', tone: 'neutral' });
        } else if (pendingMaliAnalysis) {
            analysisTone = 'info';
            analysisTitle = 'Analysis in progress';
            analysisCopy = 'Mali Offline Compiler is processing the current source snapshot.';
            analysisStatusValue = 'Running';
            analysisSnapshotValue = pendingMaliAnalysis.filename || analysisSnapshotValue;
            analysisPills.push({ text: 'Running', tone: 'info' });
            analysisLines = ['Results will appear in this card when the analysis finishes.'];
        } else if (maliRecord && maliRecord.error) {
            analysisTone = maliIsStale ? 'warn' : 'danger';
            analysisTitle = maliIsStale ? 'Last analysis failed and is stale' : 'Analysis failed';
            analysisCopy = maliIsStale
                ? 'The current source changed after the last failed Mali analysis run. Re-run the tool to refresh the status.'
                : 'Mali Offline Compiler returned an error for the latest source snapshot.';
            analysisStatusValue = maliIsStale ? 'Failed · Stale' : 'Failed';
            analysisSnapshotValue = maliRecord.filename || analysisSnapshotValue;
            analysisPills.push({ text: 'Failed', tone: 'danger' });
            if (maliIsStale) analysisPills.push({ text: 'Stale', tone: 'warn' });
            if (maliSummary.highlights.length === 0) {
                const firstErrorLine = String(maliRecord.error || maliRecord.result || '').split(/\r?\n/).map((line) => normalizeMaliOutputLine(line)).find(Boolean);
                if (firstErrorLine) analysisLines = [firstErrorLine];
            } else {
                analysisLines = maliSummary.highlights;
            }
        } else if (maliRecord) {
            analysisTone = maliIsStale ? 'warn' : 'good';
            analysisTitle = maliIsStale ? 'Analysis is stale' : 'Analysis available';
            analysisCopy = maliIsStale
                ? 'The current source differs from the snapshot that produced the latest Mali findings. Re-run the analysis to refresh them. Full compiler output remains available below.'
                : 'Latest Mali Offline Compiler findings are attached to this source snapshot. Full compiler output is available below.';
            analysisStatusValue = maliIsStale ? 'Stale' : 'Available';
            analysisSnapshotValue = maliRecord.filename || analysisSnapshotValue;
            analysisPills.push({ text: maliIsStale ? 'Stale' : 'Available', tone: maliIsStale ? 'warn' : 'good' });
            analysisLines = maliSummary.highlights.length > 0
                ? maliSummary.highlights
                : ['Full compiler output is available below.'];
        }

        analysisMetrics[0].value = analysisStatusValue;
        analysisMetrics[1].value = selectedMaliDeviceLabel;
        analysisMetrics[2].value = analysisSnapshotValue;
        if (!pendingMaliAnalysis && maliRecord && maliSummary.signals.length > 0) {
            analysisPills = analysisPills.concat(maliSummary.signals);
        }
        if (!pendingMaliAnalysis && maliRecord && maliSummary.metrics.length > 0) {
            analysisMetrics = analysisMetrics.concat(maliSummary.metrics);
        } else {
            analysisMetrics.push({
                label: 'Highlights',
                value: formatCompactNumber(analysisLines.length),
                meta: maliRecord ? 'Summary lines extracted from latest result' : 'Awaiting tool output',
            });
        }

        const shouldShowMaliOutputCard = !!(pendingMaliAnalysis || maliRecord);
        const maliOutputCard = shouldShowMaliOutputCard
            ? renderShaderStatusCard({
                tone: pendingMaliAnalysis
                    ? 'info'
                    : (maliRecord && maliRecord.error)
                        ? (maliIsStale ? 'warn' : 'danger')
                        : (maliIsStale ? 'warn' : 'neutral'),
                className: 'shader-status-card-span-full',
                label: 'Raw Mali Output',
                title: pendingMaliAnalysis
                    ? 'Compiler output pending'
                    : (maliRecord && maliRecord.error)
                        ? 'Compiler error output'
                        : 'Complete compiler report',
                copy: pendingMaliAnalysis
                    ? 'Full stdout/stderr from Mali Offline Compiler will appear here when the current run completes.'
                    : 'This is the verbatim output captured from Mali Offline Compiler for the analyzed shader snapshot.',
                metrics: pendingMaliAnalysis ? [] : maliOutputMetrics,
                preformatted: pendingMaliAnalysis ? 'Waiting for Mali Offline Compiler output…' : (maliOutputText || 'No output captured.'),
            })
            : '';

        body.className = 'shader-editor-panel shader-status-dashboard';
        body.innerHTML = '<div class="shader-status-grid">'
            + renderShaderStatusCard({
                tone: buildTone,
                label: 'Build Health',
                title: buildTitle,
                copy: buildCopy,
                pills: [
                    { text: editableStage ? 'Editable' : 'Read-only', tone: editableStage ? 'good' : 'neutral' },
                    { text: shaderModeLabel, tone: cur === -1 ? 'warn' : 'neutral' },
                    info.hasReplacement ? { text: 'Replacement Active', tone: 'good' } : null,
                    dirtyFileCount > 0 ? { text: dirtyFileCount + ' Dirty', tone: 'warn' } : null,
                ],
                metrics: [
                    {
                        label: 'Status',
                        value: buildStatusValue,
                        meta: formatShaderStageLabel(activeStage) + ' stage',
                    },
                    {
                        label: 'Diagnostics',
                        value: formatCompactNumber(diagnosticsSummary.total),
                        meta: diagnosticsSummary.total > 0
                            ? (diagnosticsSummary.error + ' errors · ' + diagnosticsSummary.warning + ' warnings')
                            : 'No current compile diagnostics',
                    },
                    {
                        label: 'Dirty Files',
                        value: formatCompactNumber(dirtyFileCount),
                        meta: fileCount > 0 ? (fileCount + ' tracked source file' + (fileCount === 1 ? '' : 's')) : 'No source files exposed',
                    },
                    {
                        label: 'Replacement',
                        value: info.hasReplacement ? 'Active' : 'None',
                        meta: 'Session-scoped replay override',
                    },
                ],
            })
            + renderShaderStatusCard({
                tone: 'neutral',
                label: 'Shader Identity',
                title: shaderDisplayName,
                copy: state.drawCall && state.drawCall.name
                    ? ('Bound at EID ' + state.eventId + ' · ' + state.drawCall.name)
                    : 'Bound at the currently focused replay event.',
                pills: [
                    { text: formatShaderStageLabel(activeStage), tone: 'neutral' },
                    { text: formatShaderEncodingLabel(info.sourceEncoding), tone: 'info' },
                    hasDisasm ? { text: 'Disassembly Available', tone: 'warn' } : null,
                    editableStage ? { text: 'Linked Editor', tone: 'good' } : null,
                ],
                kvs: [
                    { label: 'Resource ID', value: shaderResourceKey || 'Unavailable' },
                    { label: 'Entry Point', value: info.entryPoint || 'main' },
                    { label: 'Current Tab', value: currentFileName || 'Unavailable' },
                    { label: 'Entry Source', value: entrySourceLabel },
                    { label: 'Source Files', value: formatCompactNumber(fileCount) },
                    { label: 'Language', value: formatShaderEncodingLabel(info.sourceEncoding) },
                ],
            })
            + renderShaderStatusCard({
                tone: bindingSummary.tone,
                label: 'Reflection & Bindings',
                title: bindingSummary.title,
                copy: bindingSummary.copy,
                pills: bindingSummary.pills,
                metrics: bindingSummary.metrics,
                kvs: bindingSummary.kvs,
                lines: bindingSummary.lines,
            })
            + renderShaderStatusCard({
                tone: 'neutral',
                label: 'Static Complexity',
                title: currentMetrics.lines > 0
                    ? (formatCompactNumber(currentMetrics.lines) + ' lines in current snapshot')
                    : 'No source text loaded',
                copy: cur === -1 && hasDisasm
                    ? 'Metrics below describe the selected disassembly tab. Aggregate totals still cover all exposed source files when available.'
                    : 'Metrics below describe the selected source file. Aggregate totals cover all exposed source files for this stage.',
                metrics: [
                    {
                        label: 'Lines',
                        value: formatCompactNumber(currentMetrics.lines),
                        meta: currentFileName || 'Current selection',
                    },
                    {
                        label: 'Non-Empty',
                        value: formatCompactNumber(currentMetrics.nonEmptyLines),
                        meta: currentMetrics.lines > 0
                            ? (formatOverviewPercent(currentMetrics.nonEmptyLines / Math.max(1, currentMetrics.lines)) + ' populated')
                            : 'No text loaded',
                    },
                    {
                        label: 'Characters',
                        value: formatCompactNumber(currentMetrics.characters),
                        meta: cur === -1 ? 'Disassembly text' : 'Current source file',
                    },
                ],
                kvs: [
                    {
                        label: 'Aggregate Size',
                        value: formatCompactNumber(aggregateMetrics.characters) + ' chars · ' + formatCompactNumber(aggregateMetrics.lines) + ' lines',
                    },
                    { label: 'Compile Flags', value: formatCompactNumber(compileFlagsCount) },
                    { label: 'Raw Bytes', value: rawBytesLabel },
                    { label: 'View Mode', value: shaderModeLabel },
                ],
            })
            + '</div>';

        syncLinkedShaderEditor({
            source: currentCode,
            language: currentLanguage,
            eventId: state.eventId,
            resourceId: String(info.resourceId || ''),
            stage: activeStage,
            filename: currentFileName || (activeStage + '-shader'),
            files: linkedSourceFiles,
            selectedFileIndex: cur,
        });

        renderShaderEditStatus();
        renderShaderDiagnostics();
        if (maliModalEl && !maliModalEl.hidden) {
            renderMaliAnalysisModal();
        }

        const pendingJump = state.shaderDiagnosticJump;
        if (pendingJump && pendingJump.stage === activeStage && pendingJump.fileIndex === cur) {
            state.shaderDiagnosticJump = null;
        }
    }

    // ── Textures ───────────────────────────────────────────────────
    // Current-draw RT preview (top) + grid of Input (sampled) or Output (RT)
    // textures for the currently selected event.
    function renderTextures() {
        renderCurrentRTPreview();
        const body = document.getElementById('textures-body');
        const allTex = state.resources.filter(r => r.type === 'Texture');

        const pipe = state.pipeline || {};
        const fb = effectiveFramebuffer(pipe);
        const outputIds = new Set();
        (fb.colorTargets || []).forEach(id => outputIds.add(String(id)));
        if (fb.depthTarget)   outputIds.add(String(fb.depthTarget));
        if (fb.depthResolveTarget) outputIds.add(String(fb.depthResolveTarget));
        if (fb.stencilTarget) outputIds.add(String(fb.stencilTarget));
        if (fb.copyDestination) outputIds.add(String(fb.copyDestination));
        const inputIds = new Set();
        (pipe.boundTextures || []).forEach(id => inputIds.add(String(id)));

        const scopeIds = state.texScope === 'input' ? inputIds : outputIds;
        let textures = collectScopedTextures(scopeIds, allTex);
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
                    ? 'This draw has no framebuffer, action output, or copy-destination resources.'
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
            requestThumbnail(String(t.resourceId), textureRequestEventId(t.resourceId, 'thumb'));
        }
    }

    // Render the large "current draw output" preview panel on top of the
    // Texture Viewer tab — mirrors RenderDoc's "Cur Output" header image.
    const rtPreviewCache = new Map();   // key → preview payload
    const rtPreviewErrors = new Map();  // key → error message (prevents infinite re-request)
    const rtPreviewPending = new Set(); // key currently in flight
    const CURRENT_RT_PREVIEW_MIN_ZOOM = 0.1;
    const CURRENT_RT_PREVIEW_MAX_ZOOM = 16;
    let currentRTPreviewPan = null;
    let currentRTPreviewZoom = 1;
    function loadTexturesPreviewHeight() {
        try {
            const raw = localStorage.getItem(TEXTURES_SPLIT_STORAGE_KEY);
            if (!raw) return null;
            const parsed = parseFloat(raw);
            return Number.isFinite(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    function saveTexturesPreviewHeight(height) {
        if (!Number.isFinite(height)) return;
        try {
            localStorage.setItem(TEXTURES_SPLIT_STORAGE_KEY, String(height));
        } catch {
            // Ignore storage failures in webview sandboxes.
        }
    }
    function clampTexturesPreviewHeight(height) {
        const splitEl = document.getElementById('textures-split');
        const texCurrentEl = document.getElementById('tex-current');
        if (!splitEl || !texCurrentEl) {
            return Math.max(TEXTURES_PREVIEW_MIN_HEIGHT, height || 0);
        }
        const splitterSize = 4;
        const available = splitEl.clientHeight || splitEl.getBoundingClientRect().height || 0;
        const fallback = Math.max(TEXTURES_PREVIEW_MIN_HEIGHT, texCurrentEl.getBoundingClientRect().height || 260);
        if (available <= 0) {
            return Math.max(TEXTURES_PREVIEW_MIN_HEIGHT, height || fallback);
        }
        const maxHeight = Math.max(TEXTURES_PREVIEW_MIN_HEIGHT, available - splitterSize - TEXTURES_LIST_MIN_HEIGHT);
        const preferred = Number.isFinite(height) ? height : fallback;
        return Math.min(Math.max(TEXTURES_PREVIEW_MIN_HEIGHT, preferred), maxHeight);
    }
    function applyTexturesPreviewHeight(height) {
        const texCurrentEl = document.getElementById('tex-current');
        if (!texCurrentEl) return null;
        const clamped = clampTexturesPreviewHeight(height);
        texCurrentEl.style.flex = '0 0 ' + clamped + 'px';
        return clamped;
    }
    function currentPreviewOverlayLabel(mode) {
        switch (mode) {
            case 'drawcall': return 'Highlight DrawCall';
            case 'wireframe': return 'Wireframe Mesh';
            case 'depth': return 'Depth Test';
            case 'stencil': return 'Stencil Test';
            case 'backfacecull': return 'Backface Cull';
            case 'viewportscissor': return 'Viewport/Scissor Region';
            case 'nan': return 'NaN/INF/-ve Display';
            default: return 'None';
        }
    }
    function rtKeyFor(eventId, channelExtract, overlayMode, baseGammaEnabled, resourceId, overlayResourceId) {
        return 'current-draw:' +
            (eventId || 0) + ':' +
            channelExtract + ':' +
            (overlayMode || 'none') + ':' +
            (baseGammaEnabled ? '1' : '0') + ':' +
            (resourceId || '') + ':' +
            (overlayResourceId || '');
    }
    function getCurrentRTPreviewAreaEl() {
        return document.querySelector('#tex-current .tex-current-preview');
    }
    function getCurrentRTPreviewImageEl() {
        const areaEl = getCurrentRTPreviewAreaEl();
        return areaEl ? areaEl.querySelector('img') : null;
    }
    function getCurrentRTPreviewStageEl() {
        const areaEl = getCurrentRTPreviewAreaEl();
        return areaEl ? areaEl.querySelector('.tex-current-stage') : null;
    }
    function clampCurrentRTPreviewZoom(zoom) {
        return Math.min(Math.max(CURRENT_RT_PREVIEW_MIN_ZOOM, zoom), CURRENT_RT_PREVIEW_MAX_ZOOM);
    }
    function updateCurrentRTPreviewZoomLabel() {
        const btn = document.querySelector('#tex-current .tex-current-zoom-reset');
        if (btn) btn.textContent = Math.round(currentRTPreviewZoom * 100) + '%';
    }
    function getCurrentRTPreviewContentSize() {
        const areaEl = getCurrentRTPreviewAreaEl();
        if (!areaEl) {
            return { width: 1, height: 1 };
        }
        const style = window.getComputedStyle(areaEl);
        const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
        const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
        return {
            width: Math.max(1, areaEl.clientWidth - padX),
            height: Math.max(1, areaEl.clientHeight - padY),
        };
    }
    function stopCurrentRTPreviewPan() {
        if (!currentRTPreviewPan) return;
        const areaEl = currentRTPreviewPan.areaEl;
        try { areaEl.releasePointerCapture(currentRTPreviewPan.pointerId); } catch {}
        currentRTPreviewPan = null;
        areaEl.classList.remove('panning');
        areaEl.removeEventListener('pointermove', onCurrentRTPreviewPan);
        areaEl.removeEventListener('pointerup', stopCurrentRTPreviewPan);
        areaEl.removeEventListener('pointercancel', stopCurrentRTPreviewPan);
    }
    function startCurrentRTPreviewPan(event) {
        const areaEl = event.currentTarget;
        if (!areaEl || event.button !== 0) return;
        if (!getCurrentRTPreviewImageEl()) return;
        if (event.target.closest('.muted')) return;
        stopCurrentRTPreviewPan();
        currentRTPreviewPan = {
            areaEl,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            scrollLeft: areaEl.scrollLeft,
            scrollTop: areaEl.scrollTop,
        };
        areaEl.classList.add('panning');
        areaEl.setPointerCapture(event.pointerId);
        areaEl.addEventListener('pointermove', onCurrentRTPreviewPan);
        areaEl.addEventListener('pointerup', stopCurrentRTPreviewPan);
        areaEl.addEventListener('pointercancel', stopCurrentRTPreviewPan);
        event.preventDefault();
        event.stopPropagation();
    }
    function onCurrentRTPreviewPan(event) {
        if (!currentRTPreviewPan) return;
        const areaEl = currentRTPreviewPan.areaEl;
        areaEl.scrollLeft = currentRTPreviewPan.scrollLeft - (event.clientX - currentRTPreviewPan.startX);
        areaEl.scrollTop = currentRTPreviewPan.scrollTop - (event.clientY - currentRTPreviewPan.startY);
    }
    function updateCurrentRTPreviewImageScale() {
        const areaEl = getCurrentRTPreviewAreaEl();
        const img = getCurrentRTPreviewImageEl();
        const stage = getCurrentRTPreviewStageEl();
        updateCurrentRTPreviewZoomLabel();
        if (!areaEl) return;
        areaEl.classList.remove('has-image');
        if (!img || !img.naturalWidth || !img.naturalHeight) {
            areaEl.title = '';
            return;
        }
        const previewSize = getCurrentRTPreviewContentSize();
        const fitScale = Math.min(
            previewSize.width / img.naturalWidth,
            previewSize.height / img.naturalHeight,
            1,
        );
        const width = Math.max(1, Math.round(img.naturalWidth * fitScale * currentRTPreviewZoom));
        const height = Math.max(1, Math.round(img.naturalHeight * fitScale * currentRTPreviewZoom));
        img.style.width = width + 'px';
        img.style.height = height + 'px';
        if (stage) {
            stage.style.width = Math.max(previewSize.width, width) + 'px';
            stage.style.height = Math.max(previewSize.height, height) + 'px';
        }
        const pannable = areaEl.scrollWidth > areaEl.clientWidth
            || areaEl.scrollHeight > areaEl.clientHeight;
        areaEl.classList.toggle('has-image', pannable);
        areaEl.title = 'Mouse wheel: zoom (' + Math.round(currentRTPreviewZoom * 100) + '%)';
    }
    function setCurrentRTPreviewZoom(nextZoom) {
        const clamped = clampCurrentRTPreviewZoom(nextZoom);
        if (Math.abs(clamped - currentRTPreviewZoom) < 0.0001) {
            updateCurrentRTPreviewZoomLabel();
            return;
        }
        currentRTPreviewZoom = clamped;
        updateCurrentRTPreviewImageScale();
    }
    function resetCurrentRTPreviewView() {
        currentRTPreviewZoom = 1;
        stopCurrentRTPreviewPan();
        const areaEl = getCurrentRTPreviewAreaEl();
        if (areaEl) {
            areaEl.scrollLeft = 0;
            areaEl.scrollTop = 0;
        }
        updateCurrentRTPreviewImageScale();
    }
    function setCurrentRTPreviewChannel(channelExtract) {
        state.currentPreviewChannel = Number.isFinite(channelExtract) ? channelExtract : -1;
        renderCurrentRTPreview();
    }
    function setCurrentRTPreviewOverlay(mode) {
        state.currentPreviewOverlay = typeof mode === 'string' && mode ? mode : 'none';
        renderCurrentRTPreview();
    }
    function toggleCurrentRTPreviewBaseGamma() {
        state.currentPreviewBaseGammaEnabled = !state.currentPreviewBaseGammaEnabled;
        renderCurrentRTPreview();
    }
    window.addEventListener('resize', () => {
        if (state.activeTab === 'textures') {
            applyTexturesPreviewHeight(loadTexturesPreviewHeight());
            updateCurrentRTPreviewImageScale();
        }
    });
    function renderCurrentRTPreview() {
        const area = document.getElementById('tex-current');
        if (!area) return;
        stopCurrentRTPreviewPan();
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
        const overlayMode = state.currentPreviewOverlay || 'none';
        const baseGammaEnabled = state.currentPreviewBaseGammaEnabled !== false;
        const requestedOutput = currentOutputInfo(pipe);
        const requestedOverlayTarget = currentOverlayTargetInfo(pipe);
        const requestedResourceId = requestedOutput && requestedOutput.resourceId ? String(requestedOutput.resourceId) : '';
        const requestedOverlayResourceId = requestedOverlayTarget && requestedOverlayTarget.resourceId
            ? String(requestedOverlayTarget.resourceId)
            : '';
        const key = rtKeyFor(
            state.eventId || 0,
            state.currentPreviewChannel,
            overlayMode,
            baseGammaEnabled,
            requestedResourceId,
            requestedOverlayResourceId,
        );
        const cached = rtPreviewCache.get(key);
        const errMsg = rtPreviewErrors.get(key);
        const gammaAvailable = cached && cached.baseGammaAvailable !== undefined
            ? !!cached.baseGammaAvailable
            : true;
        const gammaEnabled = cached && cached.baseGammaEnabled !== undefined
            ? !!cached.baseGammaEnabled
            : baseGammaEnabled;
        const rtId = cached && cached.resourceId ? String(cached.resourceId) : null;
        const output = requestedOutput;
        const label = (cached && cached.label) || (output && output.label) || 'Current Draw';
        const tex = state.resources.find(r => String(r.resourceId) === String(rtId));
        const name = (tex && tex.name) || (rtId ? ('Resource ' + rtId) : 'Current Draw Preview');
        const fmt = (cached && cached.texFormat) || (tex && tex.format) || '';
        const dim = cached && cached.width ? (cached.width + '×' + cached.height) : (tex && tex.width ? (tex.width + '×' + tex.height) : '');
        const badges = [];
        const channelButtons = [
            { value: -1, label: 'RGBA' },
            { value: 0, label: 'R' },
            { value: 1, label: 'G' },
            { value: 2, label: 'B' },
            { value: 3, label: 'A' },
        ].map(ch =>
            '<button data-ch="' + ch.value + '" class="ch' + (state.currentPreviewChannel === ch.value ? ' active' : '') + '">' + ch.label + '</button>'
        ).join('');
        const overlayOptions = [
            { value: 'none', label: 'None' },
            { value: 'drawcall', label: 'Highlight DrawCall' },
            { value: 'wireframe', label: 'Wireframe Mesh' },
            { value: 'depth', label: 'Depth Test' },
            { value: 'stencil', label: 'Stencil Test' },
            { value: 'backfacecull', label: 'Backface Cull' },
            { value: 'viewportscissor', label: 'Viewport/Scissor Region' },
            { value: 'nan', label: 'NaN/INF/-ve Display' },
        ].map(opt =>
            '<option value="' + opt.value + '"' + (overlayMode === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>'
        ).join('');
        badges.push('<span class="tex-current-meta">replay preview</span>');
        if (overlayMode !== 'none') badges.push('<span class="tex-current-meta">overlay: ' + esc(currentPreviewOverlayLabel(overlayMode)) + '</span>');
        if (gammaAvailable && !gammaEnabled) badges.push('<span class="tex-current-meta">gamma off</span>');
        if (output && output.framebuffer && output.framebuffer.usesActionFallback) badges.push('<span class="tex-current-meta">action fallback</span>');
        if (output && output.framebuffer && output.framebuffer.usesPresentationFallback) badges.push('<span class="tex-current-meta">backbuffer fallback</span>');

        area.className = 'tex-current';
        if (overlayMode !== 'none') area.classList.add('overlay-active');
        let body;
        if (cached && cached.base64) {
            body = '<div class="tex-current-stage"><img src="data:image/png;base64,' + cached.base64 + '" alt="current RT"></div>';
        } else if (errMsg) {
            body =
                '<div class="tex-current-error">' +
                    '<div class="muted" style="font-size:0.85em;">Preview unavailable: ' + esc(errMsg) + '</div>' +
                    '<button class="icon-btn tex-current-retry" type="button">Retry</button>' +
                '</div>';
        } else {
            body = '<div class="muted">Loading…</div>';
        }
        area.innerHTML =
            '<div class="tex-current-header">' +
                '<span class="tex-current-label">' + esc(label) + '</span>' +
                '<span class="tex-current-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
                '<span class="tex-current-meta">' + esc(dim) + ' ' + esc(fmt) + '</span>' +
                badges.join('') +
                '<div class="tex-current-actions">' +
                    '<span class="tex-current-meta tex-current-hint">Wheel: zoom · Drag: pan</span>' +
                    '<div class="channel-toggle tex-current-channel-toggle">' + channelButtons + '</div>' +
                    '<label class="tex-current-overlay-control"><span class="tex-current-meta">Overlay</span><select class="tex-current-overlay-select">' + overlayOptions + '</select></label>' +
                    '<button class="icon-btn tex-current-gamma-toggle' + (gammaEnabled ? ' active' : '') + '" type="button" title="' + esc(gammaAvailable ? 'Override display of linear data in gamma space' : 'Gamma override unavailable for this resource') + '" aria-pressed="' + (gammaEnabled ? 'true' : 'false') + '"' + (gammaAvailable ? '' : ' disabled') + '>y</button>' +
                    '<button class="icon-btn tex-current-zoom-reset" title="Reset zoom and pan">' + Math.round(currentRTPreviewZoom * 100) + '%</button>' +
                    (rtId ? ('<button class="icon-btn tex-current-open" data-resid="' + esc(rtId) + '">Open</button>') : '') +
                '</div>' +
            '</div>' +
            '<div class="tex-current-preview">' + body + '</div>';

        const previewEl = area.querySelector('.tex-current-preview');
        if (previewEl) {
            previewEl.addEventListener('pointerdown', startCurrentRTPreviewPan);
            previewEl.addEventListener('wheel', (event) => {
                if (!getCurrentRTPreviewImageEl()) return;
                event.preventDefault();
                const step = event.deltaY < 0 ? 1.1 : (1 / 1.1);
                setCurrentRTPreviewZoom(currentRTPreviewZoom * step);
            }, { passive: false });
        }
        area.querySelectorAll('.tex-current-channel-toggle .ch').forEach(btn => btn.addEventListener('click', () => {
            setCurrentRTPreviewChannel(parseInt(btn.dataset.ch, 10));
        }));
        const overlaySelect = area.querySelector('.tex-current-overlay-select');
        if (overlaySelect) {
            overlaySelect.addEventListener('change', () => setCurrentRTPreviewOverlay(overlaySelect.value));
        }
        const gammaBtn = area.querySelector('.tex-current-gamma-toggle');
        if (gammaBtn) {
            gammaBtn.addEventListener('click', toggleCurrentRTPreviewBaseGamma);
        }
        const resetBtn = area.querySelector('.tex-current-zoom-reset');
        if (resetBtn) resetBtn.addEventListener('click', resetCurrentRTPreviewView);
        const retryBtn = area.querySelector('.tex-current-retry');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                rtPreviewErrors.delete(key);
                rtPreviewPending.delete(key);
                rtPreviewCache.delete(key);
                renderCurrentRTPreview();
            });
        }
        const btn = area.querySelector('.tex-current-open');
        if (btn) btn.addEventListener('click', () => openTextureModal(String(rtId)));
        const img = getCurrentRTPreviewImageEl();
        if (img) {
            img.addEventListener('load', updateCurrentRTPreviewImageScale, { once: true });
            if (img.complete) {
                updateCurrentRTPreviewImageScale();
            }
        } else {
            updateCurrentRTPreviewImageScale();
        }

        if (!cached && !errMsg && !rtPreviewPending.has(key)) {
            rtPreviewPending.add(key);
            vscode.postMessage({
                type: 'requestCurrentDrawPreview',
                eventId: state.eventId || 0,
                channelExtract: state.currentPreviewChannel,
                overlayMode: overlayMode,
                baseGammaEnabled: baseGammaEnabled,
                resourceId: requestedResourceId || undefined,
                overlayResourceId: requestedOverlayResourceId || undefined,
                label: overlayMode !== 'none'
                    ? ((requestedOverlayTarget && requestedOverlayTarget.label) || label)
                    : label,
            });
        }
    }

    function handleCurrentDrawPreview(m) {
        if (!m || !m.key) return;
        rtPreviewPending.delete(m.key);
        if (!m.error && m.base64) {
            rtPreviewCache.set(m.key, {
                base64: m.base64,
                width: m.width,
                height: m.height,
                texFormat: m.texFormat,
                resourceId: m.resourceId,
                label: m.label,
                overlayMode: m.overlayMode,
            });
            rtPreviewErrors.delete(m.key);
        } else if (m.error) {
            rtPreviewErrors.set(m.key, m.error);
        }
        if (state.activeTab === 'textures') renderCurrentRTPreview();
    }

    // Thumbnail management ──────────────────────────────────────
    // Thumbnails are keyed by resource + event so draw-scoped inputs/outputs
    // don't reuse stale images from a previous draw when the same resource ID
    // is visible across multiple events.
    const thumbCache = new Map();       // key → base64 PNG
    const thumbErrors = new Map();      // key → error string
    const thumbPending = new Set();     // key currently in flight
    function thumbKey(resId, eventId) {
        return String(resId) + ':0:' + (eventId || 0) + ':-1:thumb';
    }
    function bindThumbnailRequest(resId, key) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return null;
        card.dataset.thumbKey = key;
        return card;
    }
    function requestThumbnail(resId, eventId = 0) {
        const key = thumbKey(resId, eventId);
        bindThumbnailRequest(resId, key);
        if (thumbCache.has(key)) {
            applyThumbnail(resId, key, thumbCache.get(key));
            return;
        }
        if (thumbErrors.has(key)) {
            applyThumbnailError(resId, key, thumbErrors.get(key));
            return;
        }
        if (thumbPending.has(key)) return;
        thumbPending.add(key);
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: resId,
            mip: 0,
            eventId: eventId,
            channelExtract: -1,
            purpose: 'thumb',
        });
    }
    function applyThumbnail(resId, key, base64) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        if (card.dataset.thumbKey !== key) return;
        card.innerHTML = '<img src="data:image/png;base64,' + base64 + '" alt="thumbnail">';
    }
    function applyThumbnailError(resId, key, errMsg) {
        const card = document.querySelector('.tex-card[data-resid="' + CSS.escape(String(resId)) + '"] .thumb');
        if (!card) return;
        if (card.dataset.thumbKey !== key) return;
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
    const TEXTURE_MODAL_STORAGE_KEY = 'renderdoc.textureModalBounds';
    const TEXTURE_MODAL_MIN_WIDTH = 520;
    const TEXTURE_MODAL_MIN_HEIGHT = 360;
    const TEXTURE_MODAL_MIN_ZOOM = 0.1;
    const TEXTURE_MODAL_MAX_ZOOM = 16;
    const textureModalEl = document.getElementById('texture-modal');
    const textureModalPanelEl = textureModalEl.querySelector('.modal-panel');
    const textureModalHeaderEl = textureModalPanelEl.querySelector('.modal-header');
    const textureModalResizeEl = textureModalPanelEl.querySelector('.modal-resize-handle');
    const textureModalPreviewEl = document.getElementById('tex-modal-preview');
    let textureModalDrag = null;
    let textureModalResize = null;
    let textureModalPan = null;
    let textureModalZoom = 1;

    function loadTextureModalBounds() {
        try {
            const raw = localStorage.getItem(TEXTURE_MODAL_STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function saveTextureModalBounds() {
        const style = textureModalPanelEl.style;
        const left = parseFloat(style.left);
        const top = parseFloat(style.top);
        const width = parseFloat(style.width);
        const height = parseFloat(style.height);
        if (![left, top, width, height].every(Number.isFinite)) return;
        try {
            localStorage.setItem(TEXTURE_MODAL_STORAGE_KEY, JSON.stringify({ left, top, width, height }));
        } catch {
            // Ignore storage failures in webview sandboxes.
        }
    }

    function clampTextureModalSize(width, height, left, top) {
        const maxWidth = Math.max(TEXTURE_MODAL_MIN_WIDTH, textureModalEl.clientWidth - left);
        const maxHeight = Math.max(TEXTURE_MODAL_MIN_HEIGHT, textureModalEl.clientHeight - top);
        return {
            width: Math.min(Math.max(TEXTURE_MODAL_MIN_WIDTH, width), maxWidth),
            height: Math.min(Math.max(TEXTURE_MODAL_MIN_HEIGHT, height), maxHeight),
        };
    }

    function clampTextureModalPosition(left, top) {
        const maxLeft = Math.max(0, textureModalEl.clientWidth - textureModalPanelEl.offsetWidth);
        const maxTop = Math.max(0, textureModalEl.clientHeight - textureModalPanelEl.offsetHeight);
        return {
            left: Math.min(Math.max(0, left), maxLeft),
            top: Math.min(Math.max(0, top), maxTop),
        };
    }

    function clampTextureModalZoom(zoom) {
        return Math.min(Math.max(TEXTURE_MODAL_MIN_ZOOM, zoom), TEXTURE_MODAL_MAX_ZOOM);
    }

    function getTextureModalImageEl() {
        return textureModalPreviewEl.querySelector('img');
    }

    function getTextureModalStageEl() {
        return textureModalPreviewEl.querySelector('.tex-preview-stage');
    }

    function stopTextureModalPan() {
        if (!textureModalPan) return;
        try { textureModalPreviewEl.releasePointerCapture(textureModalPan.pointerId); } catch {}
        textureModalPan = null;
        textureModalPreviewEl.classList.remove('panning');
        textureModalPreviewEl.removeEventListener('pointermove', onTextureModalPan);
        textureModalPreviewEl.removeEventListener('pointerup', stopTextureModalPan);
        textureModalPreviewEl.removeEventListener('pointercancel', stopTextureModalPan);
    }

    function startTextureModalPan(event) {
        if (event.button !== 0) return;
        if (!getTextureModalImageEl()) return;
        if (event.target.closest('.muted')) return;
        stopTextureModalDrag();
        stopTextureModalResize();
        textureModalPan = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            scrollLeft: textureModalPreviewEl.scrollLeft,
            scrollTop: textureModalPreviewEl.scrollTop,
        };
        textureModalPreviewEl.classList.add('panning');
        textureModalPreviewEl.setPointerCapture(event.pointerId);
        textureModalPreviewEl.addEventListener('pointermove', onTextureModalPan);
        textureModalPreviewEl.addEventListener('pointerup', stopTextureModalPan);
        textureModalPreviewEl.addEventListener('pointercancel', stopTextureModalPan);
        event.preventDefault();
        event.stopPropagation();
    }

    function onTextureModalPan(event) {
        if (!textureModalPan) return;
        textureModalPreviewEl.scrollLeft = textureModalPan.scrollLeft - (event.clientX - textureModalPan.startX);
        textureModalPreviewEl.scrollTop = textureModalPan.scrollTop - (event.clientY - textureModalPan.startY);
    }

    function getTextureModalPreviewContentSize() {
        const style = window.getComputedStyle(textureModalPreviewEl);
        const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
        const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
        return {
            width: Math.max(1, textureModalPreviewEl.clientWidth - padX),
            height: Math.max(1, textureModalPreviewEl.clientHeight - padY),
        };
    }

    function updateTextureModalImageScale() {
        const img = getTextureModalImageEl();
        const stage = getTextureModalStageEl();
        textureModalPreviewEl.classList.toggle('has-image', !!img);
        if (!img || !img.naturalWidth || !img.naturalHeight) return;
        const previewSize = getTextureModalPreviewContentSize();
        const fitScale = Math.min(
            previewSize.width / img.naturalWidth,
            previewSize.height / img.naturalHeight,
            1,
        );
        const width = Math.max(1, Math.round(img.naturalWidth * fitScale * textureModalZoom));
        const height = Math.max(1, Math.round(img.naturalHeight * fitScale * textureModalZoom));
        img.style.width = width + 'px';
        img.style.height = height + 'px';
        if (stage) {
            stage.style.width = Math.max(previewSize.width, width) + 'px';
            stage.style.height = Math.max(previewSize.height, height) + 'px';
        }
        const pannable = textureModalPreviewEl.scrollWidth > textureModalPreviewEl.clientWidth
            || textureModalPreviewEl.scrollHeight > textureModalPreviewEl.clientHeight;
        textureModalPreviewEl.classList.toggle('has-image', pannable);
        textureModalPreviewEl.title = 'Mouse wheel: zoom (' + Math.round(textureModalZoom * 100) + '%)';
    }

    function setTextureModalZoom(nextZoom) {
        const clamped = clampTextureModalZoom(nextZoom);
        if (Math.abs(clamped - textureModalZoom) < 0.0001) return;
        textureModalZoom = clamped;
        updateTextureModalImageScale();
    }

    function resetTextureModalZoom() {
        textureModalZoom = 1;
        updateTextureModalImageScale();
        textureModalPreviewEl.scrollLeft = 0;
        textureModalPreviewEl.scrollTop = 0;
    }

    function centerTextureModal() {
        textureModalPanelEl.style.left = '50%';
        textureModalPanelEl.style.top = '50%';
        textureModalPanelEl.style.transform = 'translate(-50%, -50%)';
        textureModalPanelEl.style.width = '';
        textureModalPanelEl.style.height = '';
    }

    function applyTextureModalBounds(bounds) {
        if (!bounds) {
            centerTextureModal();
            return false;
        }
        const safeLeft = Number.isFinite(bounds.left) ? bounds.left : 0;
        const safeTop = Number.isFinite(bounds.top) ? bounds.top : 0;
        const safeWidth = Number.isFinite(bounds.width) ? bounds.width : textureModalPanelEl.offsetWidth;
        const safeHeight = Number.isFinite(bounds.height) ? bounds.height : textureModalPanelEl.offsetHeight;
        const clampedPos = clampTextureModalPosition(safeLeft, safeTop);
        const clampedSize = clampTextureModalSize(safeWidth, safeHeight, clampedPos.left, clampedPos.top);
        textureModalPanelEl.style.transform = 'none';
        textureModalPanelEl.style.left = clampedPos.left + 'px';
        textureModalPanelEl.style.top = clampedPos.top + 'px';
        textureModalPanelEl.style.width = clampedSize.width + 'px';
        textureModalPanelEl.style.height = clampedSize.height + 'px';
        return true;
    }

    function startTextureModalDrag(event) {
        if (event.button !== 0) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        stopTextureModalPan();
        stopTextureModalResize();
        const rect = textureModalPanelEl.getBoundingClientRect();
        textureModalDrag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
        };
        textureModalPanelEl.style.transform = 'none';
        textureModalPanelEl.style.left = rect.left + 'px';
        textureModalPanelEl.style.top = rect.top + 'px';
        textureModalPanelEl.classList.add('dragging');
        textureModalHeaderEl.setPointerCapture(event.pointerId);
        textureModalHeaderEl.addEventListener('pointermove', onTextureModalDrag);
        textureModalHeaderEl.addEventListener('pointerup', stopTextureModalDrag);
        textureModalHeaderEl.addEventListener('pointercancel', stopTextureModalDrag);
        event.preventDefault();
        event.stopPropagation();
    }

    function onTextureModalDrag(event) {
        if (!textureModalDrag) return;
        const next = clampTextureModalPosition(
            event.clientX - textureModalDrag.offsetX,
            event.clientY - textureModalDrag.offsetY,
        );
        textureModalPanelEl.style.left = next.left + 'px';
        textureModalPanelEl.style.top = next.top + 'px';
    }

    function stopTextureModalDrag() {
        if (!textureModalDrag) return;
        try { textureModalHeaderEl.releasePointerCapture(textureModalDrag.pointerId); } catch {}
        textureModalDrag = null;
        textureModalPanelEl.classList.remove('dragging');
        textureModalHeaderEl.removeEventListener('pointermove', onTextureModalDrag);
        textureModalHeaderEl.removeEventListener('pointerup', stopTextureModalDrag);
        textureModalHeaderEl.removeEventListener('pointercancel', stopTextureModalDrag);
        saveTextureModalBounds();
    }

    function startTextureModalResize(event) {
        if (event.button !== 0) return;
        stopTextureModalDrag();
        stopTextureModalPan();
        const rect = textureModalPanelEl.getBoundingClientRect();
        textureModalResize = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startWidth: rect.width,
            startHeight: rect.height,
            left: rect.left,
            top: rect.top,
        };
        textureModalPanelEl.style.transform = 'none';
        textureModalPanelEl.style.left = rect.left + 'px';
        textureModalPanelEl.style.top = rect.top + 'px';
        textureModalPanelEl.style.width = rect.width + 'px';
        textureModalPanelEl.style.height = rect.height + 'px';
        textureModalPanelEl.classList.add('resizing');
        if (textureModalResizeEl) {
            textureModalResizeEl.setPointerCapture(event.pointerId);
            textureModalResizeEl.addEventListener('pointermove', onTextureModalResize);
            textureModalResizeEl.addEventListener('pointerup', stopTextureModalResize);
            textureModalResizeEl.addEventListener('pointercancel', stopTextureModalResize);
        }
        event.preventDefault();
        event.stopPropagation();
    }

    function onTextureModalResize(event) {
        if (!textureModalResize) return;
        const rawWidth = textureModalResize.startWidth + (event.clientX - textureModalResize.startX);
        const rawHeight = textureModalResize.startHeight + (event.clientY - textureModalResize.startY);
        const next = clampTextureModalSize(rawWidth, rawHeight, textureModalResize.left, textureModalResize.top);
        textureModalPanelEl.style.width = next.width + 'px';
        textureModalPanelEl.style.height = next.height + 'px';
    }

    function stopTextureModalResize() {
        if (!textureModalResize) return;
        if (textureModalResizeEl) {
            try { textureModalResizeEl.releasePointerCapture(textureModalResize.pointerId); } catch {}
        }
        textureModalResize = null;
        textureModalPanelEl.classList.remove('resizing');
        if (textureModalResizeEl) {
            textureModalResizeEl.removeEventListener('pointermove', onTextureModalResize);
            textureModalResizeEl.removeEventListener('pointerup', stopTextureModalResize);
            textureModalResizeEl.removeEventListener('pointercancel', stopTextureModalResize);
        }
        saveTextureModalBounds();
    }

    function openTextureModal(resId) {
        const tex = state.resources.find(r => r.resourceId === resId) || textureResourceById(resId);
        if (!tex) return;
        state.modalResource = tex;
        state.modalChannel = -1;
        textureModalZoom = 1;
        document.getElementById('tex-modal-title').textContent = tex.name || 'Texture ' + resId;
        const subtitle = document.getElementById('tex-modal-subtitle');
        if (subtitle) {
            subtitle.textContent = (tex.format || 'Unknown format') + ' · ' + (tex.width || 0) + ' × ' + (tex.height || 0) + ' · Resource ' + resId;
        }
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
        textureModalEl.hidden = false;
        if (!textureModalPanelEl.dataset.positioned) {
            applyTextureModalBounds(loadTextureModalBounds());
            textureModalPanelEl.dataset.positioned = 'true';
        }
        requestTexture();
    }

    function findShaderStageByResourceId(resId) {
        const shaders = state.shaders && state.shaders.shaders;
        if (!shaders) return null;
        const target = String(resId);
        for (const [stage, info] of Object.entries(shaders)) {
            if (String(info && info.resourceId) === target) return stage;
        }
        return null;
    }

    function handleResourceActivation(resource) {
        if (!resource || !resource.resourceId) return;
        if (resource.type === 'Texture') {
            openTextureModal(String(resource.resourceId));
            return;
        }
        if (resource.type === 'Shader') {
            const stage = findShaderStageByResourceId(resource.resourceId);
            if (stage) {
                state.activeShaderStage = stage;
                switchTab('shaders');
                return;
            }
            vscode.postMessage({
                type: 'showShaderSource',
                resourceId: String(resource.resourceId),
                label: resourceDisplayName(resource),
            });
            return;
        }
        vscode.postMessage({
            type: 'showResourceDetails',
            resourceId: String(resource.resourceId),
            label: resourceDisplayName(resource) || (resource.type + ' ' + resource.resourceId),
        });
    }

    function requestTexture() {
        if (!state.modalResource) return;
        const eventId = textureRequestEventId(state.modalResource.resourceId, 'modal');
        vscode.postMessage({
            type: 'requestTexture',
            resourceId: state.modalResource.resourceId,
            mip: 0,
            eventId: eventId,
            channelExtract: state.modalChannel,
            purpose: 'modal',
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
        if (typeof m.key === 'string' && m.key.endsWith(':thumb')) {
            if (thumbPending.has(m.key)) {
                thumbPending.delete(m.key);
            }
            const resId = m.key.split(':')[0];
            if (m.error) {
                thumbErrors.set(m.key, m.error);
                applyThumbnailError(resId, m.key, m.error);
            } else if (m.base64) {
                thumbErrors.delete(m.key);
                thumbCache.set(m.key, m.base64);
                applyThumbnail(resId, m.key, m.base64);
            }
            // A thumbnail load does NOT block the modal; if the user also
            // happens to have the modal open for the same key, fall through.
            if (!state.modalResource || state.modalResource.resourceId !== resId || state.modalChannel !== -1) {
                return;
            }
        }
        if (!state.modalResource) return;
        const expectedEventId = textureRequestEventId(state.modalResource.resourceId, 'modal');
        const expectedKey = state.modalResource.resourceId + ':0:' + expectedEventId + ':' + state.modalChannel + ':modal';
        if (m.key !== expectedKey) return;
        if (m.error) {
            textureModalPreviewEl.innerHTML = '<div class="muted">Error: ' + esc(m.error) + '</div>';
            return;
        }
        textureModalPreviewEl.innerHTML = '<div class="tex-preview-stage"><img src="data:image/png;base64,' + m.base64 + '" alt="texture preview"></div>';
        const img = getTextureModalImageEl();
        if (!img) return;
        img.addEventListener('load', () => {
            updateTextureModalImageScale();
            textureModalPreviewEl.scrollLeft = 0;
            textureModalPreviewEl.scrollTop = 0;
        }, { once: true });
        if (img.complete) {
            updateTextureModalImageScale();
        }
    }
    function closeTextureModal() {
        stopTextureModalDrag();
        stopTextureModalResize();
        stopTextureModalPan();
        saveTextureModalBounds();
        textureModalEl.hidden = true;
        state.modalResource = null;
    }

    textureModalHeaderEl.addEventListener('pointerdown', startTextureModalDrag);
    if (textureModalResizeEl) {
        textureModalResizeEl.addEventListener('pointerdown', startTextureModalResize);
    }
    textureModalPreviewEl.addEventListener('pointerdown', startTextureModalPan);
    textureModalPreviewEl.addEventListener('wheel', (event) => {
        if (!getTextureModalImageEl()) return;
        event.preventDefault();
        const step = event.deltaY < 0 ? 1.1 : (1 / 1.1);
        setTextureModalZoom(textureModalZoom * step);
    }, { passive: false });
    window.addEventListener('resize', () => {
        if (textureModalEl.hidden) return;
        if (textureModalPanelEl.style.transform) {
            centerTextureModal();
            updateTextureModalImageScale();
            return;
        }
        const nextPos = clampTextureModalPosition(
            parseFloat(textureModalPanelEl.style.left || '0'),
            parseFloat(textureModalPanelEl.style.top || '0'),
        );
        const nextSize = clampTextureModalSize(
            parseFloat(textureModalPanelEl.style.width || textureModalPanelEl.offsetWidth),
            parseFloat(textureModalPanelEl.style.height || textureModalPanelEl.offsetHeight),
            nextPos.left,
            nextPos.top,
        );
        textureModalPanelEl.style.left = nextPos.left + 'px';
        textureModalPanelEl.style.top = nextPos.top + 'px';
        textureModalPanelEl.style.width = nextSize.width + 'px';
        textureModalPanelEl.style.height = nextSize.height + 'px';
        updateTextureModalImageScale();
        saveTextureModalBounds();
    });

    document.getElementById('tex-modal-close').addEventListener('click', closeTextureModal);
    document.querySelector('#texture-modal .modal-backdrop').addEventListener('click', closeTextureModal);
    document.querySelectorAll('#channel-toggle .ch').forEach(b => b.addEventListener('click', () => {
        state.modalChannel = parseInt(b.dataset.ch, 10);
        document.querySelectorAll('#channel-toggle .ch').forEach(x => x.classList.toggle('active', x === b));
        requestTexture();
    }));
    document.getElementById('tex-modal-export').addEventListener('click', () => {
        if (state.modalResource) vscode.postMessage({ type: 'exportTexture', resourceId: state.modalResource.resourceId, label: state.modalResource.name });
    });

    // ── Mali analysis modal ───────────────────────────────────────
    const maliModalEl = document.getElementById('mali-modal');
    const maliModalBodyEl = document.getElementById('mali-modal-body');
    const maliModalTitleEl = document.getElementById('mali-modal-title');
    const maliModalSubtitleEl = document.getElementById('mali-modal-subtitle');
    const maliModalSettingsEl = document.getElementById('mali-modal-settings');
    const maliModalRerunEl = document.getElementById('mali-modal-rerun');
    const maliModalDeviceSelectEl = document.getElementById('mali-modal-device');

    function closeMaliAnalysisModal() {
        if (!maliModalEl) return;
        maliModalEl.hidden = true;
    }

    function renderMaliAnalysisModal() {
        if (!maliModalEl || maliModalEl.hidden) return;

        const presentation = buildMaliAnalysisPresentation(getActiveMaliAnalysisContext());
        const context = presentation.context;
        const selectedDeviceLabel = getMaliDeviceLabel(context ? context.device : getCurrentMaliDevice());

        if (maliModalTitleEl) {
            maliModalTitleEl.textContent = 'Mali Offline Compiler';
        }
        if (maliModalSubtitleEl) {
            maliModalSubtitleEl.textContent = context
                ? [
                    formatShaderStageLabel(context.stage),
                    context.filename,
                    context.resourceId ? ('Resource ' + context.resourceId) : '',
                    context.eventId != null ? ('EID ' + context.eventId) : '',
                    selectedDeviceLabel,
                ].filter(Boolean).join(' · ')
                : ('Static shader analysis for the currently selected shader source snapshot. Device: ' + selectedDeviceLabel + '.');
        }
        if (maliModalDeviceSelectEl) {
            maliModalDeviceSelectEl.value = getCurrentMaliDevice();
            maliModalDeviceSelectEl.disabled = !!state.pendingMaliAnalysis;
            maliModalDeviceSelectEl.title = getCurrentMaliDevice()
                ? ('Analyze for ' + getCurrentMaliDevice())
                : 'Use malioc default device profile';
        }
        if (maliModalSettingsEl) {
            maliModalSettingsEl.textContent = presentation.availability.configured ? 'Configure Path' : 'Set Path';
            maliModalSettingsEl.title = state.maliOfflineCompilerHint || 'Open the renderdoc.maliOfflineCompilerPath setting.';
        }
        if (maliModalRerunEl) {
            maliModalRerunEl.textContent = presentation.pendingMaliAnalysis
                ? 'Running…'
                : (presentation.maliRecord ? 'Re-run Analysis' : 'Run Analysis');
            maliModalRerunEl.disabled = !presentation.availability.configured
                || !presentation.availability.canAnalyze
                || !!presentation.availability.busy;
            maliModalRerunEl.title = presentation.pendingMaliAnalysis
                ? 'Mali Offline Compiler analysis is already running for this shader stage.'
                : presentation.availability.busy
                    ? 'Wait for the current Mali Offline Compiler run to finish before starting another one.'
                : (presentation.availability.canAnalyze
                    ? 'Run Mali Offline Compiler on the current shader source snapshot.'
                    : (presentation.availability.reason || 'Mali analysis is unavailable for the current selection.'));
        }
        if (maliModalBodyEl) {
            maliModalBodyEl.innerHTML = '<div class="mali-modal-grid">'
                + renderShaderStatusCard({
                    tone: presentation.analysisTone,
                    label: 'Analysis Summary',
                    title: presentation.analysisTitle,
                    copy: presentation.analysisCopy,
                    pills: presentation.analysisPills,
                    metrics: presentation.analysisMetrics,
                    lines: presentation.analysisLines,
                })
                + renderShaderStatusCard({
                    tone: presentation.outputTone,
                    className: 'mali-modal-output-card',
                    label: 'Raw Mali Output',
                    title: presentation.outputTitle,
                    copy: presentation.outputCopy,
                    metrics: presentation.outputMetrics,
                    preformatted: presentation.outputText,
                })
                + '</div>';
        }
    }

    function openMaliAnalysisModal(options) {
        if (!state.maliOfflineCompilerConfigured) {
            openMaliOfflineSettings();
            return;
        }

        if (maliModalEl) {
            maliModalEl.hidden = false;
        }
        renderMaliAnalysisModal();

        if (options && options.autoAnalyze) {
            const presentation = buildMaliAnalysisPresentation(getActiveMaliAnalysisContext());
            if (shouldAutoRunMaliAnalysis(presentation)) {
                startMaliAnalysisForContext(presentation.context);
            }
        }
    }

    if (maliModalSettingsEl) {
        maliModalSettingsEl.addEventListener('click', openMaliOfflineSettings);
    }
    if (maliModalDeviceSelectEl) {
        state.maliSelectedDevice = String(maliModalDeviceSelectEl.value || '').trim();
        maliModalDeviceSelectEl.addEventListener('change', () => {
            state.maliSelectedDevice = String(maliModalDeviceSelectEl.value || '').trim();
            if (state.activeTab === 'shaders') {
                renderShaders();
            }
            if (maliModalEl && !maliModalEl.hidden) {
                renderMaliAnalysisModal();
            }
        });
    }
    if (maliModalRerunEl) {
        maliModalRerunEl.addEventListener('click', () => {
            const presentation = buildMaliAnalysisPresentation(getActiveMaliAnalysisContext());
            if (!presentation.availability.configured) {
                openMaliOfflineSettings();
                return;
            }
            if (presentation.context) {
                startMaliAnalysisForContext(presentation.context);
            }
        });
    }
    document.getElementById('mali-modal-close').addEventListener('click', closeMaliAnalysisModal);
    document.querySelector('#mali-modal .modal-backdrop').addEventListener('click', closeMaliAnalysisModal);

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
                resourceDisplayName(r).toLowerCase().includes(f) ||
                String(r.resourceId).includes(f) ||
                ((r.shaderStages || []).join(' ').toLowerCase().includes(f)) ||
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
            + '<th>Type</th><th>Stage</th><th>ID</th><th>Name</th><th>Format</th><th>Size</th><th>Bytes</th>'
            + '</tr></thead><tbody>';
        for (const r of list) {
            const dim = (r.width && r.height)
                ? (r.width + '\u00d7' + r.height + (r.depth > 1 ? ('\u00d7' + r.depth) : ''))
                : '';
            const stageLabel = (r.shaderStages && r.shaderStages.length > 0) ? r.shaderStages.join(' / ') : '';
            html += '<tr class="res-row" data-type="' + esc(r.type) + '" data-resid="' + esc(r.resourceId) + '">'
                + '<td>' + esc(r.type || '') + '</td>'
                + '<td>' + esc(stageLabel) + '</td>'
                + '<td class="mono">' + esc(r.resourceId) + '</td>'
                + '<td>' + esc(resourceDisplayName(r)) + '</td>'
                + '<td>' + esc(r.format || '') + '</td>'
                + '<td>' + esc(dim) + '</td>'
                + '<td class="mono">' + esc(r.byteSize != null ? r.byteSize : '') + '</td>'
                + '</tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
        body.querySelectorAll('.res-row').forEach(el => {
            el.addEventListener('click', () => {
                const resource = all.find(r => String(r.resourceId) === String(el.dataset.resid));
                if (resource) handleResourceActivation(resource);
            });
        });
    }

    // ── Render dispatch ────────────────────────────────────────────
    function render() {
        if (state.activeTab === 'overview') renderOverview();
        else if (state.activeTab === 'pipeline') renderPipeline();
        else if (state.activeTab === 'pipelinegraph') renderPipelineGraph();
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
            if (state.activeTab === 'pipelinegraph') applyPipelineGraphTransform();
        });

        // PipelineGraph zoom/pan controls.
        const pgViewport = document.getElementById('pipeline-graph-viewport');
        const pgZoomIn = document.getElementById('pg-zoom-in');
        const pgZoomOut = document.getElementById('pg-zoom-out');
        const pgZoomReset = document.getElementById('pg-zoom-reset');
        const pgZoomFit = document.getElementById('pg-zoom-fit');
        if (pgZoomIn) pgZoomIn.addEventListener('click', () => setPipelineGraphZoom(state.graphZoom * 1.15));
        if (pgZoomOut) pgZoomOut.addEventListener('click', () => setPipelineGraphZoom(state.graphZoom / 1.15));
        if (pgZoomReset) pgZoomReset.addEventListener('click', () => setPipelineGraphZoom(1, { x: 0, y: 0 }));
        if (pgZoomFit) pgZoomFit.addEventListener('click', () => fitPipelineGraphToWidth());
        if (pgViewport) {
            pgViewport.addEventListener('wheel', (e) => {
                if (state.activeTab !== 'pipelinegraph') return;
                e.preventDefault();
                const rect = pgViewport.getBoundingClientRect();
                const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
                setPipelineGraphZoom(state.graphZoom * factor, anchor);
            }, { passive: false });

            let draggingGraph = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragScrollLeft = 0;
            let dragScrollTop = 0;
            pgViewport.addEventListener('pointerdown', (e) => {
                if (state.activeTab !== 'pipelinegraph') return;
                draggingGraph = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragScrollLeft = pgViewport.scrollLeft;
                dragScrollTop = pgViewport.scrollTop;
                pgViewport.classList.add('dragging');
                pgViewport.setPointerCapture(e.pointerId);
            });
            pgViewport.addEventListener('pointermove', (e) => {
                if (!draggingGraph) return;
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;
                pgViewport.scrollLeft = dragScrollLeft - dx;
                pgViewport.scrollTop = dragScrollTop - dy;
            });
            const stopGraphDrag = (e) => {
                if (!draggingGraph) return;
                draggingGraph = false;
                pgViewport.classList.remove('dragging');
                try { pgViewport.releasePointerCapture(e.pointerId); } catch {}
            };
            pgViewport.addEventListener('pointerup', stopGraphDrag);
            pgViewport.addEventListener('pointercancel', stopGraphDrag);
        }
        updatePipelineGraphZoomUi();

        // Mesh View Splitter
        const meshSplitter = document.getElementById('mesh-splitter');
        const meshPreviewPaneEl = document.getElementById('mesh-preview-pane');
        if (meshSplitter && meshPreviewPaneEl) {
            let isDraggingSplitter = false;
            let startY = 0;
            let startHeight = 0;

            meshSplitter.addEventListener('pointerdown', (e) => {
                isDraggingSplitter = true;
                startY = e.clientY;
                startHeight = meshPreviewPaneEl.getBoundingClientRect().height;
                meshSplitter.classList.add('dragging');
                meshSplitter.setPointerCapture(e.pointerId);
                e.preventDefault();
            });

            meshSplitter.addEventListener('pointermove', (e) => {
                if (!isDraggingSplitter) return;
                const dy = startY - e.clientY; // invert because preview is at bottom
                const newHeight = Math.max(100, Math.min(window.innerHeight - 150, startHeight + dy));
                meshPreviewPaneEl.style.flex = `0 0 ${newHeight}px`;
                if (state.activeTab === 'mesh') {
                    // Small delay to allow DOM to layout before updating canvas size
                    requestAnimationFrame(() => renderMeshPreview());
                }
            });

            meshSplitter.addEventListener('pointerup', (e) => {
                isDraggingSplitter = false;
                meshSplitter.classList.remove('dragging');
                try { meshSplitter.releasePointerCapture(e.pointerId); } catch {}
            });
        }

        // Texture Viewer Splitter
        const texturesSplitter = document.getElementById('textures-splitter');
        const texCurrentEl = document.getElementById('tex-current');
        if (texturesSplitter && texCurrentEl) {
            let isDraggingTexturesSplitter = false;
            let startY = 0;
            let startHeight = 0;

            const initialHeight = applyTexturesPreviewHeight(loadTexturesPreviewHeight());
            if (initialHeight != null) {
                saveTexturesPreviewHeight(initialHeight);
            }

            texturesSplitter.addEventListener('pointerdown', (e) => {
                isDraggingTexturesSplitter = true;
                startY = e.clientY;
                startHeight = texCurrentEl.getBoundingClientRect().height;
                texturesSplitter.classList.add('dragging');
                texturesSplitter.setPointerCapture(e.pointerId);
                e.preventDefault();
            });

            texturesSplitter.addEventListener('pointermove', (e) => {
                if (!isDraggingTexturesSplitter) return;
                const dy = e.clientY - startY;
                const nextHeight = applyTexturesPreviewHeight(startHeight + dy);
                if (nextHeight != null && state.activeTab === 'textures') {
                    requestAnimationFrame(() => updateCurrentRTPreviewImageScale());
                }
            });

            texturesSplitter.addEventListener('pointerup', (e) => {
                isDraggingTexturesSplitter = false;
                texturesSplitter.classList.remove('dragging');
                saveTexturesPreviewHeight(texCurrentEl.getBoundingClientRect().height);
                try { texturesSplitter.releasePointerCapture(e.pointerId); } catch {}
            });

            texturesSplitter.addEventListener('pointercancel', (e) => {
                isDraggingTexturesSplitter = false;
                texturesSplitter.classList.remove('dragging');
                saveTexturesPreviewHeight(texCurrentEl.getBoundingClientRect().height);
                try { texturesSplitter.releasePointerCapture(e.pointerId); } catch {}
            });
        }
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
    