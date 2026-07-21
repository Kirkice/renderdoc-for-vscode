# RenderDoc for VS Code 功能扩展开发计划

## 文档目的

本文档记录 RenderDoc for VS Code 后续功能扩展范围、实现顺序、验收标准和当前进度。每完成一项功能，将对应条目标记为 `[x]`，并补充实现位置和验证结果。

## 当前基线

- [x] VS Code 内打开和分析 `.rdc` Capture。
- [x] Native Bridge 支持 Capture、Replay、Pipeline、Shader、Texture、Mesh、Buffer 等数据访问。
- [x] MCP Streamable HTTP 服务。
- [x] RenderDoc MCP 基础分析工具集。
- [x] Windows/Android 应用启动与截帧基础流程。
- [x] `renderdoc-app-launch-capture` Skill。
- [x] CI/Release 的 Native Bridge CMake 构建流程使用 MSVC + Ninja。

## 总体目标

将插件从 Capture 查看器扩展为完整的 GPU 调试工作台：

1. AI 能可靠地管理应用启动、Live Session 和截帧状态。
2. AI 能基于证据生成性能、资源和 Shader 分析报告。
3. 用户能对比多个 Capture，定位优化前后的变化。
4. Inspector 能支持高级过滤、状态差异和调查记录。
5. Skill、MCP 工具、Native Bridge 和 UI 状态保持一致。

## 第一阶段：Session、工作流和诊断

### 1. 统一 Capture Session 状态

- [x] 增加 `renderdoc_getSessionState`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 Live Session 状态模型：平台、阶段、目标、应用、PID/serial、最近 Capture、错误。实现：[`src/launchTargetState.ts`](../src/launchTargetState.ts)。
- [x] 增加 `idle/checking/ready/launching/running/capturing/completed/failed` 阶段，并限制非法状态转换。
- [x] 增加 `renderdoc_waitForLiveTarget`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_waitForCapture`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_closeSession`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/extension.ts`](../src/extension.ts)。
- [x] 让“帮我截帧”复用现有 Session，不重复启动应用。实现：[`src/extension.ts`](../src/extension.ts)。
- [x] Session 失败时记录结构化错误和可恢复标志。实现：[`src/launchTargetState.ts`](../src/launchTargetState.ts)、[`src/extension.ts`](../src/extension.ts)。

主要位置：[`src/launchTargetState.ts`](../src/launchTargetState.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)、[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/extension.ts`](../src/extension.ts)。

### 2. 统一高层应用启动工具

- [x] 增加 `renderdoc_launchApplication`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)、[`src/extension.ts`](../src/extension.ts)。
- [x] 支持 `platform: windows | android`。
- [x] 平台缺失返回 `PLATFORM_REQUIRED`，不猜测、不启动。
- [x] Windows 校验 `.exe` 路径、文件存在性、工作目录和命令行。
- [x] Android 自动执行 readiness check，再执行启动。
- [ ] 保留底层 Windows/Android 启动工具用于诊断和 Skill 编排。

### 3. 统一高层截帧工具

- [x] 增加 `renderdoc_captureFrame`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)、[`src/extension.ts`](../src/extension.ts)。
- [x] 支持 Windows local session 和 Android remote session。实现：[`src/extension.ts`](../src/extension.ts)。
- [x] 支持 immediate/frame/delay 三种触发模式。
- [x] 自动更新 capturing/completed/failed Session 状态。
- [x] 自动保存并加载 `.rdc`。
- [x] 返回平台、目标、capturePath、frameNumber、loadedIntoInspector、replay 状态。

### 4. 结构化错误模型

- [x] 首批启动工作流返回 `ok/code/message/phase/recoverable/nextActions`。实现：[`src/extension.ts`](../src/extension.ts)。
- [x] 覆盖 `PLATFORM_REQUIRED`、`EXE_PATH_REQUIRED`、`EXE_NOT_FOUND`。
- [x] 覆盖 `ADB_NOT_FOUND`、`NO_ANDROID_DEVICE`、`ADB_UNAUTHORIZED`、`ADB_OFFLINE`。
- [x] 覆盖 `MULTIPLE_ANDROID_DEVICES`、`PACKAGE_NOT_INSTALLED`、`ACTIVITY_NOT_FOUND`。
- [x] 覆盖 `RENDERDOC_TARGET_NOT_FOUND`、`INJECTION_FAILED`。
- [x] 覆盖 `LIVE_SESSION_NOT_READY`、`CAPTURE_FAILED`。
- [ ] 在 Skill 和 MCP instructions 中说明错误恢复规则。

