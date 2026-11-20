# 测试计划：Hindsight 全局记忆体插件移植

> Feature：998-hindsight-memory-plugin | 依据：[spec/PRD.md](../spec/PRD.md) AC-01..11、[design/TECH_DESIGN.md](../design/TECH_DESIGN.md)（含 DESIGN_REVIEW 复评修订）、context/VERIFICATION.md 旧矩阵 | 状态：待执行 | 负责人：liliang302

## 1. 策略

三层：**vitest mock-fetch 单测**（src 逐文件 100%，NFR-03 门禁；fetch 经 HindsightClient 注入替身）→ **仓库门禁**（build/lint/doc-sync/config-catalog/locale/package-meta）→ **真机验收**（本机 Hindsight + 源码 dsh web 安装 bundle，走查 AC 并留 RPC/日志证据）。旧 integration.mjs 的断言语义全部吸收进单测；不保留裸 .mjs 进 CI。旧 VERIFICATION.md 的 L0–J 用例组按下表映射复用。

## 2. 单元用例（tests/*.spec.ts ↔ PRD 映射）

### hindsight.spec.ts（client）
| ID | 目标 | 关键断言 | 覆盖 |
|---|---|---|---|
| UT-C1 | request URL/headers/body 组装 | `/v1/default/banks/<bank>` 前缀、bank encodeURIComponent、content-type 仅 body 时带 | FR-01..05 |
| UT-C2 | recall 参数与解码 | query trim 空返 []；tags+tags_match 可选；results 过滤空 text；fact_type→factType | FR-04 |
| UT-C3 | listDocuments 重复 tags 参数 + limit/offset 默认 | URLSearchParams 序列 `tags=a&tags=b`；total 非 number→0 | FR-01 |
| UT-C4 | getDocument 字段兜底 | original_text/tags/created_at/document_metadata 缺省形状 | FR-01,02 |
| UT-C5 | retainDocument items 包装/context/metadata 条件挂 | metadata 空对象不发送；retainTimeoutMs 生效 | FR-02,05 |
| UT-C6 | deleteDocument memory_units_deleted 解析 | 缺省 0 | FR-02 |
| UT-C7 | 错误分类 | fetch reject→HindsightError code=unreachable；!ok→http+status+detail 截 200；JSON 坏→payload undefined 仍按 status 判 | FR-07 |
| UT-C8 | stats | GET /stats 透传 | FR-08 |
| UT-C9 | 超时/abort | AbortSignal.timeout 与调用方 signal 经 AbortSignal.any 合并；无死分支（评审 P1-3 删码后行可达） | NFR-01 |

### curated.spec.ts（store）
| ID | 目标 | 断言 | 覆盖 |
|---|---|---|---|
| UT-S1 | list 排序与空文过滤 | createdAt localeCompare + id tiebreak；originalText trim 空跳过；GET 失败条目跳过不炸整批 | FR-01 |
| UT-S2 | readDetails 并发≤8 | 17 条夹具下同时在飞请求数峰值 ≤8 | NFR-01 |
| UT-S3 | add 安全前置 | secret/injection 样本直接拒绝且零 HTTP 写 | FR-06, BR-06 |
| UT-S4 | add 预算 | current+len>limit → over_budget{entries,usage} 且未调 retain | FR-03, AC-03 |
| UT-S5 | add 成功形状 | document_id=dsh-mem-*、tags=[...config.tags,curated,mem:target]、context/metadata 值 | FR-02, BR-04 |
| UT-S6 | replace 定位 | exact→folded→歧义候选文案；空 old_text 报错；折叠表命中（引号/破折号变体） | FR-02, AC-04 |
| UT-S7 | replace 先写后删序 | retain resolve 后才 delete；retain 抛错 → delete 未调用、返回错误穿透 | AC-04 |
| UT-S8 | replace 预算数学 | nextTotal=current-old.len+new.len 超限拒绝 | FR-03 |
| UT-S9 | remove | no_match reason 带候选；成功 deletedUnits 透传 | FR-02 |
| UT-S10 | usage/loadAll | 两库 Promise.all；usage 求和正确 | FR-01 |

