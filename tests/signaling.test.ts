import { test, expect } from 'bun:test';
import {
  serverMessageSchema,
  type ServerMessage,
} from '../src/lib/signaling/messages';
import {
  SignalingHub,
  type Client,
  type SignalingSocket,
} from '../server/signaling';
import {
  issueRoomAccessToken,
  issueRoomCredential,
} from '../server/roomCredentials';

const ROOM_SECRET = 'test-room-token-secret-at-least-32-characters';
const ROOM_PASSWORD = 'correct horse battery staple';

function authorized(message: unknown) {
  if (
    !message ||
    typeof message !== 'object' ||
    !('type' in message) ||
    message.type !== 'join-room'
  )
    return message;
  const join = message as {
    type: 'join-room';
    roomId: string;
    clientId?: string;
    credential?: string;
    password?: string;
  };
  return {
    ...join,
    credential:
      join.credential ??
      issueRoomCredential(
        ROOM_SECRET,
        join.roomId,
        'Sala de teste',
        ROOM_PASSWORD,
      ),
    password: join.password ?? ROOM_PASSWORD,
  };
}

class FakeSocket implements SignalingSocket {
  inbox: ServerMessage[] = [];
  closed = false;
  buffered = 0;
  send(message: string) {
    this.inbox.push(serverMessageSchema.parse(JSON.parse(message)));
    return message.length;
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.closed = true;
  }
  ping() {
    return 1;
  }
  getBufferedAmount() {
    return this.buffered;
  }
  take(type: ServerMessage['type']) {
    const index = this.inbox.findIndex(message => message.type === type);
    if (index < 0) throw new Error(`Mensagem ${type} não encontrada`);
    return this.inbox.splice(index, 1)[0];
  }
}

type Peer = {
  client: Client;
  socket: FakeSocket;
  send(message: unknown): void;
  take(type: ServerMessage['type']): ServerMessage;
};

test('signed rooms preserve their name across hubs and reject invalid access', () => {
  const connect = (hub: SignalingHub) => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    return {
      client,
      socket,
      send: (message: unknown) => hub.message(client, JSON.stringify(message)),
    };
  };
  const firstHub = new SignalingHub(ROOM_SECRET);
  const creator = connect(firstHub);
  creator.send({
    type: 'create-room',
    name: '  Sala permanente  ',
    password: ROOM_PASSWORD,
  });
  const created = creator.socket.take('room-created');
  if (created.type !== 'room-created') throw new Error();
  expect(created.roomName).toBe('Sala permanente');
  expect(created.passwordProtected).toBeTrue();
  expect(created.credential).not.toContain(ROOM_PASSWORD);

  const wrong = connect(firstHub);
  wrong.send({
    type: 'join-room',
    roomId: created.roomId,
    credential: created.credential,
    password: 'another-password',
  });
  expect(wrong.socket.take('room-access-denied')).toEqual({
    type: 'room-access-denied',
    reason: 'wrong-password',
  });
  expect(firstHub.rooms.has(created.roomId)).toBeFalse();
  for (let attempt = 1; attempt < 5; attempt++) {
    wrong.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
      password: 'another-password',
    });
    expect(wrong.socket.take('room-access-denied').type).toBe(
      'room-access-denied',
    );
  }
  wrong.send({
    type: 'join-room',
    roomId: created.roomId,
    credential: created.credential,
    password: 'another-password',
  });
  expect(wrong.socket.take('room-access-denied')).toEqual({
    type: 'room-access-denied',
    reason: 'too-many-attempts',
  });
  expect(wrong.socket.closed).toBeTrue();

  const tampered = connect(firstHub);
  tampered.send({
    type: 'join-room',
    roomId: created.roomId,
    credential: `${created.credential.slice(0, -1)}x`,
    password: ROOM_PASSWORD,
  });
  expect(tampered.socket.take('room-access-denied')).toEqual({
    type: 'room-access-denied',
    reason: 'invalid-invite',
  });
  firstHub.close();

  const restartedHub = new SignalingHub(ROOM_SECRET);
  try {
    const participant = connect(restartedHub);
    participant.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
      password: ROOM_PASSWORD,
    });
    const joined = participant.socket.take('joined');
    expect(joined.type === 'joined' && joined.roomName).toBe('Sala permanente');
    if (joined.type !== 'joined') throw new Error();
    expect(joined.passwordProtected).toBeTrue();
    expect(joined.accessToken).not.toBeNull();
    expect(joined.accessTokenExpiresAt).toBeGreaterThan(Date.now());

    restartedHub.leave(participant.client);
    const remembered = connect(restartedHub);
    remembered.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
      accessToken: joined.accessToken,
    });
    expect(remembered.socket.take('joined').type).toBe('joined');

    const expired = connect(restartedHub);
    expired.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
      accessToken: issueRoomAccessToken(ROOM_SECRET, created.roomId, 0).token,
    });
    expect(expired.socket.take('room-access-denied')).toEqual({
      type: 'room-access-denied',
      reason: 'password-required',
    });

    const foreignHub = new SignalingHub(
      'different-room-token-secret-at-least-32-chars',
    );
    const foreign = connect(foreignHub);
    foreign.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
      password: ROOM_PASSWORD,
    });
    expect(foreign.socket.take('room-access-denied')).toEqual({
      type: 'room-access-denied',
      reason: 'invalid-invite',
    });
    foreignHub.close();
  } finally {
    restartedHub.close();
  }
});

