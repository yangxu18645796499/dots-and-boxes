import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import './App.css';

type PlayerSymbol = 'A' | 'B';

type Player = {
  id: string;
  name: string;
  symbol: PlayerSymbol;
  connected?: boolean;
};

type RoomState = {
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
};

type DiceDecisionPayload = {
  starter: PlayerSymbol;
  diceRolls: Record<PlayerSymbol, number | null>;
  message?: string;
};

type ThemeMode = 'light' | 'dark' | 'system';

type StoreState = {
  room: RoomState | null;
  playerSymbol: PlayerSymbol | null;
  systemMessage: string;
  setRoom: (room: RoomState) => void;
  setPlayerSymbol: (symbol: PlayerSymbol | null) => void;
  setSystemMessage: (message: string) => void;
  reset: () => void;
};

const useGameStore = create<StoreState>((set) => ({
  room: null,
  playerSymbol: null,
  systemMessage: '请输入昵称并创建或加入房间。',
  setRoom: (room) => set({ room }),
  setPlayerSymbol: (playerSymbol) => set({ playerSymbol }),
  setSystemMessage: (systemMessage) => set({ systemMessage }),
  reset: () =>
    set({
      room: null,
      playerSymbol: null,
      systemMessage: '请输入昵称并创建或加入房间。',
    }),
}));

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const SESSION_KEY = 'dots_and_boxes_session_v1';
const THEME_KEY = 'dots_and_boxes_theme_mode';
const MIN_SIZE = 2;
const MAX_SIZE = 8;
const DOT_SIZE = 14;
const EDGE_SPAN = 70;
const MIN_WINNER_PANEL_SPACE = 300;

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
  const boardWrapRef = useRef<HTMLElement | null>(null);
  const [playerName, setPlayerName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [boardSpec, setBoardSpec] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [showWinnerPanel, setShowWinnerPanel] = useState(false);
  const [playerToken, setPlayerToken] = useState('');
  const [rollingDice, setRollingDice] = useState(false);
  const [starterModal, setStarterModal] = useState<{ show: boolean; text: string }>({
    show: false,
    text: '',
  });
  const [selectedHistoryRound, setSelectedHistoryRound] = useState<number | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>('light');

  const room = useGameStore((s) => s.room);
  const playerSymbol = useGameStore((s) => s.playerSymbol);
  const systemMessage = useGameStore((s) => s.systemMessage);
  const setRoom = useGameStore((s) => s.setRoom);
  const setPlayerSymbol = useGameStore((s) => s.setPlayerSymbol);
  const setSystemMessage = useGameStore((s) => s.setSystemMessage);
  const resetStore = useGameStore((s) => s.reset);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      setThemeMode(saved);
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const resolved: 'light' | 'dark' =
        themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode;
      document.documentElement.setAttribute('data-theme', resolved);
      setEffectiveTheme(resolved);
    };

    applyTheme();

    const onChange = () => {
      if (themeMode === 'system') {
        applyTheme();
      }
    };

    if (media.addEventListener) {
      media.addEventListener('change', onChange);
    } else {
      media.addListener(onChange);
    }

    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', onChange);
      } else {
        media.removeListener(onChange);
      }
    };
  }, [themeMode]);

  function updateThemeMode(mode: ThemeMode): void {
    setThemeMode(mode);
    localStorage.setItem(THEME_KEY, mode);
  }

  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setSystemMessage('已连接服务器，可创建或加入房间。');

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
        },
        (response: { ok: boolean; symbol?: PlayerSymbol; playerToken?: string; message?: string }) => {
          if (!response.ok) {
            sessionStorage.removeItem(SESSION_KEY);
            resetStore();
            setPlayerSymbol(null);
            setPlayerToken('');
            setSelectedHistoryRound(null);
            setRoomIdInput('');
            setSystemMessage(response.message || '重连失败，已返回首页。');
            return;
          }

          setPlayerSymbol(response.symbol || parsed.playerSymbol);
          setPlayerToken(response.playerToken || parsed.playerToken);
          setSystemMessage('已自动恢复到上次房间。');
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

    socket.on('dice_tie', (payload: { message?: string }) => {
      setRollingDice(false);
      setSystemMessage(payload.message || '骰子点数相同，请重新掷骰。');
    });

    socket.on('dice_decided', (payload: DiceDecisionPayload) => {
      setRollingDice(false);
      setSystemMessage(payload.message || `${payload.starter} 方先手`);
      setStarterModal({
        show: true,
        text: payload.message || `${payload.starter} 方先手，比赛开始`,
      });
    });

    socket.on('player_left', (payload: { message?: string }) => {
      setSystemMessage(payload.message || '有玩家离开房间。');
    });

    socket.on('disconnect', () => {
      setRollingDice(false);
      setSystemMessage('与服务器连接断开，请刷新重连。');
    });

    return () => {
      socket.disconnect();
    };
  }, [setPlayerSymbol, setRoom, setSystemMessage]);

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

  const displayStatus = selectedRound ? 'finished' : room?.status;
  const displayWinner = selectedRound?.winner ?? room?.winner;
  const displayStarter = selectedRound?.starter ?? room?.starter ?? null;
  const displayScores = selectedRound?.scores ?? room?.scores ?? { A: 0, B: 0 };
  const displayClaimedEdges = selectedRound?.finalClaimedEdges ?? room?.claimedEdges ?? {};
  const displayClaimedBoxes = selectedRound?.finalClaimedBoxes ?? room?.claimedBoxes ?? {};
  const displayRoundNumber = selectedRound?.roundNumber ?? room?.roundNumber ?? 1;

  const canMakeMove = useMemo(() => {
    if (!room || !playerSymbol || viewingHistory) {
      return false;
    }
    return room.status === 'playing' && room.currentTurn === playerSymbol;
  }, [playerSymbol, room, viewingHistory]);

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

  const turnDisplayText = displayStatus === 'playing' ? room?.currentTurn ?? '-' : '-';

  const starterDisplayText =
    displayStarter ??
    (displayStatus === 'rolling' ? '待定（掷骰中）' : displayStatus === 'waiting' ? '待定（未开局）' : '-');

  const resultDisplayText =
    displayStatus === 'finished'
      ? displayWinner === 'draw'
        ? '平局'
        : displayWinner
          ? `${displayWinner} 获胜`
          : '对局结束'
      : displayStatus === 'rolling'
        ? '等待双方掷骰'
        : displayStatus === 'waiting'
          ? (room?.players.length ?? 0) < 2
            ? '等待玩家加入'
            : '等待双方准备'
          : '对局进行中';

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as SessionState;
      if (parsed.playerName) {
        setPlayerName(parsed.playerName);
      }
      if (parsed.roomId) {
        setRoomIdInput(parsed.roomId);
      }
      if (parsed.playerToken) {
        setPlayerToken(parsed.playerToken);
      }
      if (parsed.playerSymbol) {
        setPlayerSymbol(parsed.playerSymbol);
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [setPlayerSymbol]);

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
    if (!room || selectedHistoryRound === null) {
      return;
    }

    const stillExists = room.roundHistory.some((item) => item.roundNumber === selectedHistoryRound);
    if (!stillExists) {
      setSelectedHistoryRound(null);
    }
  }, [room, selectedHistoryRound]);

  useEffect(() => {
    if (displayStatus !== 'finished') {
      setShowWinnerPanel(false);
      return;
    }

    const container = boardWrapRef.current;
    if (!container) {
      return;
    }

    const updateWinnerPanelVisibility = () => {
      const estimatedBoardWidth = cols * (DOT_SIZE + EDGE_SPAN) + DOT_SIZE;
      const availableSpace = container.clientWidth - estimatedBoardWidth;
      setShowWinnerPanel(availableSpace >= MIN_WINNER_PANEL_SPACE);
    };

    updateWinnerPanelVisibility();

    const observer = new ResizeObserver(() => {
      updateWinnerPanelVisibility();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [cols, displayStatus]);

  useEffect(() => {
    if (displayStatus !== 'rolling' || myDice !== null) {
      setRollingDice(false);
    }
  }, [displayStatus, myDice]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !room || !playerToken) {
      return;
    }

    const ping = () => {
      socket.emit('presence_ping', {
        roomId: room.roomId,
        playerToken,
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
    if (allOnline && systemMessage.includes('暂时离线')) {
      setSystemMessage('双方在线，可继续对局。');
    }
  }, [room, setSystemMessage, systemMessage]);

  const winnerDisplayText =
    displayWinner === 'draw' ? '平局' : displayWinner ? `${displayWinner} 方胜利` : '对局结束';
  const winnerName =
    displayWinner === 'A' ? playerA?.name : displayWinner === 'B' ? playerB?.name : undefined;

  function createRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    if (!playerName.trim()) {
      setSystemMessage('请先输入昵称。');
      return;
    }

    const parsed = parseBoardSpec(boardSpec);
    if (!parsed) {
      setSystemMessage('棋盘格式请使用 m*n，且 m、n 范围为 2 到 8，例如 4*8。');
      return;
    }

    socket.emit(
      'create_room',
      {
        playerName: playerName.trim(),
        playerToken: playerToken || undefined,
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
          setSystemMessage(response.message || '创建房间失败。');
          return;
        }

        setPlayerSymbol(response.symbol || null);
        setPlayerToken(response.playerToken || playerToken);
        setRoomIdInput(response.roomId || '');
        setSelectedHistoryRound(null);
        setChatMessages([]);
        setSystemMessage(`房间已创建：${response.roomId}，等待对手加入。`);
      },
    );
  }

  function joinRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    if (!playerName.trim()) {
      setSystemMessage('请先输入昵称。');
      return;
    }

    if (!roomIdInput.trim()) {
      setSystemMessage('请输入房间号。');
      return;
    }

    socket.emit(
      'join_room',
      {
        roomId: roomIdInput.trim().toUpperCase(),
        playerName: playerName.trim(),
        playerToken: playerToken || undefined,
      },
      (response: {
        ok: boolean;
        roomId?: string;
        symbol?: PlayerSymbol;
        playerToken?: string;
        message?: string;
      }) => {
        if (!response.ok) {
          setSystemMessage(response.message || '加入房间失败。');
          return;
        }

        setPlayerSymbol(response.symbol || null);
        setPlayerToken(response.playerToken || playerToken);
        setRoomIdInput(response.roomId || roomIdInput.trim().toUpperCase());
        setSelectedHistoryRound(null);
        setChatMessages([]);
        setSystemMessage(`成功加入房间：${response.roomId}。`);
      },
    );
  }

  function toggleReady(): void {
    if (!room || !playerSymbol) {
      setSystemMessage('先加入房间后再准备。');
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
          setSystemMessage(response.message || '设置准备状态失败。');
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
          setSystemMessage(response.message || '掷骰失败。');
        }
      },
    );
  }

  function startNextRound(): void {
    if (!room || viewingHistory) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.emit(
      'start_next_round',
      { roomId: room.roomId },
      (response: { ok: boolean; roundNumber?: number; message?: string }) => {
        if (!response.ok) {
          setSystemMessage(response.message || '开启新对局失败。');
          return;
        }

        setSelectedHistoryRound(null);
        setStarterModal({ show: false, text: '' });
        setSystemMessage(`已开启第 ${response.roundNumber ?? (room.roundNumber + 1)} 局。`);
      },
    );
  }

  function sendChat(): void {
    if (!room) {
      setSystemMessage('先加入房间后再发送消息。');
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
          setSystemMessage(response.message || '发送消息失败。');
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
          setSystemMessage(response.message || '落子失败。');
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
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="theme-switch" role="group" aria-label="主题切换">
          <button
            type="button"
            className={`theme-btn ${themeMode === 'light' ? 'theme-btn-active' : ''}`}
            onClick={() => updateThemeMode('light')}
          >
            浅色
          </button>
          <button
            type="button"
            className={`theme-btn ${themeMode === 'dark' ? 'theme-btn-active' : ''}`}
            onClick={() => updateThemeMode('dark')}
          >
            深色
          </button>
          <button
            type="button"
            className={`theme-btn ${themeMode === 'system' ? 'theme-btn-active' : ''}`}
            onClick={() => updateThemeMode('system')}
          >
            跟随系统{themeMode === 'system' ? `(${effectiveTheme === 'dark' ? '深' : '浅'})` : ''}
          </button>
        </div>
        <h1>Dots and Boxes</h1>
      </header>

      <div className="layout">
        <aside className="panel controls">
          <div className="field-row">
            <label htmlFor="name">昵称</label>
            <input
              id="name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="例如：Alice"
              maxLength={20}
              disabled={hasActiveRoom}
            />
          </div>

          <div className="field-row">
            <label htmlFor="size">棋盘规格</label>
            <input
              id="size"
              value={hasActiveRoom ? `${rows}*${cols}` : boardSpec}
              onChange={(e) => setBoardSpec(e.target.value)}
              placeholder="请输入 m*n"
              disabled={viewingHistory || hasActiveRoom}
            />
            <button type="button" onClick={createRoom} disabled={hasActiveRoom}>
              创建房间
            </button>
          </div>
          <p className="hint">格式：m*n，且 m、n 取值范围为 2 到 8（例如 4*5）。</p>

          <div className="field-row">
            <label htmlFor="room">房间号</label>
            <input
              id="room"
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
              placeholder="输入 6 位房间号"
              disabled={hasActiveRoom}
            />
            <button type="button" onClick={joinRoom} disabled={hasActiveRoom}>
              加入房间
            </button>
          </div>

          <div className="field-row">
            <button type="button" onClick={toggleReady} className={myReady ? 'ready-btn ready-on' : 'ready-btn'}>
              {myReady ? '取消准备' : '准备开始'}
            </button>
            {room?.status === 'rolling' && (
              <button
                type="button"
                onClick={rollDice}
                className={`dice-btn ${rollingDice ? 'dice-rolling' : ''}`}
                disabled={!canRollDice || rollingDice}
              >
                {rollingDice ? '掷骰中...' : isTieAwaitingReroll ? '重新掷骰' : '掷骰决定先手'}
              </button>
            )}
            <button type="button" onClick={resetLocal} className="secondary">
              退回首页
            </button>
          </div>

          {room?.players.length === 2 && room?.status === 'waiting' && (
            <p className="message">双方都点击“准备开始”后，将进入掷骰决定先手阶段。</p>
          )}

          <p className="message">{systemMessage}</p>

          <section className="history-panel">
            <div className="history-title">对战统计</div>
            <div className="history-summary">共进行 {roundHistory.length} 局</div>
            <div className="history-summary">大比分：A {room?.seriesScore?.A ?? 0} - B {room?.seriesScore?.B ?? 0}</div>

            {roundHistory.length === 0 && <div className="history-empty">暂无历史对局</div>}

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
                    onClick={() => setSelectedHistoryRound(item.roundNumber)}
                  >
                    <div>第 {item.roundNumber} 局</div>
                    <div>棋盘：{item.boardRows}*{item.boardCols}</div>
                    <div>先手：{item.starter ?? '-'}</div>
                    <div>结果：{itemWinner}</div>
                    <div>
                      比分：A {item.scores.A} - B {item.scores.B}
                    </div>
                  </button>
                );
              })}

            {viewingHistory && (
              <button type="button" className="secondary" onClick={() => setSelectedHistoryRound(null)}>
                返回当前对局
              </button>
            )}
          </section>
        </aside>

        <main className="main-area">
          <section className="panel status">
            <div className="round-badge">第 {displayRoundNumber} 局</div>
            <div className="status-grid">
              <div>当前房间：{room?.roomId || '未进入'}</div>
              <div>
                棋盘规格：{rows}*{cols}
              </div>
              <div>你的身份：{playerSymbol || '-'}</div>
              <div>回合：{turnDisplayText}</div>
              <div>状态：{statusDisplayText}</div>
              <div>先手：{starterDisplayText}</div>
              <div>
                结果：{resultDisplayText}
              </div>
            </div>

            <div className="score-row">
              <div className="score-card score-a">
                <div>A 方</div>
                <div>{playerA?.name || '等待加入'}</div>
                <div className="online-tag">{playerA?.connected === false ? '离线' : '在线'}</div>
                <div className="ready-tag">{room?.readyBySymbol?.A ? '已准备' : '未准备'}</div>
                {bothPlayersReady && (
                  <div
                    className={`dice-tag ${
                      room?.status === 'rolling' && room?.diceRolls?.A === null ? 'dice-waiting' : ''
                    }`}
                  >
                    🎲 {room?.diceRolls?.A ?? '-'}
                  </div>
                )}
                  <strong>{displayScores.A}</strong>
              </div>
              <div className="score-card score-b">
                <div>B 方</div>
                <div>{playerB?.name || '等待加入'}</div>
                <div className="online-tag">{playerB?.connected === false ? '离线' : '在线'}</div>
                <div className="ready-tag">{room?.readyBySymbol?.B ? '已准备' : '未准备'}</div>
                {bothPlayersReady && (
                  <div
                    className={`dice-tag ${
                      room?.status === 'rolling' && room?.diceRolls?.B === null ? 'dice-waiting' : ''
                    }`}
                  >
                    🎲 {room?.diceRolls?.B ?? '-'}
                  </div>
                )}
                  <strong>{displayScores.B}</strong>
              </div>
            </div>
          </section>

          <section ref={boardWrapRef} className={`panel board-wrap ${canMakeMove ? 'my-turn' : ''}`}>
            <div className="board">
              {Array.from({ length: rows + 1 }).map((_, r) => (
                <div key={`row-group-${r}`}>
                  <div className="line-row" style={{ gridTemplateColumns: `repeat(${cols}, var(--dot-size) var(--edge-span)) var(--dot-size)` }}>
                    {Array.from({ length: cols }).flatMap((__, c) => {
                      const hEdge = edgeId('h', r, c);
                      const hOwner = displayClaimedEdges[hEdge];
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
                        const boxOwner = displayClaimedBoxes[boxKey];
                        const edgeOwner = displayClaimedEdges[leftEdge];
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
                        const rightOwner = displayClaimedEdges[rightEdge];
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

            {displayStatus === 'finished' && showWinnerPanel && (
              <div
                className={`winner-panel ${
                  displayWinner === 'A' ? 'winner-a' : displayWinner === 'B' ? 'winner-b' : 'winner-draw'
                }`}
              >
                <div className="winner-kicker">对局结束</div>
                <div className="winner-title">{winnerDisplayText}</div>
                <div className="winner-sub">{winnerName ? `获胜玩家：${winnerName}` : '双方势均力敌'}</div>
                <div className="winner-sub">
                  最终比分：A {displayScores.A} - B {displayScores.B}
                </div>
              </div>
            )}

            {displayStatus === 'finished' && !viewingHistory && (
              <button type="button" className="next-round-btn" onClick={startNextRound}>
                再来一局
              </button>
            )}
          </section>

          <section className="panel chat-panel">
            <h3>房间聊天</h3>
            <div className="chat-list">
              {chatMessages.length === 0 && <div className="chat-empty">还没有消息，打个招呼吧。</div>}
              {chatMessages.map((item, idx) => (
                <div key={`${item.timestamp}-${idx}`} className={`chat-item chat-${item.senderSymbol.toLowerCase()}`}>
                  <span className="chat-author">
                    {item.senderSymbol} {item.senderName}
                  </span>
                  <span className="chat-text">{item.message}</span>
                </div>
              ))}
            </div>
            <div className="chat-input-row">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    sendChat();
                  }
                }}
                placeholder="输入聊天内容，回车发送"
                maxLength={200}
              />
              <button type="button" onClick={sendChat}>
                发送
              </button>
            </div>
          </section>
        </main>
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
    </div>
  );
}

export default App;
