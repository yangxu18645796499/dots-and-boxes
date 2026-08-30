import cors from 'cors';
import { randomInt } from 'crypto';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

type PlayerSymbol = 'A' | 'B';

type Player = {
  id: string;
  name: string;
  symbol: PlayerSymbol;
  token: string;
  nonce?: string;
  connected: boolean;
};

type Spectator = { id: string; name: string };

type RoundHistoryItem = {
  roundNumber: number;
  boardRows: number;
  boardCols: number;
  starter: PlayerSymbol | null;
  winner: PlayerSymbol | 'draw' | null;
  scores: Record<PlayerSymbol, number>;
  finalClaimedEdges: Record<string, PlayerSymbol>;
  finalClaimedBoxes: Record<string, PlayerSymbol>;
  moveOrder: string[];
  finishedAt: number;
};

type RoomChatMessage = {
  roomId: string;
  senderSymbol: PlayerSymbol;
  senderName: string;
  message: string;
  timestamp: number;
  kind?: 'text' | 'board-proposal';
  proposal?: {
    id: number;
    rows: number;
    cols: number;
    status: 'pending' | 'accepted' | 'rejected';
  };
};

type BoardProposal = {
  id: number;
  rows: number;
  cols: number;
  by: PlayerSymbol;
};

type RoomState = {
  roomId: string;
  boardRows: number;
  boardCols: number;
  players: Player[];
  readyBySymbol: Record<PlayerSymbol, boolean>;
  currentTurn: PlayerSymbol;
  starter: PlayerSymbol | null;
  diceRolls: Record<PlayerSymbol, number | null>;
  claimedEdges: Record<string, PlayerSymbol>;
  claimedBoxes: Record<string, PlayerSymbol>;
  scores: Record<PlayerSymbol, number>;
  roundNumber: number;
  seriesScore: Record<PlayerSymbol, number>;
  roundHistory: RoundHistoryItem[];
  chatHistory: RoomChatMessage[];
  nextRoundVotes: Record<PlayerSymbol, boolean>;
  boardProposal: BoardProposal | null;
  spectators: Spectator[];
  moveOrder: string[];
  specAgreed: boolean;
  specAgreedOnce: boolean;
  status: 'waiting' | 'rolling' | 'playing' | 'finished';
  winner: PlayerSymbol | 'draw' | null;
};

type CreateRoomPayload = {
  playerName: string;
  playerToken?: string;
  boardRows?: number;
  boardCols?: number;
  boardSize?: number;
};

type JoinRoomPayload = {
  roomId: string;
  playerName: string;
  playerToken?: string;
  nonce?: string;
};

type RejoinRoomPayload = {
  roomId: string;
  playerName?: string;
  playerToken: string;
  nonce?: string;
};

type MakeMovePayload = {
  roomId: string;
  edgeId: string;
};

type ReadyPayload = {
  roomId: string;
  ready: boolean;
};

type SendChatPayload = {
  roomId: string;
  message: string;
};

type RollDicePayload = {
  roomId: string;
};

type VoteNextRoundPayload = {
  roomId: string;
};

type ProposeBoardPayload = {
  roomId: string;
  rows: number;
  cols: number;
};

type RespondBoardPayload = {
  roomId: string;
  proposalId: number;
  accept: boolean;
};

type ConfirmSpecPayload = {
  roomId: string;
};

type ClearChatPayload = {
  roomId: string;
};

type AiRelayPayload = {
  url: string;
  key: string;
  body: Record<string, unknown>;
};

type PresencePingPayload = {
  roomId: string;
  playerToken: string;
  nonce?: string;
};

const MIN_SIZE = 2;
const MAX_SIZE = 8;
const RECONNECT_GRACE_MS = 90_000;
const MAX_CHAT_HISTORY = 150;

const app = express();
app.use(cors());
app.use(express.json());