test('rooms without a password can be joined directly and do not issue access tokens', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const connect = () => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    return {
      socket,
      send: (message: unknown) => hub.message(client, JSON.stringify(message)),
    };
  };
  try {
    const creator = connect();
    creator.send({ type: 'create-room', name: 'Sala pública' });
    const created = creator.socket.take('room-created');
    if (created.type !== 'room-created') throw new Error();
    expect(created.passwordProtected).toBeFalse();

    const participant = connect();
    participant.send({
      type: 'join-room',
      roomId: created.roomId,
      credential: created.credential,
    });
    const joined = participant.socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    expect(joined.passwordProtected).toBeFalse();
    expect(joined.accessToken).toBeNull();
    expect(joined.accessTokenExpiresAt).toBeNull();
  } finally {
    hub.close();
  }
});

test('a protected room accepts a single-character password', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const client = hub.createClient();
  const socket = new FakeSocket();
  hub.open(client, socket);
  try {
    hub.message(
      client,
      JSON.stringify({
        type: 'create-room',
        name: 'Senha curta',
        password: 'x',
      }),
    );
    const created = socket.take('room-created');
    if (created.type !== 'room-created') throw new Error();
    hub.message(
      client,
      JSON.stringify({
        type: 'join-room',
        roomId: created.roomId,
        credential: created.credential,
        password: 'x',
      }),
    );
    expect(socket.take('joined').type).toBe('joined');
  } finally {
    hub.close();
  }
});