### 5. 环境诊断

- [x] 增加 `renderdoc_diagnoseEnvironment`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)、[`src/extension.ts`](../src/extension.ts)。
- [x] 检查 Native Bridge、Replay、当前 Session、adb 和 RenderDoc targets。
- [ ] 检查 MCP endpoint、端口和连接状态。
- [x] 检查 adb 版本和 RenderDoc Android targets。
- [ ] 输出可复制的诊断报告 Markdown/JSON。

## 第二阶段：性能分析

### 6. 自动性能报告

- [x] 增加 `renderdoc_generatePerformanceReport`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 自动收集当前 Capture 和 GPU Timings，并输出热点摘要。实现：[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 按 marker/pass 聚合耗时。
- [x] 找出 Top N 热点 pass 和 leaf draw。
- [x] 对热点补充 event/EID 和 GPU timing 证据，并给出后续 mesh/shader/resource 验证路径。
- [x] 区分确认事实、推断原因、后续验证项。
- [ ] 支持 Markdown 和 JSON 导出。
- [ ] 新增 `renderdoc-performance-report` Skill。

### 7. 资源和内存审计

- [x] 增加资源内存审计工具 `renderdoc_resourceMemoryAudit`，按 `byteSize` 排名并输出总量。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加基础最大资源摘要能力。
- [x] 增加 `renderdoc_getResourceLifetime`，明确返回可用证据和生命周期数据限制。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_findUnusedResources`，提供保守候选和低置信度标记。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_findResourceLeaks`，输出跨 Capture 持久资源候选并标记低置信度。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 检查纹理尺寸、格式、mip、估算显存和绑定关系摘要。
- [x] 新增 `renderdoc-resource-memory-audit` Skill。

## 第三阶段：Capture 对比

### 8. 跨 Capture 对比

- [x] 增加基础 `renderdoc_compareCaptures`，对比两份 RDC 的元数据和资源 footprint。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_compareEventTimings`，仅比较已有 timing evidence，不伪造跨 Capture replay timing。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_compareResourceMemory`，对比资源 byteSize footprint。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 支持优化前后 Capture 的 pass/draw、资源 footprint 对比。
- [x] 对比结果提供 draw/resource 数量、字节变化百分比和异常变化项。
- [x] 新增 `renderdoc-capture-diff` Skill。实现：[`skills/renderdoc-capture-diff/SKILL.md`](../skills/renderdoc-capture-diff/SKILL.md)。

## 第四阶段：Shader 和工程映射

### 9. Shader 诊断与优化

- [x] 增加 `renderdoc_findShaderVariants`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_compareShaders`，提供跨 event 的结构化 Shader payload 对比。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 增加 `renderdoc_validateShaderEdit`。
- [x] 增加 `renderdoc_getShaderCompileDiagnostics`，报告 Capture 中的 compiler metadata、entry point、flags 和 source availability。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [ ] 结合 Shader source、bindings、constant buffers、timings 和 Mali 分析。
- [x] 新增 `renderdoc-shader-optimization` Skill。实现：[`skills/renderdoc-shader-optimization/SKILL.md`](../skills/renderdoc-shader-optimization/SKILL.md)。

## 第四阶段完成范围

工程源码映射（Unity、Unreal、CMake/C++、Android 工程关联）不在本项目范围内，已移除，不作为待办任务。

## 第五阶段：Inspector 产品体验

### 11. Event Browser 高级过滤

- [x] 按 marker、文本和 EID 区间过滤，并支持实际 GPU 操作筛选。
- [x] 只显示 Draw/Dispatch/Copy/Clear/Present 等实际操作。
- [x] 按 GPU duration 排序。
- [x] 过滤 debug marker、空操作和无效事件。
- [x] 搜索结果支持一键生成 AI 上下文，工具：`renderdoc_buildEventBrowserContext`。

### 12. Pipeline State 差异高亮

- [x] 当前 event 与另一个 draw 的状态差异，已有 `renderdoc_diffPipelineState`。
- [x] 高亮 shader、RT、blend、depth、rasterizer 变化。

### 13. Bookmarks 和调查报告

- [x] 增加 `renderdoc_addBookmark` 和 `renderdoc_listBookmarks`，并使用 VS Code globalState 持久化。实现：[`src/copilot/tools.ts`](../src/copilot/tools.ts)、[`src/extension.ts`](../src/extension.ts)。
- [x] 增加 `renderdoc_updateBookmark` 和 `renderdoc_removeBookmark`。实现：[`src/copilot/toolRegistry.ts`](../src/copilot/toolRegistry.ts)、[`src/copilot/tools.ts`](../src/copilot/tools.ts)。
- [x] 保存 EID、问题描述、结论、截图路径和 AI 分析结果。
- [x] 增加 `renderdoc_exportInvestigationReport`。
- [x] 支持 Markdown/JSON 报告。

## Skill 清单

- [x] `renderdoc-app-launch-capture`：应用启动与截帧。
- [x] `renderdoc-performance-report`：性能报告和资源审计基础工作流。实现：[`skills/renderdoc-performance-report/SKILL.md`](../skills/renderdoc-performance-report/SKILL.md)。
- [x] `renderdoc-capture-diff`：Capture 对比。
- [x] `renderdoc-shader-optimization`：Shader 变体检索和优化工作流。实现：[`skills/renderdoc-shader-optimization/SKILL.md`](../skills/renderdoc-shader-optimization/SKILL.md)。
- [x] `renderdoc-resource-memory-audit`：资源和内存审计。实现：[`skills/renderdoc-resource-memory-audit/SKILL.md`](../skills/renderdoc-resource-memory-audit/SKILL.md)。
- [x] `renderdoc-replay-diagnostics`：Replay、Bridge、Android target 诊断。实现：[`skills/renderdoc-replay-diagnostics/SKILL.md`](../skills/renderdoc-replay-diagnostics/SKILL.md)。

## 通用实现要求

- [ ] MCP 工具输入使用 Zod schema 校验。
- [ ] 大数据默认摘要化、分页化，避免直接返回大 JSON/base64。
- [ ] 每个性能结论都能追溯到 EID、timing、resource 或 pipeline 证据。
- [ ] Native Bridge 能力不可用时返回明确限制，不伪造数据。
- [ ] 写操作工具明确标记副作用和当前 Session 影响。
- [ ] Skill 只负责工作流和约束，确定性操作交给 MCP 工具。
- [ ] MCP registry、schema、runtime smoke test 和 parity test 保持一致。

## 测试和验收

### 自动化测试

- [ ] TypeScript typecheck。
- [ ] ESLint 全绿。
- [ ] Native Bridge 构建。
- [ ] RDC parser 测试。
- [ ] MCP tool parity 测试。
- [ ] MCP runtime smoke 测试。
- [ ] Session 状态转换测试。
- [ ] 结构化错误和输入边界测试。
- [ ] 大 Capture 分页/摘要测试。

### 端到端测试

- [ ] Windows `.exe` 启动、重复截帧和关闭 Session。
- [ ] Android 单设备启动和截帧。
- [ ] Android 多设备选择。
- [ ] adb 缺失、unauthorized、offline、未安装包、Activity 缺失。
- [ ] RenderDoc target 不可用和注入失败。
- [ ] 远程 Replay 断连和恢复。
- [ ] 两个 Capture 的性能对比。

## 风险控制

- Capture/Shader/Texture 数据必须限制大小并支持分页。
- 应用启动、截帧、关闭属于有副作用操作，必须返回明确状态。
- 多个状态源可能不同步：adb、RenderDoc target、Native Bridge、Replay Host、Inspector。
- 工具数量增加后，应优先使用高层 workflow tool，底层工具用于补充诊断。
- 不在没有证据时声称存在过度绘制、Shader 复杂度或显存问题。

## 当前开发进度

- [x] 计划文档建立。
- [x] 第一批 Session 基础功能：Session state、close session、跨轮复用截帧。
- [x] 第一批高层启动、截帧兼容和性能热点摘要功能。
- [x] 第一批 Capture Workflow 和基础 Environment Diagnostics。
- [ ] 第一批 Workflow/Diagnostics 完整功能。
- [x] 第二批性能与资源分析基础功能：性能热点报告、资源 byteSize 审计和配套 Skill。
- [ ] 第二批完整性能与资源分析功能。
- [x] 第三批 Capture 对比基础功能。
- [x] 第四批 Shader 变体检索基础功能。
- [ ] 第三/四批完整 Capture 对比和 Shader 对比功能。
- [x] 第五批 Bookmarks、Annotation 基础能力和调查报告导出功能。
