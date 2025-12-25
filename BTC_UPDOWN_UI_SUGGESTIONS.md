# BTC Up/Down 首页 UI 建议（更新版）

## 已确认方向（与你的反馈对齐）
1) **实时盘口/赔率**：未 Reveal 前一律显示“待揭示”。
2) **Live Feed**：显示“xxx 下注”；Reveal 后可以显示“谁 claim 了”（基于事件）。
3) **历史收益**：纯前端 + RPC 无服务器模式仅能做“用户本地视角”，全局统计仍需链下索引；可以通过新增 view 辅助，但无法从链上枚举所有用户。
4) **Wager 金额**：固定值（建议 0.01 ETH，或从合约 `stakeAmount` 读取后只读展示）。
5) **本地缓存**：允许本地缓存用户提交（roundId + direction），不解密链上数据。

## 目前 UI 无法做到或必须降级显示的部分
1) **实时盘口/赔率**
- 合约中的总注（Up/Down）未解密前不可见，无法计算动态赔率。
- UI 需在 Reveal 前显示“待揭示”，Reveal 后再显示真实赔率/分配公式。

2) **Live Feed 显示具体方向**
- `BetPlaced` 仅公开地址与金额，方向加密不可读。
- UI 只能显示“地址 + 下注”，方向栏改成“加密/隐藏”。
- Reveal 后可追加 `ClaimPaid` 事件展示“谁 claim 了”。

3) **用户胜率、历史收益、排行榜**
- 合约无用户列表/历史轮次索引，无法纯 RPC 得到全局统计。
- 前端无服务器模式只能做“当前连接用户”的本地统计（本地缓存 + RPC 轮询）。

4) **Wager Amount 输入框**
- 合约 `stakeAmount` 固定，`placeBet` 要求 `msg.value == stakeAmount`。
- UI 输入框应改为只读固定值（如 0.01 ETH）并移除 MAX。

5) **刷新后恢复用户下注方向**
- `Bet.direction` 是 `euint32` 且仅合约可访问（`FHE.allowThis`）。
- 允许本地缓存 roundId + direction，以便刷新后恢复 UI 展示。

## 建议新增的合约 view/事件（不改变核心逻辑）
> 已确认同意，后续可按需分批补充。

1) `getRoundTimes(uint256 roundId)` → 直接用公式返回 start/end，便于倒计时。
2) `getRoundSummary(uint256 roundId)` → 简化 UI 轮次状态读取。
3) `betCount`（每轮下注数） → 支撑“参与人数/总注数”。
4) `getUserClaimHandle(roundId, user)` → 方便历史展示（已领取/未领取）。
5) 事件补充：可增加 `BetCountUpdated` 或类似事件供前端订阅。

## 前端轮询/本地存储建议（无服务器模式）
1) **轮询策略**
- 每 5~10 秒读取 `getBlock('latest')` 获取区块时间。
- 计算 `currentRound` 与倒计时，拉取 `getRoundState` / `getRoundTotals`。

2) **本地缓存（用户视角）**
- `localStorage` 保存 `{roundId, direction, stake}`。
- 用于展示“你已下注方向”与“历史提交记录”。

3) **能力边界**
- 无法从链上枚举所有用户 → 无法生成全局排行榜/胜率。
- 需要全局数据时再引入链下索引（TheGraph/自建 Indexer）。

## UI 可增加的显示模块（当前合约能力内可实现）
1) **轮次进度条 + 区块时间同步**
- 显示“距封盘剩余时间/已过时间”。

2) **轮次状态卡**
- 状态流：待结算 → 已结算 → 已请求揭示 → 已揭示总池。

3) **结果区与价格对比**
- 展示 startPrice/endPrice 与涨跌百分比（来自合约或价格源）。

4) **费用信息**
- 显示 `feeBps`、`feeAccrued`、`feeRecipient`。

5) **Claim 状态引导**
- 流程按钮 + pending handle 展示。

## 对当前首页的最小 UI 调整建议（先落地）
- 赔率显示“待揭示”，Reveal 后再展示实际值。
- Live Feed 显示“下注/claim”事件，不展示方向。
- Wager 输入改成只读固定值（0.01 ETH 或合约 stakeAmount）。
- 增加“本地提交记录”区域，展示用户本地缓存的 roundId + direction。

## 实施计划（前端先行，无服务器）
1) **UI 文案与展示降级**：赔率改为待揭示、Live Feed 显示下注/claim、Wager 只读固定值。
2) **本地缓存与轮询**：缓存用户提交（roundId + direction）；轮询区块时间与轮次状态。
3) **合约扩展（可选）**：补充 view/事件以提升 UI 可见性。

