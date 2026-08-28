// 全功能 B 方机器人：自动准备/掷骰/落子/接受棋盘提议/终局后跟随投票。
// 用法: node b-driver.mjs <roomId>
import { io } from 'socket.io-client';

const roomId = process.argv[2];
if (!roomId) {
  console.error('usage: node b-driver.mjs <roomId>');
  process.exit(1);
}

const socket = io('http://localhost:3001', { transports: ['websocket'] });
let state = null;

function emit(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res));
  });
}

function allEdges(rows, cols) {
  const edges = [];
  for (let r = 0; r <= rows; r += 1) for (let c = 0; c < cols; c += 1) edges.push(`h-${r}-${c}`);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c <= cols; c += 1) edges.push(`v-${r}-${c}`);
  return edges;
}

let busy = false;
async function react() {
  if (busy || !state) return;
  busy = true;
  try {
    const proposal = state.boardProposal;
    if (proposal && proposal.by === 'A') {
      await emit('respond_board', { roomId, proposalId: proposal.id, accept: true });
      console.log('[bot] accepted proposal', proposal.rows + '*' + proposal.cols);
    }
    if (state.status === 'waiting' && state.specAgreed && !state.readyBySymbol?.B) {
      await emit('player_ready', { roomId, ready: true });
      console.log('[bot] re-readied after spec agreement');
    }
    if (state.status === 'rolling' && state.diceRolls.B === null) {
      await emit('roll_dice', { roomId });
    }
    if (state.status === 'playing' && state.currentTurn === 'B') {
      const free = allEdges(state.boardRows, state.boardCols).filter((e) => !state.claimedEdges[e]);
      if (free.length > 0) await emit('make_move', { roomId, edgeId: free[0] });
    }
    if (state.status === 'finished' && state.nextRoundVotes?.A && !state.nextRoundVotes?.B) {
      await emit('vote_next_round', { roomId });
      console.log('[bot] voted next round');
    }
  } finally {
    busy = false;
  }
}

socket.on('room_state', (s) => {
  const prev = state?.status;
  state = s;
  if (prev !== s.status) console.log(`[bot] status -> ${s.status} (round ${s.roundNumber})`);
  react();
});

socket.on('connect', async () => {
  console.log('[bot] joining', roomId);
  await emit('join_room', { roomId, playerName: '陪练B' });
  await emit('player_ready', { roomId, ready: true });
  console.log('[bot] joined & ready');
});

setInterval(react, 400);
