# 测试计划：SDD 工作台面板

> Feature：999-sdd-workbench-panel | 依据：[spec/PRD.md](../spec/PRD.md) AC-01..05、[design/TECH_DESIGN.md](../design/TECH_DESIGN.md) §3 任务表 | Profile：standard | 状态：待执行 | 负责人：liliang302

## 1. 测试策略

三层：纯函数单测（vitest，仓库既有 `pnpm run test` 通道）→ 构建门禁（typecheck/build/hygiene）→ 宿主行为验收（真实 `dsh web` + 浏览器人工/脚本断言）。文档读取类安全规则（BR-02/NFR-02）以对抗性夹具为主；UI 三态在真机验证（AC 口径），不建前端组件测试基建（MVP，仓库对 client 包无 jsdom 组件测试先例的依赖）。

## 2. 用例清单

### UT 单元（T2/T3/T6 交付，owner-local `packages/experimental/sdd-workbench/test/*.spec.ts`）

| ID | 目标 | 输入/步骤 | 期望 | 覆盖 |
|---|---|---|---|---|
| UT-01 | ROADMAP 分区解析 | 标准三段表格 markdown | Map{999→active,...}；重复编号取先出现分区 | FR-01, BR-03 |
| UT-02 | ROADMAP 畸形降级 | 乱表头/缺列/非表格行 | 返回已能解析部分或空 Map，不抛错 | BR-03 |
| UT-03 | BRIEF 头部解析 | 正常标题+Phase 表；反引号包裹 Phase；无标题文件；空文件 | title/phase 提取正确；缺失为 null | FR-02, P1-4 |
| UT-04 | 目录折叠 | 内存夹具：完整五产物 / 仅 BRIEF / context 素材混排 | artifacts 路径映射与 materials 列表正确；非 NNN-slug 目录归"其他" | FR-01, FR-02 |
| UT-05 | 路径防线 confineSpecPath | `BRIEF.md`,`spec/PRD.md`,`test/x.md` 合法；`../etc/passwd`,`a/../../b`,`/abs`,`x.txt`,`featureId=".."` 非法 | 合法返回拼接串；非法返回 null | BR-02 |
| UT-06 | 限长读取 | >1MiB 夹具 | truncated=true 且 ≤1MiB；非 UTF-8 → not-text | NFR-02 |
| UT-07 | Markdown 渲染 fold | 标题/表格/围栏/列表/嵌套 code/链接/图片/HTML 行样例 | AST→元素描述符符合子集规范；不支持项按降级规则输出 | FR-04, D3 |

### IT 集成（随 T4：服务装配冒烟）

| ID | 步骤 | 期望 | 覆盖 |
|---|---|---|---|
| IT-01 | cordis 测试 runtime 装载 sdd-workbench 插件行 + 临时目录含 mai-specs 夹具 | `ctx.sddWorkbench.scan(null)` 返回夹具 Feature；readDoc 往返一致 | FR-01/03/04 |
| IT-02 | 同上，无 mai-specs | specsDirExists=false，features=[]，不抛错 | AC-03 |

### E2E 宿主验收（T8，真实 `pnpm dsh web`，本仓库即被测工作区）

| ID | 对应 AC | 步骤 | 通过判据 |
|---|---|---|---|
| E2E-01 | AC-05 | Plugins 页 Add plugin 安装 bundle 目录 → 启用 | 行出现、图标/中英文名/描述正常；侧边栏出现「SDD 工作台」 |
| E2E-02 | AC-01 | 打开面板 | 列表含 `999 · sdd-workbench-panel`、标题、Phase 徽章、五徽标与实际文件一致；首屏 <1s |
| E2E-03 | AC-02 | 进详情切 BRIEF/PRD/DESIGN/REVIEW 标签 → 返回 | 正文渲染标题/表格/代码块；返回列表可用 |
| E2E-04 | AC-03 | 换到无 mai-specs 的空目录启动第二个实例（或临时改名目录+刷新） | 显示引导空态，无白屏/报错弹窗 |
| E2E-05 | AC-03/BR-02 | DevTools console 直接调 remote readDoc 传越界路径/非 .md | 返回 bad-path 错误码，Host 无异常栈泄漏 |
| E2E-06 | AC-04 | 面板全流程操作前后 `find mai-specs -type f -exec shasum` 对比 | 哈希全等；接口面无任何写方法（静态检查 grep @Remote 清单） |
| E2E-07 | AC-05 | 停用 bundle → 刷新页面 | 入口与面板消失，console 无 slot crash |
| E2E-08 | NFR-03 | 深浅色各开一次面板目检 | 颜色全部来自 token，两主题可读 |

### 回归门禁（每次提交前）

`pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build`（新增包纳入 workspace 后自动覆盖；client 隔离与 doc-sync 门禁由 build 流程执行）。

## 3. 已有覆盖复用

scan/readDoc 的 sessionId→根解析语义由 `workspaceFiles` 自身测试覆盖，本插件只测自有分支（null session 回退、header.cwd 命中）；不为复用面重测。

## 4. 缺口与保留

- 无浏览器自动化基建时 E2E-02/03/08 允许"人工步骤+截图记录"替代 DOM 断言，结果记入 ACCEPTANCE.md 并标注验证方式。
- 多 Peer 权限矩阵不在本次范围（设计 §4 边界）。
