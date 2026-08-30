import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { GAME_RULES } from './gameRules';
import {
  allEdges,
  buildPrompt,
  drawBoardImage,
  loadAiConfig,
  parseEdgeReply,
  requestAiMove,
  saveAiConfig,
  type AiConfig,
} from './aiClient';
import './App.css';

export type PlayerSymbol = 'A' | 'B';

type Player = {
  id: string;
  name: string;
  symbol: PlayerSymbol;
  connected?: boolean;
};

type BoardProposalState = {
  id: number;
  rows: number;
  cols: number;
  by: PlayerSymbol;
};

export type RoomState = {
  roomId: string;
  boardRows: number;
  boardCols: number;
  players: Player[];
  readyBySymbol: Record<PlayerSymbol, boolean>;
  currentTurn: PlayerSymbol;
  starter?: PlayerSymbol | null;
  diceRolls?: Record<PlayerSymbol, number | null>;
  claimedEdges: Record<string, PlayerSymbol>;
  claimedBoxes: Record<string, PlayerSymbol>;
  scores: Record<PlayerSymbol, number>;
  roundNumber: number;
  seriesScore: Record<PlayerSymbol, number>;
  roundHistory: RoundHistoryItem[];
  chatHistory?: ChatMessage[];
  nextRoundVotes?: Record<PlayerSymbol, boolean>;
  boardProposal?: BoardProposalState | null;
  spectators?: { id: string; name: string }[];
  specAgreed?: boolean;
  specAgreedOnce?: boolean;
  status: 'waiting' | 'rolling' | 'playing' | 'finished';
  winner: PlayerSymbol | 'draw' | null;
};

type RoundHistoryItem = {
  roundNumber: number;
  boardRows: number;
  boardCols: number;
  starter: PlayerSymbol | null;
  winner: PlayerSymbol | 'draw' | null;
  scores: Record<PlayerSymbol, number>;
  finalClaimedEdges: Record<string, PlayerSymbol>;
  finalClaimedBoxes: Record<string, PlayerSymbol>;
  moveOrder?: string[];
  finishedAt: number;
};

type SessionState = {
  roomId: string;
  playerName: string;
  playerToken: string;
  playerSymbol: PlayerSymbol;
};

type ChatMessage = {
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

type DiceDecisionPayload = {
  starter: PlayerSymbol;
  diceRolls: Record<PlayerSymbol, number | null>;
  message?: string;
};

type SystemMessage = { id: number; text: string };

type StoreState = {
  room: RoomState | null;
  playerSymbol: PlayerSymbol | null;
  systemMessages: SystemMessage[];
  setRoom: (room: RoomState) => void;
  setPlayerSymbol: (symbol: PlayerSymbol | null) => void;
  pushSystemMessage: (text: string) => void;
  reset: () => void;
};

// 游戏服务器地址：
// - 显式设置 VITE_SERVER_URL 时优先（公网部署等场景）
// - 本机 localhost/127.0.0.1 访问 → 走回环 localhost:3001（永不被防火墙拦）
// - 局域网 IP 访问 → 自动跟随页面地址（如 http://10.4.91.32:3001）
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? `${window.location.protocol}//localhost:3001`
    : `${window.location.protocol}//${window.location.hostname}:3001`);
const SESSION_KEY = 'dots_and_boxes_session_v1';
const MIN_SIZE = 2;
const MAX_SIZE = 8;

function loadSession(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed.roomId || !parsed.playerToken) {
      return null;
    }

    return parsed;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

const INITIAL_SESSION = loadSession();

