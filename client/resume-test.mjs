import { io } from 'socket.io-client';
const URL = 'http://localhost:3001';
function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ack timeout ' + event)), 6000);
    socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}
function waitValue(getter, predicate, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      let v; try { v = getter(); } catch { v = undefined; }
      if (predicate(v)) { clearInterval(iv); resolve(v); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); reject(new Error('timeout: ' + label)); }
    }, 40);
  });
}
let failures = 0;
const check = (n, c, d = '') => { if (c) console.log('PASS  ' + n); else { failures++; console.log('FAIL  ' + n + ' ' + d); } };

const a = io(URL, { transports: ['websocket'] });
let st = null;
a.on('room_state', (s) => { st = s; });

const cr = await emitAck(a, 'create_room', { playerName: '续局A', boardRows: 2, boardCols: 2 });
const roomId = cr.roomId;

// B 用固定身份令牌加入（模拟 localStorage 里记住的身份）
const b = io(URL, { transports: ['websocket'] });
const jb = await emitAck(b, 'join_room', { roomId, playerName: '续局B', playerToken: 'tok_user_B' });
check('B joined with identity token', jb.ok && jb.symbol === 'B' && jb.playerToken === 'tok_user_B');
await waitValue(() => st, (s) => s?.players?.length === 2, 'B visible');

// 首局门槛：先协商规格才能准备
await emitAck(a, 'propose_board', { roomId, rows: 2, cols: 2 });
await waitValue(() => st, (s) => s?.boardProposal?.rows === 2, 'resume-test proposal');
await emitAck(b, 'respond_board', { roomId, proposalId: st.boardProposal.id, accept: true });
await waitValue(() => st, (s) => s?.specAgreed === true, 'specAgreed');

await emitAck(a, 'player_ready', { roomId, ready: true });
await emitAck(b, 'player_ready', { roomId, ready: true });
await waitValue(() => st, (s) => s?.status === 'rolling', 'rolling');
for (let i = 0; i < 60 && st.status !== 'playing'; i++) {
  const sock = st.diceRolls.B === null && st.diceRolls.A !== null ? b : a;
  await emitAck(sock, 'roll_dice', { roomId });
  await new Promise((r) => setTimeout(r, 100));
}
await waitValue(() => st, (s) => s?.status === 'playing', 'playing');

// 打两手棋，制造可续的局面
const sockets = { A: a, B: b };
const edges = ['h-0-0','h-0-1','h-1-0','h-1-1','h-2-0','h-2-1','v-0-0','v-0-1','v-0-2','v-1-0','v-1-1','v-1-2'];
for (let m = 0; m < 2 && st.status === 'playing'; m++) {
  const turn = st.currentTurn;
  const cnt = Object.keys(st.claimedEdges).length;
  const next = edges.find((e) => !Object.keys(st.claimedEdges).includes(e));
  await emitAck(sockets[turn], 'make_move', { roomId, edgeId: next });
  await waitValue(() => st, (s) => Object.keys(s?.claimedEdges ?? {}).length === cnt + 1, 'move applied');
}
const claimedBefore = Object.keys(st.claimedEdges).length;
const roundBefore = st.roundNumber;
const diceBefore = JSON.stringify(st.diceRolls);
check('mid-game state ready (2 moves played)', claimedBefore === 2, 'claimed=' + claimedBefore);

// B 掉线
b.disconnect();
await waitValue(() => st, (s) => s.players.some((p) => p.symbol === 'B' && p.connected === false), 'B offline');
check('B marked offline, slot kept', st.players.length === 2 && st.status === 'playing' || st.status === 'waiting',
  'players=' + st.players.length + ' status=' + st.status);
check('board preserved while offline', Object.keys(st.claimedEdges).length === claimedBefore);

// 陌生人（不同令牌）此时尝试加入 → 满员转为旁观者（不占玩家席位）
const stranger = io(URL, { transports: ['websocket'] });
const rej = await emitAck(stranger, 'join_room', { roomId, playerName: '路人C', playerToken: 'tok_stranger' });
stranger.disconnect();
check('stranger becomes spectator while seat held', rej.ok === true && rej.spectator === true, JSON.stringify(rej));

// 同一身份重连 → 恢复同一玩家、局面保留
const b2 = io(URL, { transports: ['websocket'] });
const re = await emitAck(b2, 'join_room', { roomId, playerName: '续局B', playerToken: 'tok_user_B' });
check('same identity resumes as B', re.ok && re.symbol === 'B' && re.playerToken === 'tok_user_B');
await waitValue(() => st, (s) => s.players.every((p) => p.connected !== false), 'B back online');
check('round number preserved', st.roundNumber === roundBefore);
check('board preserved after rejoin', Object.keys(st.claimedEdges).length === claimedBefore);
check('still same round state (playing)', st.status === 'playing', 'status=' + st.status);

// 换昵称 + 换令牌 = 新用户：满员拒绝
a.disconnect(); b2.disconnect();
console.log(failures === 0 ? '\nALL RESUME TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
