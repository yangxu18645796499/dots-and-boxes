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

// Poll a tracked value until the predicate holds; immune to event-listener races.
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

function allEdges(rows, cols) {
  const edges = [];
  for (let r = 0; r <= rows; r += 1) for (let c = 0; c < cols; c += 1) edges.push(`h-${r}-${c}`);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c <= cols; c += 1) edges.push(`v-${r}-${c}`);
  return edges;
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

async function run() {
  const a = connect();
  const b = connect();

  let stateA = null;
  let lastResetMessage = null;
  a.on('room_state', (s) => { stateA = s; });
  a.on('round_reset', (p) => { lastResetMessage = p?.message ?? null; });

  const created = await emitAck(a, 'create_room', { playerName: 'TesterA', boardRows: 2, boardCols: 2 });
  check('create_room ok', created.ok === true && !!created.roomId);
  const roomId = created.roomId;

  const joined = await emitAck(b, 'join_room', { roomId, playerName: 'TesterB' });
  check('join_room ok', joined.ok === true && joined.symbol === 'B');
  await waitValue(() => stateA, (s) => s?.players?.length === 2, 'B visible in room');

  // 首局门槛：规格需双方协商同意
  const rejReady = await emitAck(a, 'player_ready', { roomId, ready: true });
  check('ready blocked before spec agreed', rejReady.ok === false && /协商/.test(rejReady.message || ''), JSON.stringify(rejReady));
  await emitAck(a, 'propose_board', { roomId, rows: 2, cols: 2 });
  await waitValue(() => stateA, (s) => s?.boardProposal?.rows === 2, 'restart-test proposal');
  await emitAck(b, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: true });
  await waitValue(() => stateA, (s) => s?.specAgreed === true, 'specAgreed');
  check('spec agreed via proposal', stateA.specAgreed === true && stateA.boardRows === 2 && stateA.boardCols === 2);

  await emitAck(a, 'player_ready', { roomId, ready: true });
  await emitAck(b, 'player_ready', { roomId, ready: true });
  await waitValue(() => stateA, (s) => s?.status === 'rolling', 'rolling');
  check('both ready -> rolling', stateA.status === 'rolling');

  // roll until starter decided (handles ties: server resets dice before next roll)
  for (let i = 0; i < 60 && stateA.status !== 'playing'; i += 1) {
    let sock = a;
    if (stateA.diceRolls.B === null && stateA.diceRolls.A !== null) sock = b;
    await emitAck(sock, 'roll_dice', { roomId });
    await waitValue(() => stateA, (s) => s?.diceRolls.A !== stateA.diceRolls.A || s?.status !== 'rolling' || true, 'dice update', 1500).catch(() => {});
  }
  await waitValue(() => stateA, (s) => s?.status === 'playing', 'playing');
  check('dice decided -> playing', stateA.status === 'playing');

  // play until board finished (2x2 = 12 edges, box completion keeps the turn)
  const edges = allEdges(2, 2);
  const sockets = { A: a, B: b };
  let moves = 0;
  while (stateA.status === 'playing' && moves < 60) {
    const turn = stateA.currentTurn;
    const claimedCount = Object.keys(stateA.claimedEdges).length;
    const next = edges.find((e) => !Object.keys(stateA.claimedEdges).includes(e));
    const ack = await emitAck(sockets[turn], 'make_move', { roomId, edgeId: next });
    if (!ack.ok) {
      console.log(`  move ${next} rejected: ${ack.message} (turn=${turn})`);
      break;
    }
    await waitValue(
      () => stateA,
      (s) => s?.status === 'finished' || Object.keys(s?.claimedEdges ?? {}).length === claimedCount + 1,
      `move ${next} applied`,
    );
    moves += 1;
  }
  await waitValue(() => stateA, (s) => s?.status === 'finished', 'finished');
  check('game finished naturally', stateA.status === 'finished', `status=${stateA.status} moves=${moves}`);
  check('round recorded in history', stateA.roundHistory.length === 1);
  const seriesBefore = { ...stateA.seriesScore };
  const roundNumberBefore = stateA.roundNumber;

  // single vote alone must NOT reset
  await emitAck(a, 'vote_next_round', { roomId });
  await waitValue(() => stateA, (s) => s?.nextRoundVotes?.A === true, 'vote A');
  check('single vote keeps finished state', stateA.status === 'finished' && stateA.roundNumber === roundNumberBefore);

  // second vote -> next round starts
  await emitAck(b, 'vote_next_round', { roomId });
  await waitValue(() => lastResetMessage, (m) => typeof m === 'string', 'round_reset');
  await waitValue(() => stateA, (s) => s?.status === 'waiting', 'waiting after reset');
  check('both votes -> round_reset event', typeof lastResetMessage === 'string', `msg=${lastResetMessage}`);
  check('next round opened', stateA.roundNumber === roundNumberBefore + 1);
  check('history preserved after next round', stateA.roundHistory.length === 1);
  check('series score preserved', JSON.stringify(stateA.seriesScore) === JSON.stringify(seriesBefore));
  check('votes cleared', stateA.nextRoundVotes.A === false && stateA.nextRoundVotes.B === false);

  // start round 2, play 2 moves, then vote flow mid-game
  // 每局重确认：A 一键沿用上一局规格即可解锁
  const cs = await emitAck(a, 'confirm_spec', { roomId });
  check('confirm_spec unlocks round2', cs.ok === true && cs.rows === 2 && cs.cols === 2, JSON.stringify(cs));
  await waitValue(() => stateA, (s) => s?.specAgreed === true, 'round2 specAgreed');
  await emitAck(a, 'player_ready', { roomId, ready: true });
  await emitAck(b, 'player_ready', { roomId, ready: true });
  await waitValue(() => stateA, (s) => s?.status === 'rolling', 'round2 rolling');
  for (let i = 0; i < 60 && stateA.status !== 'playing'; i += 1) {
    let sock = a;
    if (stateA.diceRolls.B === null && stateA.diceRolls.A !== null) sock = b;
    await emitAck(sock, 'roll_dice', { roomId });
    await new Promise((r) => setTimeout(r, 120));
  }
  await waitValue(() => stateA, (s) => s?.status === 'playing', 'round2 playing');
  check('round2 playing', stateA.status === 'playing');
  const rn2 = stateA.roundNumber;
  for (let m = 0; m < 2 && stateA.status === 'playing'; m += 1) {
    const turn = stateA.currentTurn;
    const claimedCount = Object.keys(stateA.claimedEdges).length;
    const next = edges.find((e) => !Object.keys(stateA.claimedEdges).includes(e));
    await emitAck(sockets[turn], 'make_move', { roomId, edgeId: next });
    await waitValue(
      () => stateA,
      (s) => Object.keys(s?.claimedEdges ?? {}).length === claimedCount + 1,
      `round2 move ${m + 1} applied`,
    );
  }

  // A agrees then takes back alone -> nothing resets
  await emitAck(a, 'vote_next_round', { roomId });
  await waitValue(() => stateA, (s) => s?.nextRoundVotes?.A === true, 'mid-game vote A');
  await emitAck(a, 'vote_next_round', { roomId });
  await waitValue(() => stateA, (s) => s?.nextRoundVotes?.A === false, 'mid-game take-back A');
  check('mid-game: take-back works, still playing', stateA.status === 'playing' && stateA.roundNumber === rn2);

  // both agree -> mid-game restart of the same round
  const roundNumberBeforeReset = stateA.roundNumber;
  const claimedBeforeReset = Object.keys(stateA.claimedEdges).length;
  lastResetMessage = null;
  await emitAck(a, 'vote_next_round', { roomId });
  await waitValue(() => stateA, (s) => s?.nextRoundVotes?.A === true, 'mid-game revote A');
  await emitAck(b, 'vote_next_round', { roomId });
  await waitValue(() => lastResetMessage, (msg) => typeof msg === 'string', 'mid-game round_reset');
  await waitValue(() => stateA, (s) => s?.status === 'waiting', 'mid-game waiting');
  check('mid-game: restart keeps round number', stateA.roundNumber === roundNumberBeforeReset);
  check('mid-game: board cleared', Object.keys(stateA.claimedEdges).length === 0 && claimedBeforeReset > 0);
  check('mid-game: no history entry added', stateA.roundHistory.length === 1);
  check('mid-game: series score untouched', JSON.stringify(stateA.seriesScore) === JSON.stringify(seriesBefore));

  a.disconnect();
  b.disconnect();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