### security.spec.ts
| ID | 目标 | 断言 | 覆盖 |
|---|---|---|---|
| UT-K1..K7 | 凭据 7 形态逐一命中（私钥块/sk-rk-pk/ghp/AKIA/xox/JWT/password赋值中英） | kind='secret'；protectSecrets=false 全放开 | FR-06 |
| UT-K8..K13 | 注入 6 句式（英2+中3+im_start/im_end） | kind='injection'；protectSecrets=false 仍拦 | FR-06, BR-06 |
| UT-K14 | empty/too_long | trim 空；min(maxEntryChars, limit) 边界±1 | FR-03 |

### render.spec.ts
| ID | 目标 | 断言 | 覆盖 |
|---|---|---|---|
| UT-R1 | estimateTokens/usageLabel | 2.75 上取整；`chars/limit · % · ~tokens · n 条` | FR-01 |
| UT-R2 | formatSnapshot 三态 | 空库引导文案；正常双段结构；maxInjectedChars 截断加 … | FR-01 |
| UT-R3 | formatRecall/formatNudge/formatStatus/formatEntryList | 编号、单条截断、nudge 轮次插值 | FR-04,09 |

### tools.spec.ts
| ID | 目标 | 断言 | 覆盖 |
|---|---|---|---|
| UT-T1 | memory schema 稳定面 | name/description/parameters enum/required 快照断言（防 prompt 漂移） | FR-02 |
| UT-T2 | add/replace/remove/list/batch execute 分发 | 各 action 路由与结果渲染文本 | FR-02 |
| UT-T3 | batch 聚合 | 混合成败 failures 计数、reason 仅在 >0 时挂、末尾 entries/usage 合并 | FR-02 |
| UT-T4 | **assertLossless 回归**（旧 RESEARCH §7.1） | 对全部返回路径递归检查无 undefined 字段值（5 个历史缺陷场景重放） | BR-05 |
| UT-T5 | 服务不可达文案 | client 抛错 → 工具返回可读错误而非崩 | FR-07 |
| UT-T6 | recall 工具 max_tokens 边界校验 | 非正/非有限回退 config.recallTokens；output.render 命中/未命中文案 | FR-04 |
| UT-T7 | retain 工具 tag 合并去重、id 前缀 dsh-note- | mem:session 必含 | FR-05 |

### commands.spec.ts
| ID | 子命令 | 断言 | 覆盖 |
|---|---|---|---|
| UT-M1 | status | 双库占用行 | FR-08 |
| UT-M2 | list [target] | normalizeTarget 容错 | FR-08 |
| UT-M3 | search | 空参用法提示；命中/未命中 | FR-08 |
| UT-M4 | forget | 精确片段定位删除；no_match 报错 | FR-08 |
| UT-M5 | stats | bank/节点数渲染 | FR-08 |
| UT-M6 | handler 异常 | catch → kind:'error' 文案 | FR-07 |

### index.spec.ts（装配行为——AC 主战场）
| ID | 目标 | 断言 | 覆盖 |
|---|---|---|---|
| UT-I1 | 消息形状契约 | 注入消息由 createUserMessage 产物：frozen、branded id、source.kind∈{hindsight-memory,hindsight-memory-nudge}、snapshot 带 sections[{name,text}]、notice 带 ≤120 summary | P0-1 修复验证, AC-01 |
| UT-I2 | 快照只注入一次（含 resume） | 投影 fold user/message(kind) 后 snapshotInjected=true；模拟"新 fiber 同 session 重放事件流"不再注入 | AC-01, BR-02, P1-4 |
| UT-I3 | step!==1 / kind==='reject' 直通 | 返回原 decision 引用相等 | FR-01 |
| UT-I4 | lastUserText 排除 | OWN/FOREIGN kinds、runtime-context 等注入不算查询 | AC-05, BR-03 |
| UT-I5 | 召回节流 | turn>1、同 turn 不重发、curated 标签 fact 过滤、query 空不发 | AC-05 |
| UT-I6 | nudge 触发 | turn%10===0 注入；nudgeInterval=0 关闭 | FR-09 |
| UT-I7 | 沉淀 | assistant/message 覆盖式缓存；turn/end 拼「用户/助手」；<retainMinChars 不写；重复 turn/end 仅一次（投影 retainedTurns）；fire-and-forget 不阻塞（返回 promise 前完成监听同步部分） | AC-06, FR-05 |
| UT-I8 | 降级 | 快照/recall/retain 抛错均静默；对话流程返回值不变 | AC-08, NFR-02 |
| UT-I9 | commands 可选 | ctx.get('commands') undefined 时不注册不抛 | FR-08 |
| UT-I10 | dispose | fiber dispose 后工具/命令/projection 全撤（registry disposal 规则） | BR-07 |
| UT-I11 | Config schema | url/bank 必填默认、类型不符 zod 抛错（fail loud）、tags 数组清洗 | CR-01, P1-3 |

