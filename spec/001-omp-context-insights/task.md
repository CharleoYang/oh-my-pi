# OMP context insights — implementation task source

Goal：`spec-001-omp-context-insights`。本表是 feature plan 的 14 列输入；导入后不手工改运行状态。所有任务均未执行；日期、工时与 ONES 不填写虚假数据。

任务级业务依赖写在「前置依赖」列；feature plan 自动加入流程人闸等原生前置。每条任务都须在合法 claim、独立 worktree、当前分支验证、PR、独立 QA、平台合并和主树门禁后按实际交付范围结单。主仓 registry/runtime-root 使用绝对路径，禁止复制状态目录。

| 任务ID | 描述 | 前置依赖 | 预计写入范围 | 状态 | 门禁进度 | 计划开始 | 计划完成 | 预计工作量 | 实际开始 | 实际完成 | ONES任务ID | ONES同步 | 产出/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | [agent] 共享 ContextTimeline 类型、fold、上限与 legacy 降级 | 无 | packages/ai/src/context-insights.ts;packages/ai/src/types.ts;packages/ai/src/index.ts;packages/ai/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-01/06/07；TDD 先写 fixture/断言；覆盖事件顺序（文件顺序→下一条 step）、文件聚合、activeLeafId replay、legacy、负 unattributed、重复 id、坏条目、details 预算、尾部事件、截断；不读正文 |
| T-02 | [agent] 请求时捕获快照明细 + AgentSession live timeline | T-01 | packages/coding-agent/src/session/**;packages/coding-agent/src/config/**;packages/tui/src/status-line/context-usage.ts;packages/coding-agent/test/session/**;packages/tui/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-01/02/06；TDD 先写求和/归一/aborted-error/legacy 测试；0/1/20/21 parts、全零权重、重复 tool 名；复用 roster 缓存；不写正文 |
| T-03 | [agent] TUI `/context` 四页面板（Overview/Trend/Events/Files） | T-02 | packages/tui/src/status-line/context-insights.ts;packages/tui/src/components/**;packages/coding-agent/src/modes/controllers/command-controller.ts;packages/coding-agent/src/slash-commands/builtin-session.ts;packages/coding-agent/test/**;packages/tui/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-03/06；TDD 先写按键/窄屏/legacy/空态；host ReportPanel 键转发（native + ANSI）；保留原 Overview 卡片；无 native 能力不调 chart/image；VirtualTerminal 冒烟 |
| T-04 | [agent] stats 全局 Context 概览 API（KPI/热力图/会话行） | T-01 | packages/stats/src/context.ts;packages/stats/src/server.ts;packages/stats/src/shared-types.ts;packages/stats/src/db.ts;packages/stats/src/rollup.ts;packages/stats/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-04/07；不新增 DB 表；同一 cutoff 聚合 KPI/heatmap/rows；标注 DB approximation；>100 roots/旧+新请求/非法 range 负向对照 |
| T-05 | [agent] stats 单会话 Context API（timeline/fleet/ETag） | T-01,T-04 | packages/stats/src/context.ts;packages/stats/src/server.ts;packages/stats/src/shared-types.ts;packages/stats/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-05/06/07；activeLeafId parity、gzip/递归子文件、fleet、304、400/404、坏行 200 空；与核心 fold 同 fixture 逐字段一致 |
| T-06 | [agent] stats Web 全局 Context 页 + 会话六页完整版 | T-04,T-05 | packages/stats/src/client/**;packages/stats/src/shared-types.ts;packages/stats/test/** | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-04/05/07；六页联动、非最新 step details、legacy/truncated、窄屏、stale 不渲染旧会话；不复制共享类型 |
| T-07 | [agent] 跨表面 E2E、文档、changelog 与不覆盖安装门 | T-03,T-06 | scripts/e2e/**;scripts/ci/**;docs/**;packages/coding-agent/test/**;packages/stats/test/**;spec/001-omp-context-insights/**;CHANGELOG.md | 待执行 | 未开始 | — | — | — | — | — | — | 未接入 | AC-08/09；真实 TUI + 真实 stats server/browser；同一会话数字一致；无浏览器即失败；安装需用户确认 |

## Shared dispatch contract

- **已核实事实**：`FEATURE.md` 的 Verified baseline B1–B12；表中源码目录是最大候选范围，实际文件以 S2 设计为准。
- **需验证的推断**：`ContextSnapshotDetails` 的每轮额外估算成本、stats 单会话解析延迟、puppeteer 在本机的 Chrome 可用性。执行者必须先实测，不能把推断当事实。
- **验收**：每项包含输入不变式、权威 oracle、正负对照。T-01 的 oracle 是手算 fixture 与独立断言，不是被测函数自产；T-02 的 oracle 是 provider 快照与求和恒等式；T-05 的 oracle 是核心 fold 与 journal fold 逐字段对照；T-07 的 oracle 是同一会话在 TUI/Web 上的新增步骤数与 Δ。
- **依赖**：T-02/T-03/T-04/T-05/T-06/T-07 的依赖以上表为准；feature plan 会写入原生 `depends_on_todo_ids`，不接受只在文案里写“after”。
- **TDD**：每个任务先交 `test:` 红，再实现；不得倒填。提交历史、PR 正文与 validator 输出必须一致。
- **RL-01/02/03/04/05/06/07/08/09**：契约与实现一致；审查/测试证据落盘；审查限 diff 并与 Git 对账；源更新后重生成投影；修订后全量重审；遵守分层/DI；共享 seam 改动给全矩阵；validator 必须能失败；review verdict 必须机器可读且唯一。
- **不覆盖安装**：开发/测试只从源码或 `dist` 运行；`/opt/homebrew/bin/omp` 仅在 S5-R/S5-E2E 通过后由用户确认替换。
- **Main 集成**：T-01 是共享契约，先合并；T-02 与 T-04 可并行但 T-05 依赖 T-04 的路由/类型；T-03 与 T-06 可并行；T-07 最后。
