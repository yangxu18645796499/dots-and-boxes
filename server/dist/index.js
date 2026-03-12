"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const MIN_SIZE = 2;
const MAX_SIZE = 8;
const RECONNECT_GRACE_MS = 90000;
const MAX_CHAT_HISTORY = 150;
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});
const rooms = new Map();
const socketRoomById = new Map();
const removalTimers = new Map();
function createRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i += 1) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}
function sanitizeSize(size) {
    if (typeof size !== 'number' || Number.isNaN(size)) {
        return 4;
    }
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(size)));
}
function createPlayerToken() {
    return `p_${Math.random().toString(36).slice(2, 12)}`;
}
function timerKey(roomId, token) {
    return `${roomId}:${token}`;
}
function clearRemovalTimer(roomId, token) {
    const key = timerKey(roomId, token);
    const timer = removalTimers.get(key);
    if (!timer) {
        return;
    }
    clearTimeout(timer);
    removalTimers.delete(key);
}
function getAllEdges(rows, cols) {
    const edges = new Set();
    for (let r = 0; r <= rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
            edges.add(`h-${r}-${c}`);
        }
    }
    for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c <= cols; c += 1) {
            edges.add(`v-${r}-${c}`);
        }
    }
    return edges;
}
function getBoxEdges(row, col) {
    return [
        `h-${row}-${col}`,
        `h-${row + 1}-${col}`,
        `v-${row}-${col}`,
        `v-${row}-${col + 1}`,
    ];
}
function findCompletedBoxes(room, symbol) {
    let completedCount = 0;
    for (let r = 0; r < room.boardRows; r += 1) {
        for (let c = 0; c < room.boardCols; c += 1) {
            const boxKey = `${r}-${c}`;
            if (room.claimedBoxes[boxKey]) {
                continue;
            }
            const edges = getBoxEdges(r, c);
            const completed = edges.every((edge) => Boolean(room.claimedEdges[edge]));
            if (completed) {
                room.claimedBoxes[boxKey] = symbol;
                room.scores[symbol] += 1;
                completedCount += 1;
            }
        }
    }
    return completedCount;
}
function getPlayerSymbol(room, socketId) {
    const player = room.players.find((p) => p.id === socketId);
    return player ? player.symbol : null;
}
function getPlayerBySocket(room, socketId) {
    const player = room.players.find((p) => p.id === socketId);
    return player ?? null;
}
function totalEdges(rows, cols) {
    return (rows + 1) * cols + rows * (cols + 1);
}
function hasRoundBeenRecorded(room) {
    return room.roundHistory.some((item) => item.roundNumber === room.roundNumber);
}
function recordFinishedRound(room) {
    if (room.status !== 'finished') {
        return;
    }
    if (hasRoundBeenRecorded(room)) {
        return;
    }
    room.roundHistory.push({
        roundNumber: room.roundNumber,
        boardRows: room.boardRows,
        boardCols: room.boardCols,
        starter: room.starter,
        winner: room.winner,
        scores: { ...room.scores },
        finalClaimedEdges: { ...room.claimedEdges },
        finalClaimedBoxes: { ...room.claimedBoxes },
        finishedAt: Date.now(),
    });
    if (room.winner === 'A' || room.winner === 'B') {
        room.seriesScore[room.winner] += 1;
    }
}
function resetRoundState(room) {
    room.claimedEdges = {};
    room.claimedBoxes = {};
    room.scores = { A: 0, B: 0 };
    room.readyBySymbol = { A: false, B: false };
    room.diceRolls = { A: null, B: null };
    room.starter = null;
    room.currentTurn = 'A';
    room.winner = null;
    room.status = 'waiting';
}
function updateWinner(room) {
    const expectedEdges = totalEdges(room.boardRows, room.boardCols);
    const claimedCount = Object.keys(room.claimedEdges).length;
    if (claimedCount !== expectedEdges) {
        room.winner = null;
        return;
    }
    room.status = 'finished';
    if (room.scores.A > room.scores.B) {
        room.winner = 'A';
    }
    else if (room.scores.B > room.scores.A) {
        room.winner = 'B';
    }
    else {
        room.winner = 'draw';
    }
    recordFinishedRound(room);
}
function reconcileRoomStatus(room) {
    updateWinner(room);
    if (room.status === 'finished') {
        return;
    }
    if (room.players.length < 2 || room.players.some((p) => !p.connected)) {
        room.status = 'waiting';
        return;
    }
    const claimedCount = Object.keys(room.claimedEdges).length;
    if (claimedCount > 0) {
        room.status = 'playing';
        return;
    }
    const bothReady = room.readyBySymbol.A && room.readyBySymbol.B;
    if (!bothReady) {
        room.status = 'waiting';
        return;
    }
    const aRolled = typeof room.diceRolls.A === 'number';
    const bRolled = typeof room.diceRolls.B === 'number';
    if (aRolled && bRolled && room.starter) {
        room.status = 'playing';
        room.currentTurn = room.starter;
        return;
    }
    room.status = 'rolling';
}
function emitRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    io.to(roomId).emit('room_state', room);
}
io.on('connection', (socket) => {
    socket.on('create_room', (payload, callback) => {
        const roomId = createRoomId();
        const fallbackSize = sanitizeSize(payload.boardSize);
        const boardRows = sanitizeSize(payload.boardRows ?? fallbackSize);
        const boardCols = sanitizeSize(payload.boardCols ?? fallbackSize);
        const playerToken = payload.playerToken || createPlayerToken();
        const room = {
            roomId,
            boardRows,
            boardCols,
            players: [
                {
                    id: socket.id,
                    name: payload.playerName || 'Player A',
                    symbol: 'A',
                    token: playerToken,
                    connected: true,
                },
            ],
            readyBySymbol: { A: false, B: false },
            currentTurn: 'A',
            starter: null,
            diceRolls: { A: null, B: null },
            claimedEdges: {},
            claimedBoxes: {},
            scores: { A: 0, B: 0 },
            roundNumber: 1,
            seriesScore: { A: 0, B: 0 },
            roundHistory: [],
            chatHistory: [],
            status: 'waiting',
            winner: null,
        };
        rooms.set(roomId, room);
        socketRoomById.set(socket.id, roomId);
        socket.join(roomId);
        callback?.({ ok: true, roomId, symbol: 'A', playerToken });
        emitRoomState(roomId);
    });
    socket.on('join_room', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        const existingByToken = payload.playerToken
            ? room.players.find((p) => p.token === payload.playerToken)
            : null;
        if (existingByToken) {
            clearRemovalTimer(room.roomId, existingByToken.token);
            existingByToken.id = socket.id;
            existingByToken.connected = true;
            existingByToken.name = payload.playerName || existingByToken.name;
            socketRoomById.set(socket.id, room.roomId);
            socket.join(room.roomId);
            reconcileRoomStatus(room);
            callback?.({
                ok: true,
                roomId: room.roomId,
                symbol: existingByToken.symbol,
                playerToken: existingByToken.token,
            });
            emitRoomState(room.roomId);
            return;
        }
        if (room.players.length >= 2) {
            callback?.({ ok: false, message: '房间已满' });
            return;
        }
        const existing = room.players.find((p) => p.id === socket.id);
        const playerToken = payload.playerToken || createPlayerToken();
        // If a previous round was left in-progress/finished with only one active player,
        // reset to a clean new round before a new opponent joins.
        const hasStaleBoard = Object.keys(room.claimedEdges).length > 0 || room.status === 'finished';
        if (hasStaleBoard) {
            room.roundNumber += 1;
            resetRoundState(room);
        }
        if (!existing) {
            room.players.push({
                id: socket.id,
                name: payload.playerName || 'Player B',
                symbol: 'B',
                token: playerToken,
                connected: true,
            });
        }
        room.readyBySymbol.B = false;
        room.starter = null;
        room.diceRolls = { A: null, B: null };
        reconcileRoomStatus(room);
        socketRoomById.set(socket.id, room.roomId);
        socket.join(room.roomId);
        callback?.({ ok: true, roomId: room.roomId, symbol: 'B', playerToken });
        emitRoomState(room.roomId);
    });
    socket.on('rejoin_room', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在或已结束' });
            return;
        }
        const player = room.players.find((p) => p.token === payload.playerToken);
        if (!player) {
            callback?.({ ok: false, message: '重连凭据无效' });
            return;
        }
        clearRemovalTimer(room.roomId, player.token);
        player.id = socket.id;
        player.connected = true;
        if (payload.playerName?.trim()) {
            player.name = payload.playerName.trim();
        }
        socketRoomById.set(socket.id, room.roomId);
        socket.join(room.roomId);
        reconcileRoomStatus(room);
        callback?.({ ok: true, roomId: room.roomId, symbol: player.symbol, playerToken: player.token });
        emitRoomState(room.roomId);
    });
    socket.on('player_ready', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        const symbol = getPlayerSymbol(room, socket.id);
        if (!symbol) {
            callback?.({ ok: false, message: '你不在当前房间中' });
            return;
        }
        room.readyBySymbol[symbol] = Boolean(payload.ready);
        if (Object.keys(room.claimedEdges).length === 0) {
            room.starter = null;
            room.diceRolls = { A: null, B: null };
        }
        reconcileRoomStatus(room);
        callback?.({ ok: true });
        emitRoomState(room.roomId);
    });
    socket.on('roll_dice', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        const symbol = getPlayerSymbol(room, socket.id);
        if (!symbol) {
            callback?.({ ok: false, message: '你不在当前房间中' });
            return;
        }
        reconcileRoomStatus(room);
        if (room.status !== 'rolling') {
            callback?.({ ok: false, message: '当前不在掷骰阶段' });
            return;
        }
        // Tie re-roll: keep previous values visible until any player initiates next round.
        if (room.starter === null &&
            typeof room.diceRolls.A === 'number' &&
            typeof room.diceRolls.B === 'number' &&
            room.diceRolls.A === room.diceRolls.B) {
            room.diceRolls = { A: null, B: null };
        }
        if (room.diceRolls[symbol] !== null) {
            callback?.({ ok: false, message: '你已经掷过骰子' });
            return;
        }
        room.diceRolls[symbol] = (0, crypto_1.randomInt)(1, 7);
        const a = room.diceRolls.A;
        const b = room.diceRolls.B;
        if (typeof a === 'number' && typeof b === 'number') {
            if (a === b) {
                room.starter = null;
                io.to(room.roomId).emit('dice_tie', {
                    message: `骰子点数相同（A:${a}, B:${b}），请重新掷骰`,
                    diceRolls: room.diceRolls,
                });
            }
            else {
                room.starter = a > b ? 'A' : 'B';
                room.currentTurn = room.starter;
                io.to(room.roomId).emit('dice_decided', {
                    starter: room.starter,
                    diceRolls: room.diceRolls,
                    message: `${room.starter} 方先手`,
                });
            }
        }
        reconcileRoomStatus(room);
        callback?.({ ok: true, roll: room.diceRolls[symbol] });
        emitRoomState(room.roomId);
    });
    socket.on('start_next_round', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        if (room.status !== 'finished') {
            callback?.({ ok: false, message: '当前对局尚未结束' });
            return;
        }
        const symbol = getPlayerSymbol(room, socket.id);
        if (!symbol) {
            callback?.({ ok: false, message: '你不在当前房间中' });
            return;
        }
        room.roundNumber += 1;
        resetRoundState(room);
        callback?.({ ok: true, roundNumber: room.roundNumber });
        emitRoomState(room.roomId);
    });
    socket.on('presence_ping', (payload) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            return;
        }
        const player = room.players.find((p) => p.token === payload.playerToken);
        if (!player) {
            return;
        }
        let changed = false;
        if (!player.connected) {
            player.connected = true;
            changed = true;
        }
        if (player.id !== socket.id) {
            player.id = socket.id;
            changed = true;
        }
        socketRoomById.set(socket.id, room.roomId);
        socket.join(room.roomId);
        clearRemovalTimer(room.roomId, player.token);
        if (changed) {
            reconcileRoomStatus(room);
            emitRoomState(room.roomId);
        }
    });
    socket.on('send_chat', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        const symbol = getPlayerSymbol(room, socket.id);
        const player = room.players.find((p) => p.id === socket.id);
        if (!symbol || !player) {
            callback?.({ ok: false, message: '你不在当前房间中' });
            return;
        }
        const message = payload.message.trim();
        if (!message) {
            callback?.({ ok: false, message: '消息不能为空' });
            return;
        }
        const chatMessage = {
            roomId: room.roomId,
            senderSymbol: symbol,
            senderName: player.name,
            message: message.slice(0, 200),
            timestamp: Date.now(),
        };
        room.chatHistory.push(chatMessage);
        if (room.chatHistory.length > MAX_CHAT_HISTORY) {
            room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
        }
        io.to(room.roomId).emit('chat_message', chatMessage);
        emitRoomState(room.roomId);
        callback?.({ ok: true });
    });
    socket.on('make_move', (payload, callback) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            callback?.({ ok: false, message: '房间不存在' });
            return;
        }
        if (room.status !== 'playing') {
            callback?.({ ok: false, message: '对局尚未开始或已结束' });
            return;
        }
        const symbol = getPlayerSymbol(room, socket.id);
        if (!symbol) {
            callback?.({ ok: false, message: '你不在当前房间中' });
            return;
        }
        if (room.currentTurn !== symbol) {
            callback?.({ ok: false, message: '当前不是你的回合' });
            return;
        }
        const allEdges = getAllEdges(room.boardRows, room.boardCols);
        if (!allEdges.has(payload.edgeId)) {
            callback?.({ ok: false, message: '非法落子' });
            return;
        }
        if (room.claimedEdges[payload.edgeId]) {
            callback?.({ ok: false, message: '该边已被占用' });
            return;
        }
        room.claimedEdges[payload.edgeId] = symbol;
        const completedBoxes = findCompletedBoxes(room, symbol);
        if (completedBoxes === 0) {
            room.currentTurn = symbol === 'A' ? 'B' : 'A';
        }
        reconcileRoomStatus(room);
        callback?.({ ok: true });
        emitRoomState(room.roomId);
    });
    socket.on('disconnect', () => {
        const roomId = socketRoomById.get(socket.id);
        socketRoomById.delete(socket.id);
        if (!roomId) {
            return;
        }
        const room = rooms.get(roomId);
        if (!room) {
            return;
        }
        const player = getPlayerBySocket(room, socket.id);
        if (!player) {
            return;
        }
        player.connected = false;
        player.id = `offline-${player.symbol}-${Date.now()}`;
        reconcileRoomStatus(room);
        io.to(roomId).emit('player_left', { message: `${player.name} 暂时离线，等待重连...` });
        emitRoomState(roomId);
        clearRemovalTimer(roomId, player.token);
        const key = timerKey(roomId, player.token);
        const timer = setTimeout(() => {
            const latestRoom = rooms.get(roomId);
            if (!latestRoom) {
                removalTimers.delete(key);
                return;
            }
            latestRoom.players = latestRoom.players.filter((p) => p.token !== player.token);
            if (player.symbol === 'A') {
                latestRoom.readyBySymbol.A = false;
                latestRoom.diceRolls.A = null;
            }
            else {
                latestRoom.readyBySymbol.B = false;
                latestRoom.diceRolls.B = null;
            }
            if (latestRoom.players.length === 0) {
                rooms.delete(roomId);
                removalTimers.delete(key);
                return;
            }
            // Start fresh for the remaining player to avoid stale UI/board after opponent timeout.
            if (Object.keys(latestRoom.claimedEdges).length > 0 || latestRoom.status === 'finished') {
                latestRoom.roundNumber += 1;
            }
            resetRoundState(latestRoom);
            reconcileRoomStatus(latestRoom);
            io.to(roomId).emit('player_left', { message: `${player.name} 已离开房间` });
            emitRoomState(roomId);
            removalTimers.delete(key);
        }, RECONNECT_GRACE_MS);
        removalTimers.set(key, timer);
    });
});
const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Socket server running at http://localhost:${PORT}`);
});
