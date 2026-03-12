# Dots and Boxes

点格游戏 Web 版第一阶段骨架，包含：
- 前端：React + TypeScript + Vite + Zustand + Socket.IO Client
- 后端：Node.js + Express + Socket.IO + TypeScript
- 联机模式：房间制，两台电脑可实时对战

## 目录结构
- client/ 前端
- server/ 实时联机服务端
- TECH_STACK_AND_PLAN.md 技术栈与实现方案基线

## 快速开始

### 1. 安装依赖
首次安装（如果你已经执行过可跳过）：
- 根目录：`npm install`
- client 目录：`npm install`
- server 目录：`npm install`

### 2. 一键启动（推荐）
在项目根目录执行：
- `npm run dev`

默认端口：
- 前端：5173
- 后端：3001

## 两台电脑联机（重点）

### 场景 A：局域网内两台电脑
1. 在作为“主机”的电脑上启动后端服务：
   - `cd server`
   - `npm run dev`
2. 查询主机局域网 IP（例如 192.168.1.20）。
3. 在两台电脑的前端目录中创建 `.env` 文件（可复制 `client/.env.example`）：
   - `VITE_SERVER_URL=http://192.168.1.20:3001`
4. 启动前端：
   - `cd client`
   - `npm run dev`
5. 打开浏览器访问前端地址，一台创建房间，另一台输入房间号加入。

### 场景 B：公网联机
1. 将 server 部署到支持 WebSocket 的 Node 平台。
2. 将 `VITE_SERVER_URL` 改为你的后端公网地址。
3. 重新启动前端并使用房间号联机。

## 当前已实现能力
- 创建房间 / 加入房间
- 棋盘规格支持 m*n 矩形格式（例如 4*6）
- 2 人实时同步
- 服务端权威判定
- 合法性校验（非法边、重复边、非本人回合）
- 方格归属与得分
- 对局结束与胜负判定
- 玩家断开提示

## 后续建议
- 抽离 shared 类型到 `shared/`
- 补规则单元测试（闭环、加分后连走、结束判定）
- 加入重连恢复与观战模式
