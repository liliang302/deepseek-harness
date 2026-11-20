# 代码评审报告：SDD 工作台面板

> 评审对象：feat/sdd-workbench-plugin @ dsh-v0.2.2-rc.5 基线上的新增代码 | 依据：[spec/PRD.md](../spec/PRD.md)、[design/TECH_DESIGN.md](../design/TECH_DESIGN.md)（含 DESIGN_REVIEW 修订）| 日期：2026-11-20 | 方式：主编排者沿真实执行路径审查（安装→注册→scan→readDoc→渲染），附测试与运行证据

## 总体结论

**通过**。实现与规格一致，无越权写面；两项 P1 记录在案不阻塞交付。

## 审查路径与发现

### 1. 真实执行路径核对

- **装配链**：bundle patch 两行 → Host `SddWorkbench`（class 插件默认导出，静态 Config 可被 inspect 读取）→ Client `apply()` 先 `$mount(sddWorkbenchRemote)` 再 `ctx.inject(['remote.sddWorkbench',...])` 注册 UI——与官方 voice-input 先例同构（DESIGN_REVIEW P0-1/P0-2 的修复落实 ✓）。首版漏掉 `$mount` 导致运行时 `remote.sddWorkbench` undefined，已在验收阶段发现并修复（有回归意义：类型接线 ≠ 运行时贡献挂载）。
- **数据流**：scan 浅层遍历（BRIEF + 4 子目录 readdir），只读；readDoc 三段防线（语法校验 confineSpecPath → resolve+contains 软链逃逸 → stat 文件型），错误码全部走 RemoteErrorDetailsMap 声明合并 ✓。
- **渲染**：Markdown fold 无 innerHTML，XSS 面为零（UT 断言 `<script>` 转义）；链接降级纯文本符合 FR-04 口径。

### 2. P1（重要，不阻塞）

1. **会话跟随策略依赖宿主内部引用计数**：`retainedBy.mainView` 在多工作区共享实例中可能为 0，当前回退"最近更新会话"是启发式而非语义正确。改进候选：面板头部加显式工作区选择器（数据源 `sessions.list` 的 cwd 去重），或等宿主暴露 selection API。已记入 ACCEPTANCE §3 保留项。
2. **`KNOWN_SUBDIRS` 之外目录中的阶段文档不可见**：布局契约变更时只坏展示不坏安全（BR-03 精神内），但建议在 layout.ts 注释保持"唯一维护点"纪律，后续 my-ai-infra 升级时同步。

### 3. P2（次要观察）

- panel.tsx 的 `tabsOf` 对 materials 用完整相对路径作 tab key，同名素材跨目录不会碰撞（context/ 单层约束保证）✓。
- service.spec 的 symlink 用例仅 POSIX；Windows 上 resolve 语义不同，CI 平台矩阵覆盖。
- `ListBody`/`DocBody` 未拆独立文件，页面 <300 行可接受。

### 4. 仓库规范符合性

- ESM、JSDoc 全导出面、`src/types.ts` 纯类型、tests/ 包级目录、CSS Modules 前缀隔离、locale 8 语言 meta + client NS 字典、icon.svg 自绘 ≤256KiB ✓。
- 实验包命名走 `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS`（无前缀名），三处清单（apps/cli deps、OPTIONAL_BUNDLES、EXPERIMENTAL_BUNDLES）齐 ✓。
- 门禁证据：build:artifacts 8 passed；定向 vitest 25 passed。

## 判定

按 PRD AC 与 DESIGN_REVIEW 修订执行，未发现阻塞缺陷；P1-1 作为已知限制随作业透明提交。
