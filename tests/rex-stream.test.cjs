const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const rex = require('../.test-build/app/apps/terminal/rex/stream.js');

// Recorded from a live Rex server by scripts/rex-stream-fixtures.mjs.
function fixture(name) {
  const recorded = require(path.join(__dirname, 'fixtures', 'rex', `stream-${name}.json`));
  return {
    ...recorded,
    connections: recorded.connections.map((connection) => ({
      close: connection.close,
      frames: connection.frames.map((frame) => ({ atMs: frame.atMs, bytes: new Uint8Array(Buffer.from(frame.base64, 'base64')) })),
    })),
  };
}

const TOKEN = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);

function welcomeFrame(nonce, token = TOKEN) {
  const frame = Buffer.alloc(32);
  frame[0] = 0x81;
  Buffer.from(token).copy(frame, 1);
  frame.writeUInt32LE(60000, 20);
  frame.writeBigUInt64LE(BigInt(nonce), 24);
  return new Uint8Array(frame);
}

function welcome(nonce, token) {
  const reply = rex.parseHandshakeReply(welcomeFrame(nonce, token));
  assert.equal(reply.kind, 'welcome');
  return reply.welcome;
}

const gridOf = ({ columns, rows }) => ({ cols: columns, rows });
const gridName = ({ columns, rows }) => `${columns}x${rows}`;

const joined = (frames) => new Uint8Array(Buffer.concat(frames.map((frame) => frame.bytes)));

function splitAt(bytes, offsets) {
  const chunks = [];
  let from = 0;
  for (const to of [...offsets, bytes.length]) {
    chunks.push(bytes.slice(from, to));
    from = to;
  }
  return chunks;
}

/** Feeds chunks and answers every seed request at once with SEED. */
function drive(stream, chunks) {
  const actions = [];
  const take = (list) => {
    for (const action of list) {
      actions.push(action);
      if (action.type === 'request-seed') take(stream.seedArrived('SEED'));
    }
  };
  for (const chunk of chunks) take(stream.receive(chunk, 0));
  return actions;
}

/** Output, resize and exit actions, with adjacent output joined: what the emulator sees. */
function screenFeed(actions) {
  const feed = [];
  for (const action of actions) {
    if (action.type === 'output') {
      const last = feed[feed.length - 1];
      if (last && last.type === 'output') last.text += Buffer.from(action.bytes).toString('latin1');
      else feed.push({ type: 'output', text: Buffer.from(action.bytes).toString('latin1') });
    } else if (action.type === 'resize' || action.type === 'exited') {
      feed.push({ ...action });
    }
  }
  return feed;
}

/** Index of the frame that completes the first Rex message, the end of the snapshot. */
function markerFrame(recorded) {
  const frames = recorded.connections[0].frames;
  const [[, end]] = apcSpans(joined(frames), recorded.nonce);
  let offset = 0;
  return frames.findIndex((frame) => (offset += frame.bytes.length) >= end);
}

function apcSpans(bytes, nonce) {
  const text = Buffer.from(bytes).toString('latin1');
  const spans = [];
  const prefix = `\x1b_rex1;${nonce};`;
  for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + 1)) {
    spans.push([at, text.indexOf('\x1b\\', at) + 2]);
  }
  return spans;
}

test('helloFrame carries the ticket bytes', () => {
  const ticket = 'AAECAwQFBgcICQoLDA0ODw';
  assert.deepEqual([...rex.helloFrame(ticket)], [0x01, ...Buffer.from(ticket, 'base64url')]);
  assert.deepEqual([...rex.helloFrame(ticket)].slice(1), Array.from({ length: 16 }, (_, index) => index));
  assert.throws(() => rex.helloFrame('AAECAwQFBgcICQoLDA0OD'));
  assert.throws(() => rex.helloFrame('AAECAwQFBgcICQoLDA0OD+'));
});

test('parseHandshakeReply reads WELCOME and REJECT', () => {
  const nonce = '18446744073709551615';
  const reply = rex.parseHandshakeReply(welcomeFrame(nonce));
  assert.equal(reply.kind, 'welcome');
  assert.equal(reply.welcome.nonce, nonce);
  assert.deepEqual([...reply.welcome.token], [...TOKEN]);

  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x82, 0x01)), { kind: 'reject', reason: 'invalid-ticket' });
  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x82, 0x03)), { kind: 'reject', reason: 'stream-unavailable' });
  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x82, 0x07)), { kind: 'reject', reason: 'wrong-subprotocol' });
  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x82, 0x2a)), { kind: 'reject', reason: 'unknown' });

  assert.deepEqual(rex.parseHandshakeReply(welcomeFrame('0')), { kind: 'invalid' });
  assert.deepEqual(rex.parseHandshakeReply(welcomeFrame('5').subarray(0, 31)), { kind: 'invalid' });
  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x82)), { kind: 'invalid' });
  assert.deepEqual(rex.parseHandshakeReply(Uint8Array.of(0x47, 0x48)), { kind: 'invalid' });
});