// AI 请求中转：浏览器直连部分 LLM 网关会被扩展/CORS 拦截，由游戏服务器哑转发（不存储 Key）
app.post('/ai/relay', async (req, res) => {
  const { url, key, body } = (req.body ?? {}) as AiRelayPayload;
  if (typeof url !== 'string' || typeof key !== 'string' || !key.trim() || typeof body !== 'object' || !body) {
    res.status(400).json({ error: { message: '缺少 url / key / body' } });
    return;
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    res.status(400).json({ error: { message: 'url 无效' } });
    return;
  }

  // 密钥安全：仅允许 HTTPS（本机调试允许 localhost），且禁止中转至内网地址
  const host = target.hostname;
  const localOk = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '0.0.0.0';
  if (target.protocol !== 'https:' && !localOk) {
    res.status(400).json({ error: { message: '为保护密钥，中转仅支持 HTTPS 地址' } });
    return;
  }
  if (/^(10|127)\.|^0\.0\.0\.0$|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^\[::1\]$/.test(host) && !localOk) {
    res.status(400).json({ error: { message: '禁止中转至内网地址' } });
    return;
  }

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    const timedOut = String(e).includes('timeout') || String(e).includes('Timeout');
    res.status(502).json({ error: { message: timedOut ? '上游 API 超时（120s），请稍后重试或换更快的模型' : '上游 API 请求失败' } });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map<string, RoomState>();
const socketRoomById = new Map<string, string>();
const removalTimers = new Map<string, NodeJS.Timeout>();

function createRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function sanitizeSize(size?: number): number {
  if (typeof size !== 'number' || Number.isNaN(size)) {
    return 4;
  }
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(size)));
}

function createPlayerToken(): string {
  return `p_${Math.random().toString(36).slice(2, 12)}`;
}

function timerKey(roomId: string, token: string): string {
  return `${roomId}:${token}`;
}

function clearRemovalTimer(roomId: string, token: string): void {
  const key = timerKey(roomId, token);
  const timer = removalTimers.get(key);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  removalTimers.delete(key);
}

function getAllEdges(rows: number, cols: number): Set<string> {
  const edges = new Set<string>();
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

function getBoxEdges(row: number, col: number): string[] {
  return [
    `h-${row}-${col}`,
    `h-${row + 1}-${col}`,
    `v-${row}-${col}`,
    `v-${row}-${col + 1}`,
  ];
}

function findCompletedBoxes(room: RoomState, symbol: PlayerSymbol): number {
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

function getPlayerSymbol(room: RoomState, socketId: string): PlayerSymbol | null {
  const player = room.players.find((p) => p.id === socketId);
  return player ? player.symbol : null;
}

function getPlayerBySocket(room: RoomState, socketId: string): Player | null {
  const player = room.players.find((p) => p.id === socketId);
  return player ?? null;
}

function totalEdges(rows: number, cols: number): number {
  return (rows + 1) * cols + rows * (cols + 1);
}

function hasRoundBeenRecorded(room: RoomState): boolean {
  return room.roundHistory.some((item) => item.roundNumber === room.roundNumber);
}

function recordFinishedRound(room: RoomState): void {
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
    moveOrder: [...room.moveOrder],
    finishedAt: Date.now(),
  });

  if (room.winner === 'A' || room.winner === 'B') {
    room.seriesScore[room.winner] += 1;
  }
}

function resetRoundState(room: RoomState): void {
  room.claimedEdges = {};
  room.claimedBoxes = {};
  room.scores = { A: 0, B: 0 };
  room.readyBySymbol = { A: false, B: false };
  room.diceRolls = { A: null, B: null };
  room.nextRoundVotes = { A: false, B: false };
  room.boardProposal = null;
  room.moveOrder = [];
  // 每局开局前都重新确认规格（沿用或新提议），specAgreedOnce 记录是否曾确认过
  room.specAgreed = false;
  room.starter = null;
  room.currentTurn = 'A';
  room.winner = null;
  room.status = 'waiting';
}

// 进入掷骰/对局阶段后，未回应的棋盘提议自动作废
function invalidatePendingProposal(room: RoomState): void {
  if (!room.boardProposal) {
    return;
  }

  room.chatHistory.forEach((msg) => {
    if (msg.kind === 'board-proposal' && msg.proposal?.status === 'pending') {
      msg.proposal.status = 'rejected';
    }
  });
  room.boardProposal = null;
}

function updateWinner(room: RoomState): void {
  const expectedEdges = totalEdges(room.boardRows, room.boardCols);
  const claimedCount = Object.keys(room.claimedEdges).length;
  if (claimedCount !== expectedEdges) {
    room.winner = null;
    return;
  }

  room.status = 'finished';
  if (room.scores.A > room.scores.B) {
    room.winner = 'A';
  } else if (room.scores.B > room.scores.A) {
    room.winner = 'B';
  } else {
    room.winner = 'draw';
  }

  recordFinishedRound(room);
}

