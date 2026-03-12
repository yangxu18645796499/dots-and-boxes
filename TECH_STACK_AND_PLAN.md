# Dots and Boxes Web 游戏技术栈与第一版实现方案

## 1. 项目目标
- 构建一个可在浏览器运行的点格游戏（Dots and Boxes）。
- 第一版同时支持：
  - 本地双人（同屏轮流）
  - 局域网/互联网两台电脑联机（房间制）

## 2. 技术栈（已确认）

### 前端
- React
- TypeScript
- Vite
- Zustand（轻量状态管理）
- Tailwind CSS（可选，第一版可先用基础 CSS）
- Framer Motion（可选，后续增强动效）

### 实时联机层
- Socket.IO Client

### 后端
- Node.js
- Express
- Socket.IO
- TypeScript

### 测试
- Vitest
- React Testing Library
- 规则测试重点：
  - 闭环判定（是否形成方格）
  - 回合切换逻辑
  - 联机同步一致性（状态广播）

### 部署
- 前端：Vercel 或 Netlify
- 后端：可部署到支持 Node.js WebSocket 的平台（Render、Railway、Fly.io 等）

## 3. 第一版架构

### 目录建议
- client/：React 前端
- server/：联机房间与对局同步服务
- shared/：可选，放置前后端共享类型（第一版可暂不拆）

### 联机核心设计
- 房间模型：
  - roomId
  - players（最多 2 人）
  - boardSize
  - claimedEdges
  - claimedBoxes
  - currentTurn
  - scores
  - gameStatus

- Socket 事件（第一版）
  - create_room
  - join_room
  - room_state
  - player_ready
  - make_move
  - move_applied
  - game_over
  - player_left

### 状态同步策略
- 服务端权威状态（Authoritative Server）
- 客户端只发送“意图”，由服务端验证并广播结果
- 防止双端同时落子导致状态分叉

## 4. 第一版功能清单
- 支持创建房间 / 加入房间
- 支持两名玩家开始对局
- 支持基础棋盘（默认 4x4 或可配置）
- 支持合法性校验（重复边不可重复落子）
- 支持回合切换与得分计算
- 支持对局结束判定
- 支持断开连接提示（至少提示，不强制重连）

## 5. 后续增强（第二阶段）
- 排行榜与战绩存储（PostgreSQL）
- 登录鉴权（JWT/OAuth）
- 观战模式
- AI 对战
- 动画与音效增强

## 6. 工程约定
- 统一 TypeScript 严格模式
- 前后端协议事件名固定，使用类型约束
- 关键规则逻辑优先写单元测试
- 优先保证联机一致性，再做视觉和动效优化