test('room subscriptions: two selections, reciprocal watching, isolation and independent lifecycle', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const connect = (): Peer => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    return {
      client,
      socket,
      send: message => hub.message(client, JSON.stringify(authorized(message))),
      take: type => socket.take(type),
    };
  };
  const roomId = crypto.randomUUID();
  const join = (room = roomId) => {
    const peer = connect();
    peer.send({ type: 'join-room', roomId: room });
    const message = peer.take('joined');
    if (message.type !== 'joined') throw new Error();
    return { ...peer, id: message.peerId };
  };
  try {
    const a = join();
    const b = join();
    const c = join();
    const d = join();
    const e = join();
    a.send('{invalid');
    expect(a.take('error').type).toBe('error');
    a.send({ type: 'join-room', roomId });
    expect(a.take('error').type).toBe('error');
    a.send({ type: 'sharing-started' });
    b.send({ type: 'sharing-started' });

    const outsider = join(crypto.randomUUID());
    const rejectedSession = crypto.randomUUID();
    outsider.send({
      type: 'watch',
      targetPeerId: a.id,
      sessionId: rejectedSession,
    });
    expect(outsider.take('watching')).toEqual({
      type: 'watching',
      peerId: null,
      sessionId: rejectedSession,
    });
    expect(outsider.take('error').type).toBe('error');
    a.send({
      type: 'watch',
      targetPeerId: a.id,
      sessionId: crypto.randomUUID(),
    });
    a.take('watching');
    a.take('error');
    c.send({
      type: 'watch',
      targetPeerId: d.id,
      sessionId: crypto.randomUUID(),
    });
    c.take('watching');
    c.take('error');

    const watch = (viewer: typeof a, publisher: typeof a) => {
      const sessionId = crypto.randomUUID();
      viewer.send({ type: 'watch', targetPeerId: publisher.id, sessionId });
      expect(viewer.take('watching')).toEqual({
        type: 'watching',
        peerId: publisher.id,
        sessionId,
      });
      expect(publisher.take('subscriber-joined')).toEqual({
        type: 'subscriber-joined',
        peerId: viewer.id,
        sessionId,
      });
      return sessionId;
    };
    const ca = watch(c, a);
    const offer = {
      type: 'offer' as const,
      targetPeerId: c.id,
      sessionId: ca,
      sdp: { type: 'offer' as const, sdp: 'v=0\r\n' },
    };
    a.send(offer);
    expect(c.take('offer')).toEqual({
      type: 'offer',
      peerId: a.id,
      sessionId: ca,
      sdp: offer.sdp,
    });
    c.send({
      type: 'answer',
      targetPeerId: a.id,
      sessionId: ca,
      sdp: { type: 'answer', sdp: 'v=0\r\n' },
    });
    expect(a.take('answer').type).toBe('answer');
    c.send({
      type: 'ice-candidate',
      targetPeerId: a.id,
      sessionId: ca,
      candidate: { candidate: '', sdpMid: '0' },
    });
    expect(a.take('ice-candidate').type).toBe('ice-candidate');

    const ab = watch(a, b);
    const ba = watch(b, a);
    const cb = watch(c, b);
    d.send({ type: 'sharing-started' });
    const rejectedThird = crypto.randomUUID();
    c.send({ type: 'watch', targetPeerId: d.id, sessionId: rejectedThird });
    expect(c.take('watching')).toEqual({
      type: 'watching',
      peerId: null,
      sessionId: rejectedThird,
    });
    expect(c.take('error').type).toBe('error');
    expect(
      d.socket.inbox.filter(message => message.type === 'subscriber-joined'),
    ).toHaveLength(0);
    a.send(offer);
    expect(c.take('offer').type).toBe('offer');
    b.send({ ...offer, sessionId: cb });
    const nextOffer = c.take('offer');
    expect(
      nextOffer.type === 'offer' &&
        nextOffer.peerId === b.id &&
        nextOffer.sessionId === cb,
    ).toBeTrue();

    c.send({ ...offer, targetPeerId: b.id, sessionId: cb });
    d.send({ ...offer, targetPeerId: c.id, sessionId: crypto.randomUUID() });
    b.send({ type: 'sharing-stopped' });
    expect(a.take('subscription-ended')).toEqual({
      type: 'subscription-ended',
      peerId: b.id,
      sessionId: ab,
    });
    expect(c.take('subscription-ended').type).toBe('subscription-ended');
    expect(
      b.socket.inbox.filter(message => message.type === 'offer'),
    ).toHaveLength(0);
    expect(
      c.socket.inbox.filter(message => message.type === 'offer'),
    ).toHaveLength(0);
    for (const expected of [ab, cb]) {
      const ended = b.take('subscription-ended');
      expect(
        ended.type === 'subscription-ended' && ended.sessionId === expected,
      ).toBeTrue();
    }

    a.send({ ...offer, targetPeerId: b.id, sessionId: ba });
    b.take('offer');
    hub.leave(a.client);
    const endedByA = b.take('subscription-ended');
    expect(
      endedByA.type === 'subscription-ended' && endedByA.sessionId === ba,
    ).toBeTrue();
    const endedForC = c.take('subscription-ended');
    expect(
      endedForC.type === 'subscription-ended' && endedForC.sessionId === ca,
    ).toBeTrue();
    b.send({ type: 'sharing-started' });
    const resumedCb = watch(c, b);

    c.send({ type: 'watch', targetPeerId: null, sessionId: resumedCb });
    c.take('subscription-ended');
    c.take('watching');
    const db = watch(d, b);
    e.send({ type: 'watch', targetPeerId: b.id, sessionId: db });
    e.take('watching');
    e.take('error');
  } finally {
    hub.close();
  }
});

test('rooms accept ten participants and reject the eleventh', () => {
  const hub = new SignalingHub(ROOM_SECRET, 10);
  try {
    const roomId = crypto.randomUUID();
    for (let index = 0; index < 10; index++) {
      const client = hub.createClient();
      const socket = new FakeSocket();
      hub.open(client, socket);
      hub.message(
        client,
        JSON.stringify(authorized({ type: 'join-room', roomId })),
      );
      const joined = socket.take('joined');
      expect(joined.type === 'joined' && joined.peers.length).toBe(index + 1);
    }
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    hub.message(
      client,
      JSON.stringify(authorized({ type: 'join-room', roomId })),
    );
    expect(socket.take('error')).toEqual({
      type: 'error',
      message: 'Sala cheia: limite de 10 participantes.',
    });
  } finally {
    hub.close();
  }
});

