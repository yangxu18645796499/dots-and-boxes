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

async function run() {
  const a = connect();
  const b = connect();
  let stateA = null;
  a.on('room_state', (s) => { stateA = s; });

  // 1. create without spec -> default 4*4
  const created = await emitAck(a, 'create_room', { playerName: 'PA' });
  const roomId = created.roomId;
  await emitAck(b, 'join_room', { roomId, playerName: 'PB' });
  await waitValue(() => stateA, (s) => s?.players?.length === 2, 'B joined');
  check('default board is 4*4', stateA.boardRows === 4 && stateA.boardCols === 4, JSON.stringify({ r: stateA.boardRows, c: stateA.boardCols }));

  // 2. propose 5*3
  const prop = await emitAck(a, 'propose_board', { roomId, rows: 5, cols: 3 });
  await waitValue(() => stateA, (s) => s?.boardProposal?.rows === 5, 'pending proposal');
  const lastMsg = stateA.chatHistory.at(-1);
  check('propose ok + pending', prop.ok && stateA.boardProposal?.by === 'A' && stateA.boardProposal.rows === 5 && stateA.boardProposal.cols === 3);
  check('proposal chat entry pending', lastMsg?.kind === 'board-proposal' && lastMsg.proposal?.status === 'pending');

  // 3. responder cannot be proposer; stale id fails
  const own = await emitAck(a, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: true });
  check('cannot respond to own proposal', own.ok === false);
  const stale = await emitAck(b, 'respond_board', { roomId, proposalId: 12345, accept: true });
  check('stale proposal id rejected', stale.ok === false);

  // 4. B accepts -> size applied, state reset to waiting, ready cleared
  await emitAck(b, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: true });
  await waitValue(() => stateA, (s) => s?.boardRows === 5 && s?.boardCols === 3, 'size applied');
  check('accepted: size applied', stateA.boardRows === 5 && stateA.boardCols === 3);
  check('accepted: ready cleared & waiting', stateA.status === 'waiting' && !stateA.readyBySymbol.A && !stateA.readyBySymbol.B);
  check('accepted: proposal cleared', stateA.boardProposal === null);
  check('accepted: chat entry updated', stateA.chatHistory.at(-1)?.proposal?.status === 'accepted');

  // 4.5 clear chat: normal messages removed, no pending proposals kept
  await emitAck(a, 'send_chat', { roomId, message: 'hello' });
  await waitValue(() => stateA, (s) => s?.chatHistory?.some((m) => m.message === 'hello'), 'hello in chat');
  const cc = await emitAck(a, 'clear_chat', { roomId });
  await waitValue(() => stateA, (s) => s?.chatHistory?.length === 0, 'chat cleared');
  check('clear chat removes normal messages', cc.ok === true && stateA.chatHistory.length === 0);

  // 5. counter-proposal by B, A rejects -> size unchanged
  await emitAck(b, 'propose_board', { roomId, rows: 2, cols: 2 });
  await waitValue(() => stateA, (s) => s?.boardProposal?.rows === 2, 'counter proposal');
  await emitAck(a, 'respond_board', { roomId, proposalId: stateA.boardProposal.id, accept: false });
  await waitValue(() => stateA, (s) => s?.boardProposal === null, 'counter rejected');
  check('rejected: size unchanged', stateA.boardRows === 5 && stateA.boardCols === 3);
  check('rejected: chat entry updated', stateA.chatHistory.at(-1)?.proposal?.status === 'rejected');

  // 6. invalid size rejected
  const bad = await emitAck(a, 'propose_board', { roomId, rows: 9, cols: 9 });
  check('invalid size rejected', bad.ok === false);

  // 7. pending proposal invalidated when both ready (game starts)
  await emitAck(a, 'propose_board', { roomId, rows: 3, cols: 3 });
  await waitValue(() => stateA, (s) => s?.boardProposal?.rows === 3, 'proposal before ready');
  // clear chat must PRESERVE the pending proposal entry
  await emitAck(a, 'send_chat', { roomId, message: 'hello2' });
  await waitValue(() => stateA, (s) => s?.chatHistory?.some((m) => m.message === 'hello2'), 'hello2 in chat');
  const cc2 = await emitAck(a, 'clear_chat', { roomId });
  await waitValue(
    () => stateA,
    (s) => s?.chatHistory?.length === 1 && s.chatHistory[0].proposal?.status === 'pending',
    'clear keeps pending',
  );
  check(
    'clear chat keeps pending proposal',
    cc2.ok === true && stateA.chatHistory.length === 1 && stateA.chatHistory[0].kind === 'board-proposal',
  );
  await emitAck(a, 'player_ready', { roomId, ready: true });
  await emitAck(b, 'player_ready', { roomId, ready: true });
  await waitValue(() => stateA, (s) => s?.status === 'rolling', 'rolling');
  check('proposal invalidated on game start', stateA.boardProposal === null && stateA.chatHistory.at(-1)?.proposal?.status === 'rejected');

  // 8. propose during rolling rejected
  const during = await emitAck(a, 'propose_board', { roomId, rows: 4, cols: 4 });
  check('propose during rolling rejected', during.ok === false);

  a.disconnect();
  b.disconnect();
  console.log(failures === 0 ? '\nALL PROPOSAL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
