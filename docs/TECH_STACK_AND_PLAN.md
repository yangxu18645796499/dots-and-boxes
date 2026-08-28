# Dots and Boxes Web 游戏技术栈与架构基线（现行版）

> 本文替代最初的第一版实现方案，描述**当前已落地**的技术栈、架构与关键机制。
> 迭代过程记录见 `docs/optimization/op1.md`（第 1 轮）与 `docs/optimization/op2.md`（第 2 轮索引）。

## 1. 技术栈（实际使用）

### 前端（client/）
- React 19 + TypeScript（严格模式）
- Vite 7（dev `--host` 开放局域网访问）
- Zustand（房间/系统消息状态）
- Socket.IO Client（`transports: ['websocket']`）
- 原生 CSS（设计令牌走 CSS 变量，字重三档制 400/600/800）
- AI 客户端模块 `src/aiClient.ts`（OpenAI 兼容 chat/completions、棋盘序列化、canvas 绘图）

### 后端（server/）
- Node.js + Express + Socket.IO + TypeScript（`tsx watch` 开发热重载）
- 全局 `cors()` 与 `express.json()`
- `/ai/relay`：LLM 请求哑中转（见 §AI）

### 测试
- Socket.IO 集成回归脚本（client/ 下 .mjs，直连 :3001 模拟双端）：
  - `restart-test.mjs` 重开投票/历史保留
  - `proposal-test.mjs` 规格协商全流程
  - `multi-round-test.mjs` 多局规格独立性与历史完整性
  - `resume-test.mjs` 掉线重连续局与旁观者
- `b-driver.mjs` B 方联调机器人（自动接受提议/准备/掷骰/落子/跟随投票）

## 2. 服务端权威模型

客户端只发送"意图"，服务端校验并广播 `room_state` 全量快照。

### RoomState 关键字段
- 基础：roomId / boardRows / boardCols / players(2) / spectators[] / status(waiting|rolling|playing|finished)
- 对局：claimedEdges / claimedBoxes / moveOrder[] / scores / currentTurn / starter / winner / diceRolls
- 机制：specAgreed + specAgreedOnce（规格协商门禁）/ boardProposal / nextRoundVotes / roundNumber / seriesScore / roundHistory[]（含 moveOrder 供回放）
- 联机：player.token（身份）/ player.nonce（页面标识）/ player.connected

### Socket 事件清单（现行）
Client → Server：
`create_room` `join_room`(nonce) `rejoin_room`(nonce) `player_ready` `roll_dice` `make_move` `presence_ping`(nonce) `send_chat` `clear_chat` `propose_board` `respond_board` `confirm_spec` `vote_next_round`

Server → Client：
`room_state` `dice_decided` `round_reset` `board_proposal_result` `chat_message` `player_left`（`dice_tie`/`turn_skipped` 已随功能迭代移除）

## 3. 关键机制

### 规格协商（开局门禁）
- 创建房间不锁死规格（默认 4*4 仅作预览）；`specAgreed` 只有在"提议被对方同意"后才置真
- `propose_board`（等待期任一方提议，新提议取代旧提议）→ `respond_board`（对方同意/拒绝）
- 首局必须协商；`specAgreedOnce` 记录后，后续每局可"沿用上一局"（`confirm_spec` 一键）或再提议
- 未协商时 `player_ready` 被拒绝，棋盘显示 🔒 锁定遮罩
- 双方就绪时未回应的提议自动作废

### 重开与下一局（双同意投票制）
- `vote_next_round`：进行中=清盘重开本局（不计历史）；已结束=开启下一局（历史保留）
- 投票可随时撤回（再次点击）；掉线自动清票

### 身份与重连
- 身份令牌：创建/加入成功后由客户端持久化 `{昵称, token}` 到 localStorage；同浏览器同昵称自动续用
- 掉线宽限 90 秒（席位保留，`player_left` 提示）；期间同令牌重连恢复局面
- nonce 绑定：presence_ping 仅在"同页面（nonce 相同）或玩家离线"时重新绑定 socket，防双开抢线
- 房间内重名拒绝；满员自动转旁观者；房间无人后整体回收（内存态，天然支持房号复用）

### 掷骰
- 同点由服务端自动重掷双方直到分出先后（响应注明重掷次数）；随机源 `crypto.randomInt`

### AI 代打（BYOK 中转）
- 条件：棋盘最大边 ≥ 6；操作区"接入 AI/断开 AI"
- 客户端驱动状态机：确认/提议规格（自动接受对方有效提议）→ 准备 → 掷骰 → 轮到己方时请求 LLM → 随机兜底 → 跟随/发起投票
- 安全模型：API Key 只存浏览器 localStorage；调用经游戏服务器 `/ai/relay` **哑中转**（不存储 Key、仅 HTTPS + 内网地址防护 + 65s 超时）后直连用户填写的 API 地址
- 提示词 = GAME_RULES（与规则弹窗同源）+ Berlekamp 策略（控制权/长链法则/double-dealing/硬心半心施舍）+ 程序化战术分析（立即得盒/安全/危险边）+ 严格 JSON 输出
- 模型适配：Qwen 系自动 `enable_thinking:false`；DeepSeek 等纯文本模型发送字符串 content；思考型模型超时放宽至 150s

## 4. 前端 UI 规范
- 字重三档制：400 正文 / 600 按钮与次强调 / 800 标题与徽章（CSS 末尾统一覆盖层实现）
- 三栏动态等高布局：侧栏 / 中列（对局头部+棋盘）/ 聊天，底边恒对齐；大棋盘内容可整体撑高三栏
- 已移除：深色模式、回合倒计时、AI 自动断开

## 5. 已知边界与后续路线
- deepseek-reasoner 等思考型模型响应慢（已放宽超时并提示选型）
- 房间数据为内存态：进程重启即清空；排行榜/持久化需引入数据库（未排期）
- 视觉模型截图增强、公网部署清单（HTTPS、进程守护）待办