test('without a configured cap the room accepts more than ten participants', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const roomId = crypto.randomUUID();
    for (let index = 0; index < 13; index++) {
      const client = hub.createClient();
      const socket = new FakeSocket();
      hub.open(client, socket);
      hub.message(
        client,
        JSON.stringify(authorized({ type: 'join-room', roomId })),
      );
      const joined = socket.take('joined');
      expect(joined.type === 'joined' && joined.peers.length).toBe(index + 1);
    }
  } finally {
    hub.close();
  }
});

test('participant aliases: trimmed, capped, broadcast to the room and reset on leave', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const connect = () => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    return {
      client,
      socket,
      send: (message: unknown) =>
        hub.message(client, JSON.stringify(authorized(message))),
    };
  };
  const roomId = crypto.randomUUID();
  const join = () => {
    const peer = connect();
    peer.send({ type: 'join-room', roomId });
    const joined = peer.socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    return { ...peer, id: joined.peerId };
  };
  try {
    const a = join();
    const b = join();
    b.socket.inbox.length = 0;

    a.send({ type: 'set-alias', alias: `  ${'x'.repeat(40)}  ` });
    const seenByB = b.socket.take('room-state');
    if (seenByB.type !== 'room-state') throw new Error();
    const aliasForA = seenByB.peers.find(peer => peer.peerId === a.id)?.alias;
    expect(aliasForA).toBe('x'.repeat(32));

    // Idempotent updates do not re-broadcast.
    b.socket.inbox.length = 0;
    a.send({ type: 'set-alias', alias: 'x'.repeat(32) });
    expect(b.socket.inbox).toHaveLength(0);

    // Clearing the alias falls back to null.
    a.send({ type: 'set-alias', alias: '' });
    const cleared = b.socket.take('room-state');
    if (cleared.type !== 'room-state') throw new Error();
    expect(cleared.peers.find(peer => peer.peerId === a.id)?.alias).toBeNull();

    // Alias outside a room is rejected.
    const outsider = connect();
    outsider.send({ type: 'set-alias', alias: 'nope' });
    expect(outsider.socket.take('error').type).toBe('error');

    hub.leave(a.client);
    const afterLeave = b.socket.take('room-state');
    if (afterLeave.type !== 'room-state') throw new Error();
    expect(afterLeave.peers.some(peer => peer.peerId === a.id)).toBeFalse();
  } finally {
    hub.close();
  }
});

test('rt-publish / rt-unpublish carry the Cloudflare tracks and reset on leave', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const connect = () => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    return {
      client,
      socket,
      send: (message: unknown) =>
        hub.message(client, JSON.stringify(authorized(message))),
    };
  };
  const roomId = crypto.randomUUID();
  const join = () => {
    const peer = connect();
    peer.send({ type: 'join-room', roomId });
    const joined = peer.socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    return { ...peer, id: joined.peerId };
  };
  try {
    const a = join();
    const b = join();
    b.socket.inbox.length = 0;

    a.send({
      type: 'rt-publish',
      sessionId: 'cf-sess-a',
      video: 'vid-a',
      audio: null,
    });
    const published = b.socket.take('room-state');
    if (published.type !== 'room-state') throw new Error();
    const entry = published.peers.find(peer => peer.peerId === a.id);
    expect(entry?.sharing).toBeTrue();
    expect(entry?.rt).toEqual({
      sessionId: 'cf-sess-a',
      video: 'vid-a',
      audio: null,
    });

    b.socket.inbox.length = 0;
    a.send({ type: 'rt-unpublish' });
    const unpublished = b.socket.take('room-state');
    if (unpublished.type !== 'room-state') throw new Error();
    const after = unpublished.peers.find(peer => peer.peerId === a.id);
    expect(after?.sharing).toBeFalse();
    expect(after?.rt).toBeNull();

    a.send({
      type: 'rt-publish',
      sessionId: 'cf-sess-a2',
      video: 'vid-a2',
      audio: 'aud-a2',
    });
    b.socket.take('room-state');
    hub.leave(a.client);
    const afterLeave = b.socket.take('room-state');
    if (afterLeave.type !== 'room-state') throw new Error();
    expect(afterLeave.peers.some(peer => peer.peerId === a.id)).toBeFalse();
  } finally {
    hub.close();
  }
});