function reconcileRoomStatus(room: RoomState): void {
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

function emitRoomState(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  io.to(roomId).emit('room_state', room);
}

io.on('connection', (socket) => {
  socket.on('create_room', (payload: CreateRoomPayload, callback?: (response: unknown) => void) => {
    const roomId = createRoomId();
    const fallbackSize = sanitizeSize(payload.boardSize);
    const boardRows = sanitizeSize(payload.boardRows ?? fallbackSize);
    const boardCols = sanitizeSize(payload.boardCols ?? fallbackSize);

    const playerToken = payload.playerToken || createPlayerToken();
    const room: RoomState = {
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
      nextRoundVotes: { A: false, B: false },
      boardProposal: null,
      spectators: [],
      moveOrder: [],
      specAgreed: false,
      specAgreedOnce: false,
      status: 'waiting',
      winner: null,
    };

    rooms.set(roomId, room);
    socketRoomById.set(socket.id, roomId);
    socket.join(roomId);

    callback?.({ ok: true, roomId, symbol: 'A', playerToken });
    emitRoomState(roomId);
  });

  socket.on('join_room', (payload: JoinRoomPayload, callback?: (response: unknown) => void) => {
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
      existingByToken.nonce = payload.nonce ?? existingByToken.nonce;
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
      // 满员：以旁观者身份进入（只读棋盘与聊天，不能落子/投票/发言）
      const name = (payload.playerName || '旁观者').slice(0, 20);
      room.spectators.push({ id: socket.id, name });
      socketRoomById.set(socket.id, room.roomId);
      socket.join(room.roomId);
      callback?.({ ok: true, roomId: room.roomId, spectator: true });
      emitRoomState(room.roomId);
      return;
    }

    // 新玩家加入：拒绝与房间内玩家重名的昵称，避免聊天与身份混淆
    const joinName = (payload.playerName || '').trim().toLowerCase();
    if (joinName && room.players.some((p) => p.name.trim().toLowerCase() === joinName)) {
      callback?.({ ok: false, message: '该昵称已被房间内玩家使用，请换一个昵称' });
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
        nonce: payload.nonce,
        connected: true,
      });
    } else {
      existing.nonce = payload.nonce;
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

  socket.on('rejoin_room', (payload: RejoinRoomPayload, callback?: (response: unknown) => void) => {
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
    if (payload.nonce) {
      player.nonce = payload.nonce;
    }
    if (payload.playerName?.trim()) {
      player.name = payload.playerName.trim();
    }

    socketRoomById.set(socket.id, room.roomId);
    socket.join(room.roomId);
    reconcileRoomStatus(room);

    callback?.({ ok: true, roomId: room.roomId, symbol: player.symbol, playerToken: player.token });
    emitRoomState(room.roomId);
  });

  socket.on('player_ready', (payload: ReadyPayload, callback?: (response: unknown) => void) => {
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

    // 开局门槛：棋盘规格必须经双方协商同意后才能准备（首局强制协商一次，之后沿用可再改）
    if (payload.ready && !room.specAgreed) {
      callback?.({ ok: false, message: '开局前需先协商棋盘规格：任一方提议并经对方同意后才能开始' });
      return;
    }

    room.readyBySymbol[symbol] = Boolean(payload.ready);
    if (Object.keys(room.claimedEdges).length === 0) {
      room.starter = null;
      room.diceRolls = { A: null, B: null };
    }

    if (room.readyBySymbol.A && room.readyBySymbol.B) {
      invalidatePendingProposal(room);
    }

    reconcileRoomStatus(room);

    callback?.({ ok: true });
    emitRoomState(room.roomId);
  });

  socket.on('roll_dice', (payload: RollDicePayload, callback?: (response: unknown) => void) => {
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

    // 兼容旧版本遗留的同点僵局：新逻辑不会再产生这种状态，但热更新前的房间可能停在这里
    if (
      room.starter === null &&
      typeof room.diceRolls.A === 'number' &&
      typeof room.diceRolls.B === 'number' &&
      room.diceRolls.A === room.diceRolls.B
    ) {
      room.diceRolls = { A: null, B: null };
    }

    if (room.diceRolls[symbol] !== null) {
      callback?.({ ok: false, message: '你已经掷过骰子' });
      return;
    }

    room.diceRolls[symbol] = randomInt(1, 7);

    let a = room.diceRolls.A;
    let b = room.diceRolls.B;
    let rerollTimes = 0;
    // 双方同点时由服务端自动重掷双方，直到分出先后；100 次上限仅为防御性保底（同点概率每次 1/6）
    while (typeof a === 'number' && typeof b === 'number' && a === b && rerollTimes < 100) {
      room.diceRolls = { A: randomInt(1, 7), B: randomInt(1, 7) };
      a = room.diceRolls.A;
      b = room.diceRolls.B;
      rerollTimes += 1;
    }

    if (typeof a === 'number' && typeof b === 'number') {
      room.starter = a > b ? 'A' : 'B';
      room.currentTurn = room.starter;
      const tieNote = rerollTimes > 0 ? `（双方同点 ${a}，已自动重掷 ${rerollTimes} 次）` : '';
      io.to(room.roomId).emit('dice_decided', {
        starter: room.starter,
        diceRolls: room.diceRolls,
        message: `${room.starter} 方先手${tieNote}`,
      });
    }

    reconcileRoomStatus(room);
    callback?.({ ok: true, roll: room.diceRolls[symbol] });
    emitRoomState(room.roomId);
  });

  socket.on('vote_next_round', (payload: VoteNextRoundPayload, callback?: (response: unknown) => void) => {
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

    if (room.status !== 'playing' && room.status !== 'finished') {
      callback?.({ ok: false, message: '当前阶段不能发起重开投票' });
      return;
    }

    // Toggle own vote so the same action doubles as "agree" and "take back agreement".
    const wasFinished = room.status === 'finished';
    if (!wasFinished && hasRoundBeenRecorded(room)) {
      callback?.({ ok: false, message: '当前局面状态异常，无法重开' });
      return;
    }
    room.nextRoundVotes[symbol] = !room.nextRoundVotes[symbol];

    let resetMessage: string | null = null;
    if (room.nextRoundVotes.A && room.nextRoundVotes.B) {
      if (wasFinished) {
        room.roundNumber += 1;
        resetMessage = '双方一致同意，已开启新一局，历史战绩保留。';
      } else {
        // Aborting an unfinished round leaves history/series score untouched.
        resetMessage = `双方一致同意，第 ${room.roundNumber} 局已重新开始。`;
      }
      resetRoundState(room);
      io.to(room.roomId).emit('round_reset', { message: resetMessage });
    }

    callback?.({
      ok: true,
      votes: { ...room.nextRoundVotes },
      voted: room.nextRoundVotes[symbol],
    });
    emitRoomState(room.roomId);
  });

  socket.on('presence_ping', (payload: PresencePingPayload) => {
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

    // nonce 校验：同一页面断线重连（nonce 相同）可重新绑定；
    // 不同页面的 ping 不能抢走已活跃会话，避免双开同令牌时互相干扰
    const samePage = payload.nonce !== undefined && player.nonce === payload.nonce;
    if (player.id !== socket.id && (samePage || !player.connected || player.id.startsWith('offline-'))) {
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

  socket.on('send_chat', (payload: SendChatPayload, callback?: (response: unknown) => void) => {
    const room = rooms.get(payload.roomId);
    if (!room) {
      callback?.({ ok: false, message: '房间不存在' });
      return;
    }

    const symbol = getPlayerSymbol(room, socket.id);
    const player = room.players.find((p) => p.id === socket.id);
    if (!symbol || !player) {
      if (room.spectators.some((sp) => sp.id === socket.id)) {
        callback?.({ ok: false, message: '旁观者不能发送消息' });
      } else {
        callback?.({ ok: false, message: '你不在当前房间中' });
      }
      return;
    }

    const message = payload.message.trim();
    if (!message) {
      callback?.({ ok: false, message: '消息不能为空' });
      return;
    }

    const chatMessage: RoomChatMessage = {
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

  socket.on('propose_board', (payload: ProposeBoardPayload, callback?: (response: unknown) => void) => {
    const room = rooms.get(payload.roomId);
    if (!room) {
      callback?.({ ok: false, message: '房间不存在' });
      return;
    }

    const symbol = getPlayerSymbol(room, socket.id);
    const player = getPlayerBySocket(room, socket.id);
    if (!symbol || !player) {
      callback?.({ ok: false, message: '你不在当前房间中' });
      return;
    }

    if (room.status !== 'waiting') {
      callback?.({ ok: false, message: '只能在开局前的准备阶段提议棋盘规格' });
      return;
    }

    const rows = payload.rows;
    const cols = payload.cols;
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(cols) ||
      rows < MIN_SIZE ||
      rows > MAX_SIZE ||
      cols < MIN_SIZE ||
      cols > MAX_SIZE
    ) {
      callback?.({ ok: false, message: '棋盘规格须为 2 到 8 的整数，例如 5*4' });
      return;
    }

    // 新提议取代旧的未回应提议（也支持对方直接还价）
    invalidatePendingProposal(room);

    const proposalId = Date.now();
    const chatMessage: RoomChatMessage = {
      roomId: room.roomId,
      senderSymbol: symbol,
      senderName: player.name,
      message: `提议棋盘规格 ${rows}*${cols}`,
      timestamp: proposalId,
      kind: 'board-proposal',
      proposal: { id: proposalId, rows, cols, status: 'pending' },
    };
    room.boardProposal = { id: proposalId, rows, cols, by: symbol };
    room.chatHistory.push(chatMessage);
    if (room.chatHistory.length > MAX_CHAT_HISTORY) {
      room.chatHistory = room.chatHistory.slice(-MAX_CHAT_HISTORY);
    }

    io.to(room.roomId).emit('chat_message', chatMessage);
    emitRoomState(room.roomId);
    callback?.({ ok: true });
  });

  socket.on('respond_board', (payload: RespondBoardPayload, callback?: (response: unknown) => void) => {
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

    const proposal = room.boardProposal;
    if (!proposal || proposal.id !== payload.proposalId) {
      callback?.({ ok: false, message: '该提议已失效' });
      return;
    }

    if (proposal.by === symbol) {
      callback?.({ ok: false, message: '不能回应自己的提议' });
      return;
    }

    if (room.status !== 'waiting') {
      callback?.({ ok: false, message: '当前阶段无法处理该提议' });
      return;
    }

    const entry = room.chatHistory.find(
      (msg) => msg.kind === 'board-proposal' && msg.proposal?.id === payload.proposalId,
    );

    if (payload.accept) {
      room.boardRows = sanitizeSize(proposal.rows);
      room.boardCols = sanitizeSize(proposal.cols);
      if (entry?.proposal) {
        entry.proposal.status = 'accepted';
      }
      resetRoundState(room);
      // 重置完成后再解锁：本局以新确认的规格开局（每局开局前都会重新锁定，见 resetRoundState）
      room.specAgreed = true;
      room.specAgreedOnce = true;
      io.to(room.roomId).emit('board_proposal_result', {
        proposalId: payload.proposalId,
        accepted: true,
        message: `双方同意，棋盘规格改为 ${room.boardRows}*${room.boardCols}，请重新准备`,
      });
    } else {
      if (entry?.proposal) {
        entry.proposal.status = 'rejected';
      }
      room.boardProposal = null;
      io.to(room.roomId).emit('board_proposal_result', {
        proposalId: payload.proposalId,
        accepted: false,
        message: `${symbol} 方拒绝了 ${proposal.rows}*${proposal.cols} 的提议`,
      });
    }

    callback?.({ ok: true });
    emitRoomState(room.roomId);
  });

  socket.on('confirm_spec', (payload: ConfirmSpecPayload, callback?: (response: unknown) => void) => {
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

    if (room.status !== 'waiting') {
      callback?.({ ok: false, message: '当前阶段无法确认规格' });
      return;
    }

    // “沿用上一局规格”一键确认：仅当此前协商确认过时可用（首局必须走提议协商）
    if (!room.specAgreedOnce) {
      callback?.({ ok: false, message: '尚无已确认的规格，请先提议并经对方同意' });
      return;
    }

    room.specAgreed = true;
    callback?.({ ok: true, rows: room.boardRows, cols: room.boardCols });
    emitRoomState(room.roomId);
  });

  socket.on('clear_chat', (payload: ClearChatPayload, callback?: (response: unknown) => void) => {
    const room = rooms.get(payload.roomId);
    if (!room) {
      callback?.({ ok: false, message: '房间不存在' });
      return;
    }

    const symbol = getPlayerSymbol(room, socket.id);
    if (!symbol) {
      callback?.({ ok: false, message: room.spectators.some((sp) => sp.id === socket.id) ? '旁观者不能清空聊天' : '你不在当前房间中' });
      return;
    }

    // 仅清空普通消息；未处理的棋盘提议必须保留，等待对方回应
    room.chatHistory = room.chatHistory.filter(
      (msg) => msg.kind === 'board-proposal' && msg.proposal?.status === 'pending',
    );

    callback?.({ ok: true, kept: room.chatHistory.length });
    emitRoomState(room.roomId);
  });

  socket.on('make_move', (payload: MakeMovePayload, callback?: (response: unknown) => void) => {
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
    room.moveOrder.push(payload.edgeId);
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
      const specIdx = room.spectators.findIndex((sp) => sp.id === socket.id);
      if (specIdx >= 0) {
        room.spectators.splice(specIdx, 1);
        emitRoomState(roomId);
      }
      return;
    }

    player.connected = false;
    player.id = `offline-${player.symbol}-${Date.now()}`;
    room.nextRoundVotes[player.symbol] = false;
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
      } else {
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