test('the snapshot before the first resize never reaches the emulator', () => {
  const recorded = fixture('output');
  const bytes = joined(recorded.connections[0].frames);
  const [marker] = apcSpans(bytes, recorded.nonce);
  assert.equal(Buffer.from(bytes.subarray(0, 8)).toString('latin1'), 'GHOSTSNP');

  const stream = new rex.RexStream(welcome(recorded.nonce));
  const actions = drive(stream, recorded.connections[0].frames.map((frame) => frame.bytes));
  assert.deepEqual(actions[0], { type: 'request-seed' });
  assert.deepEqual(actions[1], { type: 'seed', vt: 'SEED', ...gridOf(recorded.grid) });
  const feed = screenFeed(actions);
  const output = feed.map((event) => event.text).join('');
  assert.equal(output, Buffer.from(bytes.subarray(marker[1])).toString('latin1'));
  assert.ok(!output.includes('GHOSTSNP'));
  assert.match(output, /\x1b\[31mred\x1b\[0m and progress 10%\r progress 99%\r\n/);
});

test('a quiet pane seeds once and never re-seeds', () => {
  const recorded = fixture('output');
  const frames = recorded.connections[0].frames;
  const marker = markerFrame(recorded);
  const stream = new rex.RexStream(welcome(recorded.nonce));
  for (const frame of frames.slice(0, marker)) assert.deepEqual(stream.receive(frame.bytes, frame.atMs), []);
  assert.deepEqual(stream.receive(frames[marker].bytes, frames[marker].atMs), [{ type: 'request-seed' }]);
  const seeded = stream.seedArrived('SEED');
  assert.deepEqual(seeded, [{ type: 'seed', vt: 'SEED', ...gridOf(recorded.grid) }]);
  const rest = frames.slice(marker + 1);
  for (const frame of rest) {
    assert.ok(stream.receive(frame.bytes, frame.atMs).every((action) => action.type === 'output'));
  }
  assert.deepEqual(stream.tick(rest[rest.length - 1].atMs + 10 * rex.RESEED_QUIET_MS), []);
});

test('a Rex message split across frames at every offset gives the same feed', () => {
  const recorded = fixture('resize');
  const bytes = joined(recorded.connections[0].frames);
  const expected = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), [bytes]));
  assert.deepEqual(
    screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), recorded.connections[0].frames.map((frame) => frame.bytes))),
    expected,
  );
  const spans = apcSpans(bytes, recorded.nonce);
  assert.equal(spans.length, 3);
  for (const [start, end] of spans) {
    for (let cut = start; cut <= end; cut++) {
      const feed = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), splitAt(bytes, [cut])));
      assert.deepEqual(feed, expected, `cut at ${cut}, inside ${start}..${end}`);
    }
    const midStart = start + 1;
    const midEnd = end - 1;
    for (let cut = midStart; cut < midEnd; cut++) {
      const feed = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), splitAt(bytes, [midStart, cut, midEnd])));
      assert.deepEqual(feed, expected, `three cuts around ${cut}`);
    }
  }
  const oneByte = splitAt(bytes, Array.from({ length: bytes.length - 1 }, (_, index) => index + 1));
  assert.deepEqual(screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), oneByte)), expected);
});

