# Dots and Boxes · 点格棋 Web 版

双人对战 + 大模型 AI 代打的点格棋（Dots and Boxes）网页游戏。
支持局域网/公网联机、开局前规格协商、对局回放、旁观模式，以及接入你自己的 OpenAI 兼容大模型让 AI 替你下完整局。

- 前端：React 19 + TypeScript + Vite + Zustand + Socket.IO Client
- 后端：Node.js + Express + Socket.IO（服务端权威判定）
- AI：OpenAI 兼容接口（BYOK，浏览器直连或经游戏服务器中转）

线上体验：**tisicstry.top/games/dots_and_boxes**

## 功能总览

### 对局核心
- 房间制双人实时对战，服务端权威判定（非法边/重复边/非本人回合全部校验）
- 成盒额外行动、终局胜负判定、平局处理
- 掷骰决定先手，同点由服务端自动重掷直到分出先后

### 规格协商
- 棋盘规格（2×2 ~ 8×8）不再由建房者锁死：每局开始前任一方提议 m*n，对方在聊天中点同意后生效（首局强制协商，AI 会自动接受有效提议）
- 每局开始前可一键"沿用上一局规格"或提议新规格

### 重开与连战
- 对局进行中：双方同意可清盘重开本局（不计历史）
- 对局结束后：双方同意开启下一局，历史战绩与大比分保留
- AI 接入后会自动跟随投票，双 AI 可连续自主对战

### 联机与身份
- 身份令牌持久化：掉线 90 秒内重连自动恢复局面（同一浏览器同一昵称视为同一人）
- 房间内拒绝重名；nonce 会话绑定防双开互相抢线
- 满员时后来者自动转为旁观者（只读棋盘与聊天）

### 复盘与数据
- 对战统计卡片 + 每局详情；点击历史条目可按落子顺序逐步回放
- 聊天可一键清空（保留待回应的规格提议）
- 房间数据仅存内存，无人后自动回收

### AI 代打（BYOK）
- 棋盘最大边 ≥ 6 的对局可"接入 AI"：填入你的 OpenAI 兼容 API（地址/Key/模型）即可
- 提示词内置 Berlekamp《The Dots-and-Boxes Game》高阶策略（控制权、长链法则、double-dealing 让 2 盒、闭环留 4 盒）+ 每步程序化战术分析（立即得盒边/安全边/危险边）
- API Key 只存你浏览器本地，经游戏服务器中转一次（不存储）后直连你填的地址
- 未填 Key 可开启随机陪练模式；视觉模型可勾选附加棋盘截图

## 快速开始

### 1. 安装依赖
- 根目录：`npm install`
- client 目录：`npm install`
- server 目录：`npm install`

### 2. 一键启动（本机双人同屏可用）
根目录执行 `npm run dev`，默认端口：前端 5173 / 后端 3001。

### 3. 局域网联机（手机/其他电脑）
1. 主机启动前后端（根目录 `npm run dev`）。
2. 查主机局域网 IP（如 `10.4.91.32`）。
3. 在 `client/` 建 `.env.local`：`VITE_SERVER_URL=http://10.4.91.32:3001`，重启前端。
4. 其他设备访问 `http://10.4.91.32:5173`（防火墙需放行 5173/3001）。

### 4. 公网部署
- 后端部署到支持 WebSocket 的 Node 平台；前端 `VITE_SERVER_URL` 指向后端公网地址后构建（`npm run build`）。
- 前端可部署 GitHub Pages 等静态托管（本项目线上示例即此架构）。

### 5. 接入 AI 代打
1. 对局棋盘最大边 ≥ 6 时，左侧操作区出现"接入 AI"。
2. 填入 OpenAI 兼容配置（如 DeepSeek：`https://api.deepseek.com` + `deepseek-chat`；Qwen vLLM 自建端点亦可，会自动关闭思考模式）。
3. 建议优先使用对话型（非思考）模型；思考型模型每步可能耗时 1-2 分钟。
4. 不填 Key 直接接入 = 随机落子陪练模式。

## 测试与联调
- `client/restart-test.mjs`：重开投票/历史保留回归
- `client/proposal-test.mjs`：规格协商全流程回归
- `client/multi-round-test.mjs`：多局规格独立性与历史完整性
- `client/resume-test.mjs`：掉线重连续局与陌生人等待
- `client/b-driver.mjs`：B 方联调机器人（自动准备/掷骰/落子/接受提议/跟随投票）

用法示例：`node b-driver.mjs <roomId>`，配合浏览器房间即可观察 AI 自动对局。

## 目录结构
- client/ 前端（含回归脚本与联调机器人）
- server/ 实时联机服务端
- docs/TECH_STACK_AND_PLAN.md 现行技术栈与架构基线
- docs/optimization/ 第 1 轮迭代记录（op1.md 总索引 + op1-01~op1-04 主题分册）

## 文档索引
- [docs/TECH_STACK_AND_PLAN.md](docs/TECH_STACK_AND_PLAN.md) — 现行架构与机制基线
- [docs/optimization/op1.md](docs/optimization/op1.md) — 第 1 轮迭代总索引（原始反馈 + 主题分册 + 改进建议）