test('rate, payload and backpressure failures do not crash the hub', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const client = hub.createClient();
  const socket = new FakeSocket();
  hub.open(client, socket);
  hub.message(client, new Uint8Array([1]));
  expect(socket.take('error').type).toBe('error');
  for (let index = 0; index < 151; index++) hub.message(client, '{}');
  expect(socket.closed).toBeTrue();

  const slow = hub.createClient();
  const slowSocket = new FakeSocket();
  slowSocket.buffered = 2 * 1024 * 1024;
  hub.open(slow, slowSocket);
  hub.message(slow, '{}');
  expect(slowSocket.closed).toBeTrue();
  hub.close();
});

test('ping is answered with pong without needing a room', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const client = hub.createClient();
  const socket = new FakeSocket();
  hub.open(client, socket);
  hub.message(client, JSON.stringify({ type: 'ping' }));
  expect(socket.take('pong').type).toBe('pong');
  hub.close();
});

test('a reconnecting client reclaims its previous peer id', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const roomId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const join = () => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    hub.message(
      client,
      JSON.stringify(authorized({ type: 'join-room', roomId, clientId })),
    );
    return { client, socket };
  };
  try {
    const first = join();
    const joined = first.socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    expect(joined.peerId).toBe(clientId);
    hub.leave(first.client);

    const second = join();
    const rejoined = second.socket.take('joined');
    if (rejoined.type !== 'joined') throw new Error();
    expect(rejoined.peerId).toBe(clientId);
  } finally {
    hub.close();
  }
});

test('a reconnect race evicts the stale connection instead of duplicating the participant', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  const roomId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const join = () => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    hub.message(
      client,
      JSON.stringify(authorized({ type: 'join-room', roomId, clientId })),
    );
    return { client, socket };
  };
  try {
    const first = join();
    const joined = first.socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    expect(joined.peerId).toBe(clientId);

    // The old socket's close event has not fired yet (network blip, not a clean
    // close), so the stale member is still in the room when the client reconnects.
    const second = join();
    const rejoined = second.socket.take('joined');
    if (rejoined.type !== 'joined') throw new Error();
    expect(rejoined.peerId).toBe(clientId);
    expect(rejoined.peers).toHaveLength(1);
    expect(first.socket.closed).toBe(true);
    const state = second.socket.take('room-state');
    if (state.type !== 'room-state') throw new Error();
    expect(state.peers).toHaveLength(1);
    expect(state.peers[0]?.peerId).toBe(clientId);

    // The stale socket's belated close event must be a no-op: it must not remove
    // the member that already reclaimed this identity.
    second.socket.inbox.length = 0;
    hub.leave(first.client);
    expect(second.socket.inbox).toHaveLength(0);
  } finally {
    hub.close();
  }
});

function graceRoom(hub: SignalingHub) {
  const roomId = crypto.randomUUID();
  const join = (clientId: string = crypto.randomUUID(), resume = false) => {
    const client = hub.createClient();
    const socket = new FakeSocket();
    hub.open(client, socket);
    const send = (message: unknown) =>
      hub.message(client, JSON.stringify(authorized(message)));
    send({
      type: 'join-room',
      roomId,
      clientId,
      ...(resume ? { resume } : {}),
    });
    const joined = socket.take('joined');
    if (joined.type !== 'joined') throw new Error();
    return { client, socket, send, clientId, joined };
  };
  // A sharer with one viewer subscribed to it.
  const sharer = join();
  sharer.send({ type: 'sharing-started' });
  const viewer = join();
  const sessionId = crypto.randomUUID();
  viewer.send({ type: 'watch', targetPeerId: sharer.clientId, sessionId });
  viewer.socket.take('watching');
  sharer.socket.take('subscriber-joined');
  sharer.socket.inbox.length = 0;
  viewer.socket.inbox.length = 0;
  return { join, sharer, viewer, sessionId };
}

const ice = (targetPeerId: string, sessionId: string) => ({
  type: 'ice-candidate',
  targetPeerId,
  sessionId,
  candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host' },
});