test('a resize mid-stream lands between the output around it', () => {
  const recorded = fixture('resize');
  const stream = new rex.RexStream(welcome(recorded.nonce));
  const feed = screenFeed(drive(stream, recorded.connections[0].frames.map((frame) => frame.bytes)));
  assert.deepEqual(
    feed.map((event) => (event.type === 'resize' ? `${event.cols}x${event.rows}` : 'output')),
    ['output', gridName(recorded.resizedGrid), 'output', gridName(recorded.grid), 'output'],
  );
  assert.match(feed[0].text, /seq 1 3\r\n1\r\n2\r\n3\r\n\$ $/);
  assert.match(feed[2].text, /^\r\x1b\[K\$ seq 4 6\r\n4\r\n5\r\n6\r\n\$ $/);
});

test('a look-alike APC with another nonce stays output byte for byte', () => {
  const recorded = fixture('spoof');
  const bytes = joined(recorded.connections[0].frames);
  const text = Buffer.from(bytes).toString('latin1');
  const spoofs = recorded.spoofNonces.map((nonce) => `\x1b_rex1;${nonce};{"type":"resize","cols":7,"rows":3}\x1b\\`);
  for (const spoof of spoofs) assert.ok(text.includes(spoof), 'the recording carries the printed look-alike');

  for (const chunks of [recorded.connections[0].frames.map((frame) => frame.bytes), splitAt(bytes, [text.indexOf(spoofs[0]) + 12])]) {
    const feed = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), chunks));
    assert.deepEqual(feed.filter((event) => event.type === 'resize'), []);
    const output = feed.map((event) => event.text).join('');
    assert.ok(output.includes(`${spoofs.join('')}after spoof\r\n`));
  }
});

test('byte count across a RESUME matches what the live server accepted', () => {
  const recorded = fixture('resume');
  const [first, second] = recorded.connections;
  const stream = new rex.RexStream(welcome(recorded.nonce));
  const actions = drive(stream, first.frames.map((frame) => frame.bytes));
  assert.equal(stream.bytesReceived, recorded.resumeBytes);

  const resume = stream.resumeFrame();
  assert.equal(resume.length, 25);
  assert.equal(resume[0], 0x02);
  assert.deepEqual([...resume.subarray(1, 17)], [...TOKEN]);
  assert.equal(Buffer.from(resume).readBigUInt64LE(17), BigInt(recorded.resumeBytes));

  const nextToken = TOKEN.map((byte) => byte ^ 0xff);
  assert.equal(stream.resumed(welcome(BigInt(recorded.nonce) + 1n, nextToken)), false);
  assert.equal(stream.resumed(welcome(recorded.nonce, nextToken)), true);
  actions.push(...drive(stream, second.frames.map((frame) => frame.bytes)));
  assert.equal(stream.bytesReceived, recorded.resumeBytes + joined(second.frames).length);
  assert.deepEqual([...stream.resumeFrame().subarray(1, 17)], [...nextToken]);

  const output = screenFeed(actions).map((event) => event.text).join('');
  const lines = output.split('\r\n').filter((line) => line.startsWith('line '));
  assert.deepEqual(lines, Array.from({ length: recorded.lines }, (_, index) => `line ${index + 1}`));
});

test('a RESUME cut inside a Rex message counts the held bytes and continues', () => {
  const recorded = fixture('resize');
  const bytes = joined(recorded.connections[0].frames);
  const expected = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), [bytes]));
  for (const [start, end] of apcSpans(bytes, recorded.nonce)) {
    for (let cut = start; cut <= end; cut++) {
      const stream = new rex.RexStream(welcome(recorded.nonce));
      const actions = drive(stream, [bytes.slice(0, cut)]);
      assert.equal(stream.bytesReceived, cut);
      assert.equal(Buffer.from(stream.resumeFrame()).readBigUInt64LE(17), BigInt(cut));
      assert.equal(stream.resumed(welcome(recorded.nonce)), true);
      actions.push(...drive(stream, [bytes.slice(cut)]));
      assert.deepEqual(screenFeed(actions), expected, `resume at ${cut}`);
    }
  }
});