// 地址栏与房间同步：开房/进房后 URL 带 ?room=，可直接分享；退回首页时清除
function syncRoomUrl(roomId: string | null): void {
  try {
    const url = roomId ? `${window.location.pathname}?room=${roomId}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  } catch {
    // 某些嵌入环境不允许改地址，忽略即可
  }
}

function readRoomParam(): string | null {
  try {
    const entry = [...new URLSearchParams(window.location.search).entries()].find(
      ([key]) => key.toLowerCase() === 'room',
    );
    return entry?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

// 玩家身份令牌：按昵称绑定并持久化到 localStorage，同一浏览器同一昵称视为同一人，
// 掉线后凭它恢复对局；换浏览器/换昵称则是新用户（座位被占时需等待）。
type PlayerIdentity = { name: string; token: string };
const IDENTITY_KEY = 'dots_and_boxes_identity_v1';

function readIdentity(): PlayerIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PlayerIdentity;
    if (!parsed?.name || !parsed?.token) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function saveIdentity(identity: PlayerIdentity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // localStorage 不可用（如隐私模式）时忽略，退化为普通会话行为
  }
}

const useGameStore = create<StoreState>((set) => ({
  room: null,
  playerSymbol: INITIAL_SESSION?.playerSymbol ?? null,
  systemMessages: [],
  setRoom: (room) => set({ room }),
  setPlayerSymbol: (playerSymbol) => set({ playerSymbol }),
  pushSystemMessage: (text) => {
    const id = Date.now() + Math.random();
    set((s) => ({ systemMessages: [...s.systemMessages, { id, text }].slice(-4) }));
    window.setTimeout(() => {
      set((s) => ({ systemMessages: s.systemMessages.filter((m) => m.id !== id) }));
    }, 6000);
  },
  reset: () =>
    set({
      room: null,
      playerSymbol: null,
      systemMessages: [],
    }),
}));

// 页面随机标识：服务端用它区分"同页面断线重连"与"另一个标签页抢会话"
const TAB_NONCE = Math.random().toString(36).slice(2);

function edgeId(orientation: 'h' | 'v', row: number, col: number): string {
  return `${orientation}-${row}-${col}`;
}

function parseBoardSpec(spec: string): { rows: number; cols: number } | null {
  const matched = spec.trim().match(/^(\d+)\s*[xX*]\s*(\d+)$/);
  if (!matched) {
    return null;
  }

  const rows = Number(matched[1]);
  const cols = Number(matched[2]);
  if (
    Number.isNaN(rows) ||
    Number.isNaN(cols) ||
    rows < MIN_SIZE ||
    rows > MAX_SIZE ||
    cols < MIN_SIZE ||
    cols > MAX_SIZE
  ) {
    return null;
  }

  return { rows, cols };
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const aiBusyRef = useRef(false);
  const [playerName, setPlayerName] = useState(INITIAL_SESSION?.playerName ?? readIdentity()?.name ?? '');
  const [roomIdInput, setRoomIdInput] = useState(() => {
    // 支持 ?room=XXXX / ?ROOM=xxxx 分享链接：URL 参数优先于本地会话
    return (readRoomParam() ?? INITIAL_SESSION?.roomId ?? '').toUpperCase();
  });
  const [boardSpec, setBoardSpec] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [playerToken, setPlayerToken] = useState(INITIAL_SESSION?.playerToken ?? '');
  const [rollingDice, setRollingDice] = useState(false);
  const [starterModal, setStarterModal] = useState<{ show: boolean; text: string }>({
    show: false,
    text: '',
  });
  const [selectedHistoryRound, setSelectedHistoryRound] = useState<number | null>(null);
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const [replayAuto, setReplayAuto] = useState(false);
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiConfig>(() => loadAiConfig());
  const [aiDraft, setAiDraft] = useState<AiConfig>(() => loadAiConfig());
  const [aiModal, setAiModal] = useState(false);
  const [aiActiveRoom, setAiActiveRoom] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [aiTest, setAiTest] = useState<{ running: boolean; text: string }>({ running: false, text: '' });

  const room = useGameStore((s) => s.room);
  const playerSymbol = useGameStore((s) => s.playerSymbol);
  const systemMessages = useGameStore((s) => s.systemMessages);
  const setRoom = useGameStore((s) => s.setRoom);
  const setPlayerSymbol = useGameStore((s) => s.setPlayerSymbol);
  const pushSystemMessage = useGameStore((s) => s.pushSystemMessage);
  const resetStore = useGameStore((s) => s.reset);

  useEffect(() => {
    if (!rulesOpen) {
      return;
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRulesOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rulesOpen]);

  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      pushSystemMessage('已连接服务器，可创建或加入房间。');

      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) {
        return;
      }

      let parsed: SessionState;
      try {
        parsed = JSON.parse(raw) as SessionState;
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
        return;
      }

      if (!parsed.roomId || !parsed.playerToken) {
        return;
      }

      socket.emit(
        'rejoin_room',
        {
          roomId: parsed.roomId,
          playerToken: parsed.playerToken,
          playerName: parsed.playerName,
          nonce: TAB_NONCE,
        },
        (response: { ok: boolean; symbol?: PlayerSymbol; playerToken?: string; message?: string }) => {
          if (!response.ok) {
            sessionStorage.removeItem(SESSION_KEY);
            resetStore();
            setPlayerSymbol(null);
            setPlayerToken('');
            setSelectedHistoryRound(null);
            setRoomIdInput('');
            pushSystemMessage(response.message || '重连失败，已返回首页。');
            return;
          }

          setPlayerSymbol(response.symbol || parsed.playerSymbol);
          setPlayerToken(response.playerToken || parsed.playerToken);
          pushSystemMessage('已自动恢复到上次房间。');
        },
      );
    });

    socket.on('room_state', (nextRoom: RoomState) => {
      setRoom(nextRoom);
      setChatMessages(nextRoom.chatHistory ?? []);
    });

    socket.on('chat_message', (payload: ChatMessage) => {
      setChatMessages((prev) => [...prev.slice(-79), payload]);
    });

    socket.on('dice_decided', (payload: DiceDecisionPayload) => {
      setRollingDice(false);
      pushSystemMessage(payload.message || `${payload.starter} 方先手`);
      setStarterModal({
        show: true,
        text: payload.message || `${payload.starter} 方先手，比赛开始`,
      });
    });

    socket.on('round_reset', (payload: { message?: string }) => {
      setSelectedHistoryRound(null);
      setStarterModal({ show: false, text: '' });
      pushSystemMessage(payload.message || '新一局已就绪。');
    });

    socket.on('board_proposal_result', (payload: { message?: string }) => {
      pushSystemMessage(payload.message || '棋盘提议已处理。');
    });

    socket.on('player_left', (payload: { message?: string }) => {
      pushSystemMessage(payload.message || '有玩家离开房间。');
    });

    socket.on('disconnect', () => {
      setRollingDice(false);
      pushSystemMessage('与服务器连接断开，请刷新重连。');
    });

    return () => {
      socket.disconnect();
    };
  }, [resetStore, setPlayerSymbol, setRoom, pushSystemMessage]);

  const parsedInputBoard = parseBoardSpec(boardSpec);
  const selectedRound =
    selectedHistoryRound !== null
      ? room?.roundHistory?.find((item) => item.roundNumber === selectedHistoryRound) ?? null
      : null;
  const viewingHistory = Boolean(selectedRound);

  const rows = selectedRound?.boardRows ?? room?.boardRows ?? parsedInputBoard?.rows ?? 4;
  const cols = selectedRound?.boardCols ?? room?.boardCols ?? parsedInputBoard?.cols ?? 4;
  const roomPlayers = room?.players ?? [];
  const playerA = roomPlayers.find((p) => p.symbol === 'A');
  const playerB = roomPlayers.find((p) => p.symbol === 'B');
  const myReady = playerSymbol ? room?.readyBySymbol?.[playerSymbol] ?? false : false;
  const myDice = playerSymbol ? room?.diceRolls?.[playerSymbol] ?? null : null;
  const hasActiveRoom = Boolean(room);
  const isTieAwaitingReroll = Boolean(
    room?.status === 'rolling' &&
      typeof room?.diceRolls?.A === 'number' &&
      typeof room?.diceRolls?.B === 'number' &&
      room?.diceRolls?.A === room?.diceRolls?.B,
  );
  const canRollDice = Boolean(
    room && playerSymbol && room.status === 'rolling' && (myDice === null || isTieAwaitingReroll),
  );
  const bothPlayersReady = Boolean(room?.readyBySymbol?.A && room?.readyBySymbol?.B);
  const roundHistory = room?.roundHistory ?? [];

  const aiActive = Boolean(room && aiActiveRoom === room.roomId);
  // 棋盘最大边 ≥ 6（含 6*6、6*7、7*8、8*8 等所有组合）时开放接入 AI
  const aiAvailable = Boolean(room && playerSymbol && (rows >= 6 || cols >= 6));

  const voteA = room?.nextRoundVotes?.A ?? false;
  const voteB = room?.nextRoundVotes?.B ?? false;
  const myVote = playerSymbol === 'A' ? voteA : playerSymbol === 'B' ? voteB : false;

  const displayStatus = selectedRound ? 'finished' : room?.status;
  const displayWinner = selectedRound?.winner ?? room?.winner;
  const displayStarter = selectedRound?.starter ?? room?.starter ?? null;
  const displayScores = selectedRound?.scores ?? room?.scores ?? { A: 0, B: 0 };
  const displayClaimedEdges = selectedRound?.finalClaimedEdges ?? room?.claimedEdges ?? {};
  const displayClaimedBoxes = selectedRound?.finalClaimedBoxes ?? room?.claimedBoxes ?? {};

  // 回放模式：按落子顺序截断到第 replayStep 手（盒子归属=完成该盒的那条边的主人）
  let shownEdges = displayClaimedEdges;
  let shownBoxes = displayClaimedBoxes;
  if (viewingHistory && selectedRound?.moveOrder && replayStep !== null) {
    const seq = selectedRound.moveOrder.slice(0, replayStep);
    const edges: Record<string, PlayerSymbol> = {};
    seq.forEach((eid) => {
      const owner = selectedRound.finalClaimedEdges[eid];
      if (owner) {
        edges[eid] = owner;
      }
    });
    const boxes: Record<string, PlayerSymbol> = {};
    Object.entries(selectedRound.finalClaimedBoxes).forEach(([boxKey, owner]) => {
      const [r, c] = boxKey.split('-').map(Number);
      const four = [`h-${r}-${c}`, `h-${r + 1}-${c}`, `v-${r}-${c}`, `v-${r}-${c + 1}`];
      const idxs = four.map((e) => seq.indexOf(e));
      if (idxs.every((i) => i >= 0)) {
        const lastIdx = Math.max(...idxs);
        boxes[boxKey] = selectedRound.finalClaimedEdges[four[idxs.indexOf(lastIdx)]] ?? owner;
      }
    });
    shownEdges = edges;
    shownBoxes = boxes;
  }
  const displayRoundNumber = selectedRound?.roundNumber ?? room?.roundNumber ?? 1;
  const canMakeMove = useMemo(() => {
    if (!room || !playerSymbol || viewingHistory) {
      return false;
    }
    return room.status === 'playing' && room.currentTurn === playerSymbol;
  }, [playerSymbol, room, viewingHistory]);

  const restartAvailable = Boolean(
    room && playerSymbol && !viewingHistory && (displayStatus === 'playing' || displayStatus === 'finished'),
  );

  // 开局前的等待阶段允许协商棋盘规格；每局重开回到等待阶段后可再次提议
  const canProposeBoard = Boolean(room && playerSymbol && room.status === 'waiting' && !viewingHistory);

  const statusDisplayText =
    displayStatus === 'waiting'
      ? (room?.players.length ?? 0) < 2
        ? '等待玩家加入'
        : '等待双方准备'
      : displayStatus === 'rolling'
        ? '掷骰决定先手'
        : displayStatus === 'playing'
          ? '对局进行中'
          : displayStatus === 'finished'
            ? '对局已结束'
            : 'idle';

  useEffect(() => {
    if (!room || !playerToken || !playerSymbol || !playerName.trim()) {
      return;
    }

    const session: SessionState = {
      roomId: room.roomId,
      playerName: playerName.trim(),
      playerToken,
      playerSymbol,
    };

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [playerName, playerSymbol, playerToken, room]);

  useEffect(() => {
    const el = chatListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages]);

  // 自动回放：逐步前进到终局（到终点自动停止）
  useEffect(() => {
    if (!replayAuto || !viewingHistory || replayStep === null) {
      return;
    }

    const total = selectedRound?.moveOrder?.length ?? 0;
    if (replayStep >= total) {
      return;
    }

    const timer = window.setTimeout(() => {
      const next = replayStep + 1;
      setReplayStep(next);
      if (next >= total) {
        setReplayAuto(false);
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [replayAuto, viewingHistory, replayStep, selectedRound]);

  // AI 驱动状态机：接入后自动完成确认规格/提议规格/准备/掷骰/落子与跟随投票。
  // 未填 API Key 时退化为随机落子（可作为陪练机器人）。
  useEffect(() => {
    if (!aiActive || !room || !playerSymbol) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (aiBusyRef.current) {
        return;
      }

      aiBusyRef.current = true;
      void (async () => {
        try {
          const me = playerSymbol;

          if (room.status === 'waiting') {
            if (!room.specAgreed) {
              // 对方提议的规格：AI 自动同意，保证双 AI / AI 对真人都能开局
              if (room.boardProposal && room.boardProposal.by !== me) {
                await aiEmit('respond_board', {
                  roomId: room.roomId,
                  proposalId: room.boardProposal.id,
                  accept: true,
                });
                return;
              }
              if (room.specAgreedOnce) {
                await aiEmit('confirm_spec', { roomId: room.roomId });
              } else if (!room.boardProposal) {
                await aiEmit('propose_board', {
                  roomId: room.roomId,
                  rows: room.boardRows,
                  cols: room.boardCols,
                });
              }
              return;
            }

            if (!room.readyBySymbol[me]) {
              await aiEmit('player_ready', { roomId: room.roomId, ready: true });
              return;
            }
            return;
          }

          if (room.status === 'rolling' && room.diceRolls?.[me] === null) {
            await aiEmit('roll_dice', { roomId: room.roomId });
            return;
          }

          if (room.status === 'playing' && room.currentTurn === me) {
            const valid = allEdges(room.boardRows, room.boardCols).filter(
              (e) => !room.claimedEdges[e],
            );
            if (valid.length === 0) {
              return;
            }

            setAiThinking(true);
            let edge: string | null = null;
            if (aiConfig.apiKey) {
              try {
                const image = aiConfig.useVision ? drawBoardImage(room) : null;
                const reply = await requestAiMove(
                  aiConfig,
                  buildPrompt(room, me, valid),
                  image,
                  SERVER_URL,
                );
                edge = parseEdgeReply(reply, valid);
              } catch {
                // 出错不断开：随机兜底继续走（斗蛐蛐模式）
              }
            }
            setAiThinking(false);
            if (!edge) {
              edge = valid[Math.floor(Math.random() * valid.length)];
            }
            await aiEmit('make_move', { roomId: room.roomId, edgeId: edge });
            return;
          }

          if (room.status === 'finished' && room.nextRoundVotes) {
            // 无人发起时主动发起，对方已发起则跟随——保证 AI 对局能连续进行
            if (!room.nextRoundVotes[me]) {
              await aiEmit('vote_next_round', { roomId: room.roomId });
            }
          }
        } finally {
          aiBusyRef.current = false;
        }
      })();
    }, aiConfig.intervalMs);

    return () => window.clearTimeout(timer);
  }, [aiActive, room, playerSymbol, aiConfig, pushSystemMessage]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !room || !playerToken) {
      return;
    }

    const ping = () => {
      socket.emit('presence_ping', {
        roomId: room.roomId,
        playerToken,
        nonce: TAB_NONCE,
      });
    };

    ping();
    const timer = window.setInterval(ping, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [playerToken, room]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const allOnline = room.players.length === 2 && room.players.every((p) => p.connected !== false);
    const offlineNoticeShown = systemMessages.some((m) => m.text.includes('暂时离线'));
    const onlineNoticeShown = systemMessages.some((m) => m.text.includes('双方在线'));
    if (allOnline && offlineNoticeShown && !onlineNoticeShown) {
      pushSystemMessage('双方在线，可继续对局。');
    }
  }, [room, pushSystemMessage, systemMessages]);

  const winnerDisplayText =
    displayWinner === 'draw' ? '平局' : displayWinner ? `${displayWinner} 方胜利` : '对局结束';
  const winnerName =
    displayWinner === 'A' ? playerA?.name : displayWinner === 'B' ? playerB?.name : undefined;

  const aActive = Boolean(displayStatus === 'playing' && !viewingHistory && room?.currentTurn === 'A');
  const bActive = Boolean(displayStatus === 'playing' && !viewingHistory && room?.currentTurn === 'B');

  let medalKind: 'a' | 'b' | 'neutral' = 'neutral';
  let medalSymbol: string = '⏳';
  let medalLabel: string = (room?.players.length ?? 0) < 2 ? '等待加入' : '待准备';
  if (displayStatus === 'playing') {
    medalKind = room?.currentTurn === 'A' ? 'a' : 'b';
    medalSymbol = medalKind.toUpperCase();
    medalLabel = '当前回合';
  } else if (displayStatus === 'rolling') {
    medalSymbol = '🎲';
    medalLabel = '掷骰中';
  } else if (displayStatus === 'finished') {
    if (displayWinner === 'A' || displayWinner === 'B') {
      medalKind = displayWinner === 'A' ? 'a' : 'b';
      medalSymbol = '🏆';
      medalLabel = `${displayWinner} 获胜`;
    } else {
      medalSymbol = '🤝';
      medalLabel = '平局';
    }
  }

  const bannerText =
    displayStatus === 'playing'
      ? canMakeMove
        ? '🎯 轮到你了！点击棋盘上的边线落子'
        : `等待 ${room?.currentTurn ?? '-'} 方行动…`
      : displayStatus === 'rolling'
        ? '🎲 双方掷骰决定先手中…'
        : displayStatus === 'finished'
          ? `对局结束：${winnerDisplayText}`
          : (room?.players.length ?? 0) < 2
            ? '等待对手加入房间…'
            : '双方都点“准备开始”后进入掷骰阶段';

  const bannerKind =
    displayStatus === 'playing'
      ? room?.currentTurn === 'A'
        ? 'a'
        : 'b'
      : displayStatus === 'finished'
        ? 'finished'
        : 'idle';

  const starterChipText = displayStarter
    ? `先手 ${displayStarter}`
    : displayStatus === 'rolling'
      ? '先手 掷骰中'
      : '先手 未定';

  const totalMoves = selectedRound?.moveOrder?.length ?? 0;
  const isSpectator = Boolean(room && !playerSymbol);
  // 首局开局门槛：规格须经双方协商同意后才能准备
  const needsSpecAgreement = Boolean(
    room && playerSymbol && room.status === 'waiting' && room.specAgreed === false,
  );
  const pendingProposalForMe = room?.boardProposal ?? null;

  function confirmSpec(): void {
    if (!room) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'confirm_spec',
      { roomId: room.roomId },
      (response: { ok: boolean; rows?: number; cols?: number; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '确认规格失败。');
          return;
        }

        pushSystemMessage(`已沿用 ${response.rows}*${response.cols} 规格，可以准备开局了。`);
      },
    );
  }

  function selectHistoryRound(roundNumber: number | null): void {
    setSelectedHistoryRound(roundNumber);
    setReplayAuto(false);
    setReplayStep(null);
  }

  function fallbackCopyText(text: string, onDone: () => void): void {
    // http 局域网等非安全上下文没有 navigator.clipboard：临时 textarea + execCommand 兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) {
      onDone();
    } else {
      pushSystemMessage('复制失败，请手动记录房间号。');
    }
  }

  function copyRoomId(): void {
    const id = room?.roomId;
    if (!id) {
      return;
    }

    const done = () => {
      setCopiedRoom(true);
      window.setTimeout(() => setCopiedRoom(false), 1600);
    };

    // 复制纯房间号：局域网 http 环境对方直接在房号输入即可，最通用
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(id)
        .then(done)
        .catch(() => fallbackCopyText(id, done));
      return;
    }

    fallbackCopyText(id, done);
  }

  function createRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    if (!playerName.trim()) {
      pushSystemMessage('请先输入昵称。');
      return;
    }

    // 规格可留空：默认 4*4，进房后可在开局前与对方协商修改
    const parsed = boardSpec.trim() ? parseBoardSpec(boardSpec) : { rows: 4, cols: 4 };
    if (!parsed) {
      pushSystemMessage('棋盘格式请使用 m*n，且 m、n 范围为 2 到 8，例如 4*8。');
      return;
    }

    const trimmedName = playerName.trim();
    const remembered = readIdentity();
    const tokenToSend = playerToken || (remembered?.name === trimmedName ? remembered.token : undefined);

    socket.emit(
      'create_room',
      {
        playerName: trimmedName,
        playerToken: tokenToSend,
        boardRows: parsed.rows,
        boardCols: parsed.cols,
      },
      (response: {
        ok: boolean;
        roomId?: string;
        symbol?: PlayerSymbol;
        playerToken?: string;
        message?: string;
      }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '创建房间失败。');
          return;
        }

        if (response.playerToken) {
          saveIdentity({ name: trimmedName, token: response.playerToken });
        }
        setPlayerSymbol(response.symbol || null);
        setPlayerToken(response.playerToken || playerToken);
        setRoomIdInput(response.roomId || '');
        setSelectedHistoryRound(null);
        setChatMessages([]);
        syncRoomUrl(response.roomId ?? null);
        pushSystemMessage(
          `房间已创建：${response.roomId}（当前规格 ${parsed.rows}*${parsed.cols}，开局前需双方协商确认）`,
        );
      },
    );
  }

  function joinRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    if (!playerName.trim()) {
      pushSystemMessage('请先输入昵称。');
      return;
    }

    if (!roomIdInput.trim()) {
      pushSystemMessage('请输入房间号。');
      return;
    }

    const trimmedName = playerName.trim();
    const remembered = readIdentity();
    const tokenToSend = playerToken || (remembered?.name === trimmedName ? remembered.token : undefined);

    socket.emit(
      'join_room',
      {
        roomId: roomIdInput.trim().toUpperCase(),
        playerName: trimmedName,
        playerToken: tokenToSend,
        nonce: TAB_NONCE,
      },
      (response: {
        ok: boolean;
        roomId?: string;
        symbol?: PlayerSymbol;
        playerToken?: string;
        spectator?: boolean;
        message?: string;
      }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '加入房间失败。');
          return;
        }

        if (response.spectator) {
          setPlayerSymbol(null);
          setPlayerToken('');
          setRoomIdInput(response.roomId || roomIdInput.trim().toUpperCase());
          setSelectedHistoryRound(null);
          setChatMessages([]);
          syncRoomUrl(response.roomId ?? null);
          pushSystemMessage('房间满员，已以旁观者身份进入（只读，可查看棋盘与聊天）');
          return;
        }

        if (response.playerToken) {
          saveIdentity({ name: trimmedName, token: response.playerToken });
        }
        setPlayerSymbol(response.symbol || null);
        setPlayerToken(response.playerToken || playerToken);
        setRoomIdInput(response.roomId || roomIdInput.trim().toUpperCase());
        setSelectedHistoryRound(null);
        setChatMessages([]);
        syncRoomUrl(response.roomId ?? null);
        pushSystemMessage(`成功加入房间：${response.roomId}（开局前需与对方协商棋盘规格）`);
      },
    );
  }

  function toggleReady(): void {
    if (!room || !playerSymbol) {
      pushSystemMessage('先加入房间后再准备。');
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'player_ready',
      { roomId: room.roomId, ready: !myReady },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '设置准备状态失败。');
        }
      },
    );
  }

  function rollDice(): void {
    if (!room || !canRollDice) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    setRollingDice(true);
    socket.emit(
      'roll_dice',
      { roomId: room.roomId },
      (response: { ok: boolean; message?: string }) => {
        setRollingDice(false);
        if (!response.ok) {
          pushSystemMessage(response.message || '掷骰失败。');
        }
      },
    );
  }

  function proposeBoard(): void {
    if (!room || !canProposeBoard) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    const parsed = parseBoardSpec(boardSpec);
    if (!parsed) {
      pushSystemMessage('提议的棋盘格式须为 m*n，m、n 取值 2 到 8，例如 5*4。');
      return;
    }

    socket.emit(
      'propose_board',
      { roomId: room.roomId, rows: parsed.rows, cols: parsed.cols },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '提议失败。');
          return;
        }

        pushSystemMessage(`已向对方提议棋盘 ${parsed.rows}*${parsed.cols}，等待对方在聊天中回应。`);
      },
    );
  }

  function respondBoard(proposalId: number, accept: boolean): void {
    if (!room) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'respond_board',
      { roomId: room.roomId, proposalId, accept },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '回应提议失败。');
        }
      },
    );
  }

  function clearChat(): void {
    if (!room) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit('clear_chat', { roomId: room.roomId }, (response: { ok: boolean; message?: string }) => {
      if (!response.ok) {
        pushSystemMessage(response.message || '清空聊天失败。');
      }
    });
  }

  function openAiModal(): void {
    setAiDraft(loadAiConfig());
    setAiModal(true);
    setAiTest({ running: false, text: '' });
  }

  // 用当前草稿配置发一次最小请求，验证端点/Key/模型是否可用
  async function testAiConnection(): Promise<void> {
    setAiTest({ running: true, text: '' });
    const target = `${aiDraft.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
    try {
      const res = await fetch(`${SERVER_URL.replace(/\/+$/, '')}/ai/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: target,
          key: aiDraft.apiKey.trim(),
          body: {
            model: aiDraft.model.trim(),
            messages: [{ role: 'user', content: '只回复：ok' }],
            max_tokens: 16,
          },
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try {
          reason = JSON.parse(text).error?.message ?? text.slice(0, 120) ?? reason;
        } catch {
          reason = text.slice(0, 120) || reason;
        }
        setAiTest({ running: false, text: `✗ ${reason}` });
        return;
      }

      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      setAiTest({ running: false, text: '✓ 连接成功，模型已响应' });
      void data;
    } catch (e) {
      setAiTest({ running: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function deactivateAi(): void {
    setAiActiveRoom(null);
    setAiThinking(false);
    pushSystemMessage('已断开 AI。');
  }

  function saveAndActivateAi(): void {
    if (!room) {
      return;
    }

    const config: AiConfig = {
      baseUrl: aiDraft.baseUrl.trim() || 'https://api.openai.com/v1',
      apiKey: aiDraft.apiKey.trim(),
      model: aiDraft.model.trim() || 'gpt-4o-mini',
      intervalMs: Math.max(300, Math.floor(aiDraft.intervalMs) || 1000),
      useVision: aiDraft.useVision,
    };

    // 密钥安全：只允许 HTTPS（本地调试可用 localhost），防止 Key 明文跨网络
    if (!/^https:\/\//i.test(config.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(config.baseUrl)) {
      pushSystemMessage('为保护密钥安全，API 地址必须使用 HTTPS（本地调试可用 http://localhost）。');
      return;
    }

    if (!config.apiKey) {
      pushSystemMessage('未填写 API Key：AI 将随机落子，可作为陪练机器人。');
    }

    setAiConfig(config);
    saveAiConfig(config);
    setAiModal(false);
    setShowKey(false);
    setAiActiveRoom(room.roomId);
    pushSystemMessage(
      config.apiKey ? 'AI 已接入，将代你完成确认规格、准备、掷骰与落子。' : 'AI 陪练已接入（随机落子模式）。',
    );
    socketRef.current?.emit('send_chat', {
      roomId: room.roomId,
      message: config.apiKey ? '🤖 我已接入 AI 代打' : '🤖 我已接入 AI 陪练（随机落子）',
    });
  }

  function aiEmit(event: string, payload: Record<string, unknown>): Promise<{ ok?: boolean }> {
    return new Promise((resolve) => {
      socketRef.current?.emit(event, payload, (res: unknown) => resolve((res ?? {}) as { ok?: boolean }));
    });
  }

  function renderChatBody(item: ChatMessage) {
    if (item.kind === 'board-proposal' && item.proposal) {
      const proposal = item.proposal;
      const mine = item.senderSymbol === playerSymbol;
      return (
        <div className="chat-proposal">
          <span className="chat-text">{item.message}</span>
          <span className={`proposal-status proposal-${proposal.status}`}>
            {proposal.status === 'pending'
              ? mine
                ? '等待对方回应…'
                : '请在下方回应'
              : proposal.status === 'accepted'
                ? '✓ 已同意，规格已生效'
                : '✗ 已拒绝'}
          </span>
          {proposal.status === 'pending' && !mine && (
            <div className="proposal-actions">
              <button type="button" onClick={() => respondBoard(proposal.id, true)}>
                同意
              </button>
              <button type="button" className="secondary" onClick={() => respondBoard(proposal.id, false)}>
                拒绝
              </button>
            </div>
          )}
        </div>
      );
    }

    return <span className="chat-text">{item.message}</span>;
  }

  function voteNextRound(): void {    if (!room) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'vote_next_round',
      { roomId: room.roomId },
      (response: { ok: boolean; voted?: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '重开投票失败。');
          return;
        }

        pushSystemMessage(
          response.voted
            ? '你已同意重开，等待对方同意…（再次点击可撤回）'
            : '已撤回重开同意。',
        );
      },
    );
  }

  // Shift/Ctrl+Enter 在光标处插入换行；手动插入以保证各浏览器（含 Ctrl+Enter 无默认行为的）表现一致
  function insertNewlineAtCaret(): void {
    const el = chatInputRef.current;
    if (!el) {
      setChatInput((prev) => `${prev}\n`);
      return;
    }

    const start = el.selectionStart ?? chatInput.length;
    const end = el.selectionEnd ?? chatInput.length;
    setChatInput(`${chatInput.slice(0, start)}\n${chatInput.slice(end)}`);
    window.requestAnimationFrame(() => {
      el.selectionStart = start + 1;
      el.selectionEnd = start + 1;
    });
  }

  function sendChat(): void {    if (!room) {
      pushSystemMessage('先加入房间后再发送消息。');
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    const message = chatInput.trim();
    if (!message) {
      return;
    }

    socket.emit(
      'send_chat',
      { roomId: room.roomId, message },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '发送消息失败。');
          return;
        }

        setChatInput('');
      },
    );
  }

  function makeMove(targetEdgeId: string): void {
    if (!room || !canMakeMove) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'make_move',
      { roomId: room.roomId, edgeId: targetEdgeId },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          pushSystemMessage(response.message || '落子失败。');
        }
      },
    );
  }

  function resetLocal(): void {
    resetStore();
    sessionStorage.removeItem(SESSION_KEY);
    setPlayerSymbol(null);
    setPlayerToken('');
    setRoomIdInput('');
    setBoardSpec('');
    setChatInput('');
    setChatMessages([]);
    setRollingDice(false);
    setStarterModal({ show: false, text: '' });
    setSelectedHistoryRound(null);
    setAiActiveRoom(null);
    syncRoomUrl(null);
  }

  return (
    <div className="page">
      <header className="hero">
        <button type="button" className="rules-btn" onClick={() => setRulesOpen(true)}>
          查看规则
        </button>
        <h1>Dots and Boxes</h1>
      </header>

      <div className="layout">
        <aside className="panel controls">
          <section className="side-section">
            <div className="side-title">房间</div>
            <div className="field-row">
              <label htmlFor="name">昵称</label>
              <input
                id="name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                placeholder="例如：Alice"
                maxLength={20}
                disabled={hasActiveRoom}
              />
            </div>

            <div
              key={room?.roomId ?? 'lobby'}
              className={`field-row ${
                canProposeBoard && playerSymbol ? `spec-row-active spec-${playerSymbol.toLowerCase()}` : ''
              }`}
            >
              <label htmlFor="size">规格</label>
              <input
                id="size"
                value={hasActiveRoom ? (canProposeBoard ? boardSpec : `${rows}*${cols}`) : boardSpec}
                onChange={(e) => setBoardSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) {
                    return;
                  }
                  e.preventDefault();
                  if (!hasActiveRoom) {
                    createRoom();
                  } else if (canProposeBoard) {
                    proposeBoard();
                  }
                  e.currentTarget.blur();
                }}
                placeholder="m*n，如 4*5"
                disabled={viewingHistory || (hasActiveRoom && !canProposeBoard)}
              />
              {!hasActiveRoom ? (
                <button type="button" onClick={createRoom}>
                  创建房间
                </button>
              ) : canProposeBoard ? (
                <button type="button" onClick={proposeBoard}>
                  提议规格
                </button>
              ) : null}
            </div>

            <div className="field-row">
              <label htmlFor="room">房号</label>
              <input
                id="room"
                value={roomIdInput}
                onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (roomIdInput.trim() && !hasActiveRoom) {
                      joinRoom();
                    }
                    e.currentTarget.blur();
                  }
                }}
                placeholder="6 位房间号"
                disabled={hasActiveRoom}
              />
              <button type="button" onClick={joinRoom} disabled={hasActiveRoom}>
                加入房间
              </button>
            </div>
            {!hasActiveRoom && <p className="hint">创建可留空（默认 4*4）；m、n 取值 2 到 8。</p>}
            {hasActiveRoom && !canProposeBoard && (
              <p className="hint">规格已锁定，下一局开始前可再协商。</p>
            )}
          </section>

          <section className="side-section">
            <div className="side-title">操作</div>
            <div className="action-stack">
              <button
                type="button"
                onClick={toggleReady}
                className={myReady ? 'ready-btn ready-on block-btn' : 'ready-btn block-btn'}
                disabled={needsSpecAgreement}
                title={needsSpecAgreement ? '需先协商棋盘规格' : undefined}
              >
                {myReady ? '取消准备' : '准备开始'}
              </button>
              {needsSpecAgreement && (
                <p className="hint spec-lock-hint">
                  <span>🔒 需先协商棋盘规格</span>
                  <span>提议并经对方同意后才能准备开局</span>
                </p>
              )}
              {room?.status === 'rolling' && (
                <button
                  type="button"
                  onClick={rollDice}
                  className={`dice-btn block-btn ${rollingDice ? 'dice-rolling' : ''}`}
                  disabled={!canRollDice || rollingDice}
                >
                  {rollingDice ? '掷骰中...' : isTieAwaitingReroll ? '重新掷骰' : '掷骰决定先手'}
                </button>
              )}
              {restartAvailable && (
                <div className="restart-box">
                  <div className="restart-title">
                    {displayStatus === 'playing' ? '重开本局（需双方同意）' : '开启下一局（需双方同意）'}
                  </div>
                  <button type="button" onClick={voteNextRound} className={myVote ? 'secondary block-btn' : 'block-btn'}>
                    {myVote
                      ? '撤回我的同意'
                      : displayStatus === 'playing'
                        ? '我同意重开'
                        : '我同意下一局'}
                  </button>
                  <div className="restart-status">
                    <span className={`vote-pill ${voteA ? 'voted' : ''}`}>A {voteA ? '✓' : '—'}</span>
                    <span className={`vote-pill ${voteB ? 'voted' : ''}`}>B {voteB ? '✓' : '—'}</span>
                  </div>
                </div>
              )}
              <button type="button" onClick={resetLocal} className="secondary block-btn">
                退回首页
              </button>
              {hasActiveRoom && (
                <button type="button" onClick={resetLocal} className="block-btn" title="离开当前房间并回到创建界面">
                  新建房间
                </button>
              )}
              {aiAvailable && (
                <>
                  <button
                    type="button"
                    className="block-btn"
                    onClick={() => (aiActive ? deactivateAi() : openAiModal())}
                  >
                    {aiActive ? '断开 AI' : '接入 AI'}
                  </button>
                  {aiActive && (
                    <p className="hint ai-status">
                      🤖 AI {aiThinking ? '思考中…' : '待机'}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="system-messages">
              {systemMessages.map((m) => (
                <p key={m.id} className="message">
                  {m.text}
                </p>
              ))}
            </div>
          </section>

          <section className="side-section history-section">
            <div className="side-title">对战统计</div>
            <div className="history-summary">
              <span className="series-count">共 {roundHistory.length} 局</span>
              <div className="series-score">
                <span className="series-side series-a">A</span>
                <span className="series-num">{room?.seriesScore?.A ?? 0}</span>
                <span className="series-sep">:</span>
                <span className="series-num">{room?.seriesScore?.B ?? 0}</span>
                <span className="series-side series-b">B</span>
              </div>
            </div>
            {roundHistory.length === 0 && <div className="history-empty">暂无历史对局</div>}
            <div className="history-list">
              {roundHistory
                .slice()
                .sort((a, b) => b.roundNumber - a.roundNumber)
                .map((item) => {
                  const itemWinner = item.winner === 'draw' ? '平局' : item.winner ? `${item.winner} 胜` : '-';
                  return (
                    <button
                      key={item.roundNumber}
                      type="button"
                      className={`history-item ${selectedHistoryRound === item.roundNumber ? 'history-item-active' : ''}`}
                      onClick={() => selectHistoryRound(item.roundNumber)}
                    >
                      <div className="history-item-head">
                        第 {item.roundNumber} 局 · {item.boardRows}*{item.boardCols}
                      </div>
                      <div>
                        先手 {item.starter ?? '-'} · 比分 A {item.scores.A} - B {item.scores.B} · {itemWinner}
                      </div>
                    </button>
                  );
                })}
            </div>
            {viewingHistory && (
              <button type="button" className="secondary block-btn" onClick={() => selectHistoryRound(null)}>
                返回当前对局
              </button>
            )}
          </section>
        </aside>

        <main className="main-area">
          <section className="panel match-header">
            <div className="match-meta-row">
              <span className="round-badge">第 {displayRoundNumber} 局</span>
              {room?.roomId ? (
                <button type="button" className="meta-chip chip-copy" onClick={copyRoomId} title="点击复制房间号">
                  {copiedRoom ? '已复制 ✓' : `房间 ${room.roomId} ⧉`}
                </button>
              ) : (
                <span className="meta-chip">房间 未进入</span>
              )}
              <span className="meta-chip">{rows}*{cols}</span>
              <span className={`state-chip state-${displayStatus ?? 'idle'}`}>{statusDisplayText}</span>
              <span className="meta-chip">{starterChipText}</span>
              {(room?.spectators?.length ?? 0) > 0 && (
                <span className="meta-chip">👁 旁观 {room?.spectators?.length} 人</span>
              )}
            </div>

            <div className="score-row">
              <div className={`score-card score-a ${aActive ? 'score-active' : ''} ${playerSymbol === 'A' ? 'score-mine' : ''}`}>
                <div className="score-top">
                  <span className="score-side">A 方</span>
                  {playerSymbol === 'A' && <span className="you-tag">你</span>}
                  <span className="online-tag">{playerA?.connected === false ? '离线' : '在线'}</span>
                  <span className="ready-tag">{room?.readyBySymbol?.A ? '已准备' : '未准备'}</span>
                  {bothPlayersReady && (
                    <span
                      className={`dice-tag ${room?.status === 'rolling' && room?.diceRolls?.A === null ? 'dice-waiting' : ''}`}
                    >
                      🎲 {room?.diceRolls?.A ?? '-'}
                    </span>
                  )}
                </div>
                <div className="score-name">
                  {playerA?.name || '等待加入'}
                  {aiActive && playerSymbol === 'A' ? ' 🤖' : ''}
                </div>
                <div className="score-bottom">
                  {aActive && <span className="playing-tag">行动中</span>}
                  <strong>{displayScores.A}</strong>
                </div>
              </div>

              <div className={`turn-medal turn-medal-${medalKind}`}>
                <span className="medal-symbol">{medalSymbol}</span>
                <span className="medal-label">{medalLabel}</span>
              </div>

              <div className={`score-card score-b ${bActive ? 'score-active' : ''} ${playerSymbol === 'B' ? 'score-mine' : ''}`}>
                <div className="score-top">
                  <span className="score-side">B 方</span>
                  {playerSymbol === 'B' && <span className="you-tag">你</span>}
                  <span className="online-tag">{playerB?.connected === false ? '离线' : '在线'}</span>
                  <span className="ready-tag">{room?.readyBySymbol?.B ? '已准备' : '未准备'}</span>
                  {bothPlayersReady && (
                    <span
                      className={`dice-tag ${room?.status === 'rolling' && room?.diceRolls?.B === null ? 'dice-waiting' : ''}`}
                    >
                      🎲 {room?.diceRolls?.B ?? '-'}
                    </span>
                  )}
                </div>
                <div className="score-name">
                  {playerB?.name || '等待加入'}
                  {aiActive && playerSymbol === 'B' ? ' 🤖' : ''}
                </div>
                <div className="score-bottom">
                  {bActive && <span className="playing-tag">行动中</span>}
                  <strong>{displayScores.B}</strong>
                </div>
              </div>
            </div>

            <div className={`turn-banner banner-${bannerKind}`}>
              <span>{bannerText}</span>
            </div>
          </section>

          <section
            className={`panel board-wrap ${
              canMakeMove ? (playerSymbol === 'A' ? 'glow-a' : 'glow-b') : ''
            }`}
          >
            <div className="board">
              {Array.from({ length: rows + 1 }).map((_, r) => (
                <div key={`row-group-${r}`}>
                  <div className="line-row" style={{ gridTemplateColumns: `repeat(${cols}, var(--dot-size) var(--edge-span)) var(--dot-size)` }}>
                    {Array.from({ length: cols }).flatMap((__, c) => {
                      const hEdge = edgeId('h', r, c);
                      const hOwner = shownEdges[hEdge];
                      return [
                        <span key={`${hEdge}-dot`} className="dot" />,
                        <button
                          key={hEdge}
                          type="button"
                          className={`edge h ${hOwner ? `owned-${hOwner}` : ''} ${canMakeMove && !hOwner ? `can-play can-play-${playerSymbol}` : ''}`}
                          disabled={!canMakeMove || Boolean(hOwner)}
                          onClick={() => makeMove(hEdge)}
                          aria-label={hEdge}
                        />,
                      ];
                    })}
                    <span className="dot" />
                  </div>

                  {r < rows && (
                    <div className="box-row" style={{ gridTemplateColumns: `repeat(${cols}, var(--dot-size) var(--edge-span)) var(--dot-size)` }}>
                      {Array.from({ length: cols }).flatMap((__, c) => {
                        const leftEdge = edgeId('v', r, c);
                        const boxKey = `${r}-${c}`;
                        const boxOwner = shownBoxes[boxKey];
                        const edgeOwner = shownEdges[leftEdge];
                        return [
                          <button
                            key={leftEdge}
                            type="button"
                            className={`edge v ${edgeOwner ? `owned-${edgeOwner}` : ''} ${canMakeMove && !edgeOwner ? `can-play can-play-${playerSymbol}` : ''}`}
                            disabled={!canMakeMove || Boolean(edgeOwner)}
                            onClick={() => makeMove(leftEdge)}
                            aria-label={leftEdge}
                          />,
                          <div key={boxKey} className={`box ${boxOwner ? `box-${boxOwner}` : ''}`}>
                            {boxOwner || ''}
                          </div>,
                        ];
                      })}

                      {(() => {
                        const rightEdge = edgeId('v', r, cols);
                        const rightOwner = shownEdges[rightEdge];
                        return (
                          <button
                            type="button"
                            className={`edge v ${rightOwner ? `owned-${rightOwner}` : ''} ${canMakeMove && !rightOwner ? `can-play can-play-${playerSymbol}` : ''}`}
                            disabled={!canMakeMove || Boolean(rightOwner)}
                            onClick={() => makeMove(rightEdge)}
                            aria-label={rightEdge}
                          />
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {viewingHistory && totalMoves > 0 && (
              <div className="replay-bar">
                <span className="replay-label">回放</span>
                <button type="button" onClick={() => setReplayStep(0)} title="回到开局">⏮</button>
                <button
                  type="button"
                  onClick={() => setReplayStep(Math.max(0, (replayStep ?? totalMoves) - 1))}
                >
                  ◀
                </button>
                <button type="button" onClick={() => setReplayAuto((v) => !v)}>
                  {replayAuto ? '⏸ 暂停' : '▶ 自动'}
                </button>
                <button
                  type="button"
                  onClick={() => setReplayStep(Math.min(totalMoves, (replayStep ?? 0) + 1))}
                >
                  ▶
                </button>
                <button type="button" onClick={() => setReplayStep(totalMoves)} title="跳到终局">⏭</button>
                <span className="replay-pos">
                  {replayStep === null ? `终局 ${totalMoves}/${totalMoves}` : `${replayStep}/${totalMoves}`}
                </span>
                {replayStep !== null && (
                  <button type="button" className="secondary" onClick={() => setReplayStep(null)}>
                    回到终局
                  </button>
                )}
              </div>
            )}

            {room && displayStatus === 'waiting' && room.specAgreed === false && (
              <div className="board-overlay overlay-locked">
                <div className="overlay-card">
                  <div className="lock-icon">🔒</div>
                  <div className="overlay-title">棋盘规格待确认</div>
                  <div className="overlay-sub">
                    {pendingProposalForMe
                      ? pendingProposalForMe.by === playerSymbol
                        ? `已提议 ${pendingProposalForMe.rows}*${pendingProposalForMe.cols}，等待对方在聊天中同意…`
                        : `对方已提议 ${pendingProposalForMe.rows}*${pendingProposalForMe.cols}，请在聊天中回应`
                      : room.specAgreedOnce
                        ? `上一局规格 ${rows}*${cols}：可一键沿用，也可在左侧提议新规格`
                        : `当前预览 ${rows}*${cols}：由任一方在左侧“提议规格”，对方同意后解锁开局`}
                  </div>
                  {room.specAgreedOnce && !pendingProposalForMe && (
                    <button type="button" className="overlay-vote-btn" onClick={confirmSpec}>
                      沿用上一局 {rows}*{cols}
                    </button>
                  )}
                </div>
              </div>
            )}

            {displayStatus === 'finished' && !viewingHistory && (
              <div
                className={`board-overlay overlay-${
                  displayWinner === 'A' ? 'a' : displayWinner === 'B' ? 'b' : 'draw'
                }`}
              >
                <div className="overlay-card">
                  <div className="overlay-kicker">第 {displayRoundNumber} 局结束</div>
                  <div className="overlay-title">{winnerDisplayText}</div>
                  <div className="overlay-sub">
                    {winnerName ? `获胜玩家：${winnerName}` : '双方势均力敌'} · 最终比分 A {displayScores.A} - B{' '}
                    {displayScores.B}
                  </div>
                  <div className="overlay-vote">
                    <button
                      type="button"
                      className={myVote ? 'overlay-vote-btn voted-cancel' : 'overlay-vote-btn'}
                      onClick={voteNextRound}
                    >
                      {myVote ? '已同意，点击撤回' : '同意再来一局'}
                    </button>
                    <div className="restart-status">
                      <span className={`vote-pill ${voteA ? 'voted' : ''}`}>A {voteA ? '✓' : '—'}</span>
                      <span className={`vote-pill ${voteB ? 'voted' : ''}`}>B {voteB ? '✓' : '—'}</span>
                    </div>
                    <p className="overlay-hint">需双方都同意才开启下一局；历史与大比分保留。</p>
                  </div>
                </div>
              </div>
            )}
          </section>

        </main>

        <aside className="panel chat-panel">
          <div className="chat-head">
            <h3>房间聊天</h3>
            {chatMessages.length > 0 && (
              <button
                type="button"
                className="chat-clear"
                onClick={clearChat}
                title="清空聊天记录（保留待回应的规格提议）"
              >
                🗑
              </button>
            )}
          </div>
          <div ref={chatListRef} className="chat-list">
            {chatMessages.length === 0 && <div className="chat-empty"></div>}
            {chatMessages.map((item, idx) => (
              <div key={`${item.timestamp}-${idx}`} className={`chat-item chat-${item.senderSymbol.toLowerCase()}`}>
                <span className="chat-author">
                  {item.senderSymbol} {item.senderName}
                </span>
                {renderChatBody(item)}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') {
                  return;
                }
                // 输入法组词时的回车只确认候选词，不发送也不换行
                if (e.nativeEvent.isComposing) {
                  return;
                }
                e.preventDefault();
                if (e.shiftKey || e.ctrlKey || e.altKey) {
                  insertNewlineAtCaret();
                  return;
                }
                sendChat();
              }}
              placeholder={isSpectator ? '旁观者只读，不能发言' : ''}
              maxLength={200}
              rows={1}
              disabled={isSpectator}
            />
            <button type="button" onClick={sendChat} disabled={isSpectator} aria-label="发送" title="发送 (Enter)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
              </svg>
            </button>
          </div>
        </aside>
      </div>

      {starterModal.show && (
        <div className="modal-backdrop" onClick={() => setStarterModal({ show: false, text: '' })}>
          <div className="starter-modal" onClick={(e) => e.stopPropagation()}>
            <div className="starter-modal-title">先手已确定</div>
            <div className="starter-modal-text">{starterModal.text}</div>
            <button type="button" onClick={() => setStarterModal({ show: false, text: '' })}>
              开始对局
            </button>
          </div>
        </div>
      )}

      {rulesOpen && (
        <div className="modal-backdrop" onClick={() => setRulesOpen(false)}>
          <div className="rules-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rules-modal-title">游戏规则</div>
            <div className="rules-list">
              {GAME_RULES.map((section) => (
                <div key={section.title} className="rules-section">
                  <div className="rules-section-title">{section.title}</div>
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setRulesOpen(false)}>
              知道了
            </button>
          </div>
        </div>
      )}

      {aiModal && (
        <div className="modal-backdrop" onClick={() => setAiModal(false)}>
          <div className="starter-modal ai-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-head">
              <div className="starter-modal-title">接入 AI 代打</div>
              <span className="ai-lock" title="密钥仅存本地">🔒</span>
            </div>
            <p className="ai-note">
              🔐 API Key 只保存在你的浏览器本地（localStorage），仅直连你填写的 API 地址，永远不会经过本游戏服务器。
              <br />
              💡 建议优先选对话型（非思考）模型：deepseek-chat、qwen-local 等开箱即用；deepseek-reasoner
              等思考型模型每步可能耗时 1-2 分钟（Qwen 系已自动关闭思考）。
            </p>
            <div className="ai-field">
              <label>API 地址（OpenAI 兼容）</label>
              <input
                value={aiDraft.baseUrl}
                onChange={(e) => setAiDraft({ ...aiDraft, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="ai-field">
              <label>API Key</label>
              <div className="ai-key-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={aiDraft.apiKey}
                  onChange={(e) => setAiDraft({ ...aiDraft, apiKey: e.target.value })}
                  placeholder="sk-..."
                />
                <button type="button" className="ai-eye" onClick={() => setShowKey(!showKey)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div className="ai-field">
              <label>模型</label>
              <input
                value={aiDraft.model}
                onChange={(e) => setAiDraft({ ...aiDraft, model: e.target.value })}
                placeholder="gpt-4o-mini"
              />
            </div>
            <div className="ai-field-row2">
              <div className="ai-field">
                <label>行动间隔(ms)</label>
                <input
                  type="number"
                  min={300}
                  step={100}
                  value={aiDraft.intervalMs}
                  onChange={(e) => setAiDraft({ ...aiDraft, intervalMs: Number(e.target.value) })}
                />
              </div>
              <label className="ai-vision">
                <input
                  type="checkbox"
                  checked={aiDraft.useVision}
                  onChange={(e) => setAiDraft({ ...aiDraft, useVision: e.target.checked })}
                />
                发送棋盘截图（需视觉模型）
              </label>
            </div>
            <div className="ai-test-row">
              <button
                type="button"
                className="secondary"
                onClick={testAiConnection}
                disabled={aiTest.running || !aiDraft.baseUrl.trim()}
              >
                {aiTest.running ? '测试中…' : '测试连接'}
              </button>
              {aiTest.text && (
                <span className={`hint ${aiTest.text.startsWith('✓') ? 'ai-test-ok' : 'ai-test-fail'}`}>
                  {aiTest.text}
                </span>
              )}
            </div>
            <div className="ai-modal-actions">
              <button type="button" className="secondary" onClick={() => setAiModal(false)}>
                取消
              </button>
              <button type="button" onClick={saveAndActivateAi}>
                {aiDraft.apiKey.trim() ? '保存并接入' : '接入（随机陪练）'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