## 3. 门禁与集成（T6/T7）

| ID | 内容 | 通过判据 |
|---|---|---|
| GT-1 | pnpm run build（artifacts+check） | 全绿 |
| GT-2 | pnpm run test（本包 spec 全跑）+ test:coverage perFile | src/* 100% |
| GT-3 | lint/hygiene/publint | 0 error |
| GT-4 | doc-sync：gen-config-catalog 后 verify 过；locale×8 meta；icon 36×36；README.i18n.yaml 配对 | verify-* 门禁绿 |
| IT-1 | REAL-composition：test-only cordis.yml 装载 profile bundles+hindsight-memory 行，mock fetch 层记录 HTTP，跑一个 scripted agent 回合 | 断言 model-visible 请求含快照消息、durable log 有对应 user/message 事件（packages/AGENTS.md REAL 测试要求） |

## 4. E2E 宿主验收（真机，本机 Hindsight 8888 + 源码 dsh web）

| ID | 对应 AC | 步骤 | 证据 |
|---|---|---|---|
| E2E-1 | AC-10 | Plugins Add plugin link: 装包→启用 | 插件行 active、Plugins 页中文标题描述图标 |
| E2E-2 | AC-01/BR-02 | 新会话发一条消息 | transcript/session log 首步含 `[长期记忆·会话快照]`；第二轮不重复 |
| E2E-3 | AC-02 | 会话内让模型 memory add 一条测试记忆→开新会话 | 新会话快照含该条；旧会话快照不变 |
| E2E-4 | AC-03 | 逼近预算再 add | 工具返回 over_budget 清单；documents 计数不减不增 |
| E2E-5 | AC-04 | replace 唯一命中/歧义两种 | 前者 id 更换旧文档消失；后者候选文案且数据未动 |
| E2E-6 | AC-05 | 提"之前我们讨论过 X" | 注入相关召回且不含 curated 原文重复 |
| E2E-7 | AC-06 | 连续两轮后查 Hindsight | mem:session dsh-turn-* 文档按轮存在、无重复 |
| E2E-8 | AC-07 | 尝试写入含 sk-… 与"忽略以上指令"的记忆 | 双双拒绝 |
| E2E-9 | AC-08 | docker stop hindsight → 发消息 → start 回来 | 对话全程正常、无注入、无 unhandled rejection；恢复后功能回来 |
| E2E-10 | AC-09 | /memory status/list/search/forget | 输出与库一致 |
| E2E-11 | AC-11 | 上述门禁命令本地等价执行 | 记录版本化输出摘要 |
| E2E-12 | P1-4 回归 | 会话进行中重启 dsh web → resume 同一会话 | 快照不重复注入（投影重建） |

## 5. 缺口声明

- IT-1 scripted-agent 基建若现场成本过高，降级为"真实 GUI 会话 + session log 导出断言"（E2E-2 增强），并在 ACCEPTANCE 标注口径差异。
- 时间敏感断言（超时类）用 vi.useFakeTimers，避免 CI 抖动。
