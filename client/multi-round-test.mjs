import { io } from 'socket.io-client';

const URL = 'http://localhost:3001';
const TIMEOUT = 8000;

function connect() {
  return io(URL, { transports: ['websocket'] });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), TIMEOUT);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitValue(getter, predicate, label, timeoutMs = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      let v;
      try {
        v = getter();
      } catch {
        v = undefined;
      }
      if (predicate(v)) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 40);
  });
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

function allEdges(rows, cols) {
  const edges = [];
  for (let r = 0; r <= rows; r += 1) for (let c = 0; c < cols; c += 1) edges.push(`h-${r}-${c}`);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c <= cols; c += 1) edges.push(`v-${r}-${c}`);
  return edges;
}

async function run() {
  const a = connect();
  const b = connect();
  let stateA = null;
  a.on('room_state', (s) => { stateA = s; });

  const created = await emitAck(a, 'create_room', { playerName: 'MultiA' });
  const roomId = created.roomId;
  await emitAck(b, 'join_room', { roomId, playerName: 'MultiB' });
  await waitValue(() => stateA, (s) => s?.players?.length === 2, 'B joined');
  check('round1 default size 4*4', stateA.boardRows === 4 && stateA.boardCols === 4);

  // 首局门槛：默认 4*4 也要经双方协商确认才能开局
  const rejReady = await emitAck(a, 'player_ready', { roomId, ready: true });
  check('ready blocked before spec agreed', rejReady.ok === false && /协商/.test(rejReady.message || ''), JSON.stringify(rejReady));
  await emitAck(a, 'propose_board', { roomId, rows: 4, cols: 4 });
  await waitValue(() => stateA, (s) => s?.boardProposal?.rows === 4, 'initial proposal');
  await emitAck(b, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: true });
  await waitValue(() => stateA, (s) => s?.specAgreed === true, 'specAgreed');
  check('spec agreed via proposal', stateA.specAgreed === true);

  // 每局独立设置规格：局 2 协商 3*5，局 3 协商 2*2（还价方交替，验证双方都能提议）
  const plan = [
    { size: [4, 4], proposer: null },
    { size: [3, 5], proposer: a },
    { size: [2, 2], proposer: b },
  ];

  for (let roundIdx = 0; roundIdx < 3; roundIdx += 1) {
    const [rows, cols] = plan[roundIdx].size;

    if (plan[roundIdx].proposer) {
      await emitAck(plan[roundIdx].proposer, 'propose_board', { roomId, rows, cols });
      await waitValue(() => stateA, (s) => s?.boardProposal?.rows === rows && s?.boardProposal?.cols === cols, `round${roundIdx + 1} proposal`);
      const responder = plan[roundIdx].proposer === a ? b : a;
      await emitAck(responder, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: true });
      await waitValue(() => stateA, (s) => s?.boardRows === rows && s?.boardCols === cols && s?.boardProposal === null, `round${roundIdx + 1} size applied`);
      check(`round${roundIdx + 1}: negotiated size ${rows}*${cols} applied`, stateA.boardRows === rows && stateA.boardCols === cols);
    }

    await emitAck(a, 'player_ready', { roomId, ready: true });
    await emitAck(b, 'player_ready', { roomId, ready: true });
    await waitValue(() => stateA, (s) => s?.status === 'rolling', `round${roundIdx + 1} rolling`);
    for (let i = 0; i < 60 && stateA.status !== 'playing'; i += 1) {
      let sock = a;
      if (stateA.diceRolls.B === null && stateA.diceRolls.A !== null) sock = b;
      await emitAck(sock, 'roll_dice', { roomId });
      await new Promise((r) => setTimeout(r, 100));
    }
    await waitValue(() => stateA, (s) => s?.status === 'playing', `round${roundIdx + 1} playing`);

    const sockets = { A: a, B: b };
    const edges = allEdges(rows, cols);
    let guard = 0;
    while (stateA.status === 'playing' && guard < 80) {
      const turn = stateA.currentTurn;
      const claimedCount = Object.keys(stateA.claimedEdges).length;
      const next = edges.find((e) => !Object.keys(stateA.claimedEdges).includes(e));
      await emitAck(sockets[turn], 'make_move', { roomId, edgeId: next });
      await waitValue(
        () => stateA,
        (s) => s?.status === 'finished' || Object.keys(s?.claimedEdges ?? {}).length === claimedCount + 1,
        `round${roundIdx + 1} move`,
      );
      guard += 1;
    }
    await waitValue(() => stateA, (s) => s?.status === 'finished', `round${roundIdx + 1} finished`);

    const entry = stateA.roundHistory.at(-1);
    check(
      `round${roundIdx + 1}: history entry complete`,
      entry &&
        entry.roundNumber === roundIdx + 1 &&
        entry.boardRows === rows &&
        entry.boardCols === cols &&
        typeof entry.starter === 'string' &&
        (entry.winner === 'A' || entry.winner === 'B' || entry.winner === 'draw') &&
        typeof entry.scores?.A === 'number' &&
        typeof entry.scores?.B === 'number' &&
        typeof entry.finishedAt === 'number',
      JSON.stringify(entry),
    );
    const totalBoxes = rows * cols;
    check(
      `round${roundIdx + 1}: box score sums to board size`,
      entry.scores.A + entry.scores.B === totalBoxes,
      `A${entry.scores.A}+B${entry.scores.B} != ${totalBoxes}`,
    );

    if (roundIdx < 2) {
      // 双方投票进入下一局，历史保留
      await emitAck(a, 'vote_next_round', { roomId });
      await emitAck(b, 'vote_next_round', { roomId });
      await waitValue(() => stateA, (s) => s?.status === 'waiting' && s?.roundNumber === roundIdx + 2, `round${roundIdx + 2} waiting`);
      check(`after round${roundIdx + 1}: history has ${roundIdx + 1} entries`, stateA.roundHistory.length === roundIdx + 1);
    }
  }

  check('series: 3 rounds recorded', stateA.roundHistory.length === 3);
  check('series: round numbers 1..3', stateA.roundHistory.map((r) => r.roundNumber).join(',') === '1,2,3');
  check(
    'series: per-round sizes independent',
    JSON.stringify(stateA.roundHistory.map((r) => `${r.boardRows}*${r.boardCols}`)) === JSON.stringify(['4*4', '3*5', '2*2']),
    JSON.stringify(stateA.roundHistory.map((r) => `${r.boardRows}*${r.boardCols}`)),
  );
  const seriesSum = stateA.roundHistory.reduce((acc, r) => {
    if (r.winner === 'A') acc.A += 1;
    if (r.winner === 'B') acc.B += 1;
    return acc;
  }, { A: 0, B: 0 });
  check(
    'series: big score matches per-round winners',
    stateA.seriesScore.A === seriesSum.A && stateA.seriesScore.B === seriesSum.B,
    `series ${JSON.stringify(stateA.seriesScore)} vs ${JSON.stringify(seriesSum)}`,
  );

  a.disconnect();
  b.disconnect();
  console.log(failures === 0 ? '\nALL MULTI-ROUND TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