test('a dropped socket keeps its place, sharing and subscriptions until it resumes', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const { join, sharer, viewer, sessionId } = graceRoom(hub);

    hub.disconnect(sharer.client);
    // The room sees nothing: the P2P connection to the viewer keeps running.
    expect(viewer.socket.inbox).toHaveLength(0);
    // Signals sent meanwhile wait for the sharer instead of being dropped.
    viewer.send(ice(sharer.clientId, sessionId));

    const back = join(sharer.clientId, true);
    expect(back.joined).toMatchObject({
      resumed: true,
      peerId: sharer.clientId,
    });
    if (back.joined.type !== 'joined') throw new Error();
    expect(back.joined.peers).toHaveLength(2);
    expect(
      back.joined.peers.find(peer => peer.peerId === sharer.clientId)?.sharing,
    ).toBeTrue();
    expect(back.socket.take('ice-candidate')).toMatchObject({
      peerId: viewer.clientId,
      sessionId,
    });

    // The subscription moved to the new socket: relaying still works both ways.
    back.send(ice(viewer.clientId, sessionId));
    expect(viewer.socket.take('ice-candidate')).toMatchObject({
      peerId: sharer.clientId,
    });
    expect(viewer.socket.inbox.map(message => message.type)).not.toContain(
      'subscription-ended',
    );

    // The old socket's belated close is a no-op.
    hub.disconnect(sharer.client);
    hub.leave(sharer.client);
    expect(viewer.socket.inbox.map(message => message.type)).not.toContain(
      'subscription-ended',
    );
  } finally {
    hub.close();
  }
});

test('a resumed client does not count twice against the room cap', () => {
  const hub = new SignalingHub(ROOM_SECRET, 2);
  try {
    const { join, sharer } = graceRoom(hub);
    hub.disconnect(sharer.client);
    expect(join(sharer.clientId, true).joined).toMatchObject({ resumed: true });
  } finally {
    hub.close();
  }
});

test('the reconnect grace expires into a normal leave', async () => {
  const hub = new SignalingHub(ROOM_SECRET, undefined, 5);
  try {
    const { join, sharer, viewer, sessionId } = graceRoom(hub);
    hub.disconnect(sharer.client);
    await Bun.sleep(20);
    expect(viewer.socket.take('subscription-ended')).toEqual({
      type: 'subscription-ended',
      peerId: sharer.clientId,
      sessionId,
    });
    const state = viewer.socket.take('room-state');
    if (state.type !== 'room-state') throw new Error();
    expect(state.peers.map(peer => peer.peerId)).toEqual([viewer.clientId]);

    const back = join(sharer.clientId, true);
    expect(back.joined).toMatchObject({
      resumed: false,
      peerId: sharer.clientId,
    });
  } finally {
    hub.close();
  }
});

test('a reconnect whose pending messages overflowed starts over', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const { join, sharer, viewer, sessionId } = graceRoom(hub);
    hub.disconnect(sharer.client);
    for (let i = 0; i < 300; i++) {
      // Stay under the per-second rate limit.
      viewer.client.count = 0;
      viewer.send(ice(sharer.clientId, sessionId));
    }
    const back = join(sharer.clientId, true);
    expect(back.joined).toMatchObject({ resumed: false });
    expect(back.socket.inbox.map(message => message.type)).not.toContain(
      'ice-candidate',
    );
    expect(viewer.socket.take('subscription-ended')).toMatchObject({
      peerId: sharer.clientId,
      sessionId,
    });
  } finally {
    hub.close();
  }
});

test('a socket reaped by the heartbeat also gets the reconnect grace', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const { join, sharer, viewer } = graceRoom(hub);
    hub.heartbeat();
    hub.pong(viewer.client);
    hub.heartbeat();
    expect(sharer.socket.closed).toBeTrue();
    expect(viewer.socket.inbox.map(message => message.type)).toEqual([]);
    expect(join(sharer.clientId, true).joined).toMatchObject({ resumed: true });
  } finally {
    hub.close();
  }
});

test('a rejoin that does not ask to resume evicts the dropped entry', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const { join, sharer, viewer, sessionId } = graceRoom(hub);
    hub.disconnect(sharer.client);
    expect(join(sharer.clientId).joined).toMatchObject({ resumed: false });
    expect(viewer.socket.take('subscription-ended')).toMatchObject({
      peerId: sharer.clientId,
      sessionId,
    });
  } finally {
    hub.close();
  }
});

test('an explicit leave skips the reconnect grace', () => {
  const hub = new SignalingHub(ROOM_SECRET);
  try {
    const { sharer, viewer, sessionId } = graceRoom(hub);
    sharer.send({ type: 'leave' });
    expect(sharer.socket.closed).toBeTrue();
    expect(viewer.socket.take('subscription-ended')).toMatchObject({
      peerId: sharer.clientId,
      sessionId,
    });
    const state = viewer.socket.take('room-state');
    if (state.type !== 'room-state') throw new Error();
    expect(state.peers.map(peer => peer.peerId)).toEqual([viewer.clientId]);
  } finally {
    hub.close();
  }
});