test('output during the seed request re-seeds after the stream goes quiet', () => {
  const recorded = fixture('busy');
  const frames = recorded.connections[0].frames;
  const stream = new rex.RexStream(welcome(recorded.nonce));
  const markerAt = frames[markerFrame(recorded)].atMs;
  const seedReplyAt = markerAt + 50;
  const lastFrameAt = frames[frames.length - 1].atMs;
  const log = [];
  let checkAt = null;
  let seedPending = false;
  const take = (now, list) => {
    for (const action of list) {
      log.push({ now, ...action });
      if (action.type === 'check-at') {
        assert.equal(checkAt, null, 'one check outstanding at a time');
        checkAt = action.at;
      }
      if (action.type === 'request-seed') seedPending = true;
    }
  };
  const timeline = frames.map((frame) => ({ at: frame.atMs, run: (now) => take(now, stream.receive(frame.bytes, now)) }));
  timeline.push({ at: seedReplyAt, run: () => { seedPending = false; take(seedReplyAt, stream.seedArrived('SEED')); } });
  timeline.sort((a, b) => a.at - b.at);
  for (let now = 0; now <= lastFrameAt + 5 * rex.RESEED_QUIET_MS; now++) {
    while (timeline.length && timeline[0].at <= now) timeline.shift().run(now);
    if (checkAt !== null && now >= checkAt) {
      checkAt = null;
      take(now, stream.tick(now));
    }
  }
  const requests = log.filter((action) => action.type === 'request-seed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].now, markerAt);
  assert.ok(requests[1].now >= lastFrameAt + rex.RESEED_QUIET_MS, `re-seed at ${requests[1].now}, last output at ${lastFrameAt}`);
  assert.ok(requests[1].now <= lastFrameAt + rex.RESEED_QUIET_MS + 1);
  assert.ok(seedPending);

  const seedIndex = log.findIndex((action) => action.type === 'seed');
  assert.ok(log.slice(seedIndex + 1).some((action) => action.type === 'output'), 'held output follows the first seed');
  assert.ok(log.slice(seedIndex + 1).some((action) => action.type === 'check-at'));

  assert.deepEqual(stream.seedArrived('RESEED'), [{ type: 'seed', vt: 'RESEED', ...gridOf(recorded.grid) }]);
  assert.deepEqual(stream.tick(lastFrameAt + 100 * rex.RESEED_QUIET_MS), []);
});

test('a resize held during the seed sets the grid of the re-seed', () => {
  const recorded = fixture('resize');
  const bytes = joined(recorded.connections[0].frames);
  const [[, markerEnd], [, resizeEnd]] = apcSpans(bytes, recorded.nonce);
  const stream = new rex.RexStream(welcome(recorded.nonce));
  assert.deepEqual(stream.receive(bytes.slice(0, markerEnd), 0), [{ type: 'request-seed' }]);
  assert.deepEqual(stream.receive(bytes.slice(markerEnd, resizeEnd), 1), []);
  const seeded = stream.seedArrived('SEED');
  assert.deepEqual(seeded[0], { type: 'seed', vt: 'SEED', ...gridOf(recorded.grid) });
  assert.deepEqual(seeded.find((action) => action.type === 'resize'), { type: 'resize', ...gridOf(recorded.resizedGrid) });
  assert.deepEqual(seeded[seeded.length - 1], { type: 'check-at', at: 1 + rex.RESEED_QUIET_MS });
  assert.deepEqual(stream.tick(rex.RESEED_QUIET_MS), [{ type: 'check-at', at: 1 + rex.RESEED_QUIET_MS }]);
  assert.deepEqual(stream.tick(1 + rex.RESEED_QUIET_MS), [{ type: 'request-seed' }]);
  assert.deepEqual(stream.seedArrived('RESEED'), [{ type: 'seed', vt: 'RESEED', ...gridOf(recorded.resizedGrid) }]);
});

test('an unterminated Rex message is released as output past the bound', () => {
  const recorded = fixture('output');
  const stream = new rex.RexStream(welcome(recorded.nonce));
  drive(stream, recorded.connections[0].frames.map((frame) => frame.bytes));
  const opened = Buffer.from(`\x1b_rex1;${recorded.nonce};{"type":"resize"`, 'latin1');
  assert.deepEqual(stream.receive(new Uint8Array(opened), 0), []);
  const filler = new Uint8Array(rex.MAX_REX_MESSAGE_BYTES).fill(0x61);
  const released = stream.receive(filler, 0);
  const text = released.map((action) => Buffer.from(action.bytes).toString('latin1')).join('');
  assert.equal(text, opened.toString('latin1') + 'a'.repeat(rex.MAX_REX_MESSAGE_BYTES));
});

test('the program exit and the block close come from the stream', () => {
  const recorded = fixture('exit');
  const [connection] = recorded.connections;
  const feed = screenFeed(drive(new rex.RexStream(welcome(recorded.nonce)), connection.frames.map((frame) => frame.bytes)));
  assert.deepEqual(feed[feed.length - 1], { type: 'exited', exitCode: 0 });
  assert.equal(connection.close.code, 4000);
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: connection.close.code }), 'pane-closed');
});

test('nextStepAfter resumes drops and restarts refused or reset streams', () => {
  assert.equal(rex.nextStepAfter({ kind: 'rejected', reason: 'invalid-ticket' }), 'restart');
  assert.equal(rex.nextStepAfter({ kind: 'rejected', reason: 'unknown' }), 'restart');
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: 1013 }), 'restart');
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: 4000 }), 'pane-closed');
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: 1001 }), 'resume');
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: 1006 }), 'resume');
  assert.equal(rex.nextStepAfter({ kind: 'closed', code: null }), 'resume');
});
