import {
  clientMessageSchema,
  MAX_WATCHED_STREAMS,
  type RtPublication,
  type ServerMessage,
} from '../src/lib/signaling/messages';
import {
  issueRoomAccessToken,
  issueRoomCredential,
  verifyRoomAccessToken,
  verifyRoomCredential,
  verifyRoomPassword,
} from './roomCredentials';

export type SignalingSocket = {
  send(message: string): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): number;
  getBufferedAmount(): number;
};

type Subscription = { publisherId: string; sessionId: string };
export type Client = {
  id: string;
  socket?: SignalingSocket;
  roomId?: string;
  alias?: string;
  sharing: boolean;
  // Onde encontrar as tracks deste cliente no SFU Cloudflare (modo cloudflare).
  rtPublication?: RtPublication;
  watching: Map<string, Subscription>;
  // Enquanto o socket caiu e a reconexão ainda pode retomar o lugar na sala
  // (disconnect): o que chegou para este cliente nesse meio-tempo.
  grace?: {
    timer: ReturnType<typeof setTimeout>;
    outbox: string[];
    overflowed: boolean;
  };
  alive: boolean;
  count: number;
  window: number;
  failedRoomAttempts: number;
};
type Room = { name: string; members: Map<string, Client> };

// Quanto tempo um participante cujo socket caiu continua na sala esperando a
// reconexão. A mídia é P2P e não depende do socket: uma queda curta do proxy ou da
// rede não deve encerrar transmissões nem aparecer como saída e entrada.
const RECONNECT_GRACE_MS = 20_000;
const GRACE_OUTBOX_LIMIT = 256;

export class SignalingHub {
  readonly rooms = new Map<string, Room>();
  readonly clients = new Set<Client>();

  // maxRoomParticipants ausente = sem limite. Aplicado no join-room, que os dois
  // modos usam para presença.
  constructor(
    private readonly roomTokenSecret: string,
    private readonly maxRoomParticipants?: number,
    private readonly reconnectGraceMs = RECONNECT_GRACE_MS,
  ) {}

  createClient(): Client {
    return {
      id: crypto.randomUUID(),
      sharing: false,
      watching: new Map(),
      alive: true,
      count: 0,
      window: Date.now(),
      failedRoomAttempts: 0,
    };
  }

  open(client: Client, socket: SignalingSocket) {
    client.socket = socket;
    if (this.clients.size >= 250) {
      socket.close(1013, 'Server full');
      return;
    }
    this.clients.add(client);
  }

  private send(client: Client, message: ServerMessage) {
    if (!client.socket) {
      // room-state fica de fora: o joined da reconexão já traz a lista atual.
      const grace = client.grace;
      if (!grace || message.type === 'room-state' || message.type === 'pong')
        return;
      if (grace.outbox.length < GRACE_OUTBOX_LIMIT)
        grace.outbox.push(JSON.stringify(message));
      else grace.overflowed = true;
      return;
    }
    if (client.socket.getBufferedAmount() > 1024 * 1024) {
      client.socket.terminate();
      this.leave(client);
      return;
    }
    client.socket.send(JSON.stringify(message));
  }

  private participants(room: Room) {
    return [...room.members.values()].map(client => ({
      peerId: client.id,
      sharing: client.sharing,
      alias: client.alias ?? null,
      rt: client.rtPublication ?? null,
    }));
  }

  private broadcast(room: Room) {
    const message: ServerMessage = {
      type: 'room-state',
      peers: this.participants(room),
    };
    for (const member of room.members.values()) this.send(member, message);
  }

  private unsubscribe(viewer: Client, room: Room, sessionId: string) {
    const subscription = viewer.watching.get(sessionId);
    if (!subscription) return;
    viewer.watching.delete(sessionId);
    this.send(viewer, {
      type: 'subscription-ended',
      peerId: subscription.publisherId,
      sessionId: subscription.sessionId,
    });
    const publisher = room.members.get(subscription.publisherId);
    if (publisher)
      this.send(publisher, {
        type: 'subscription-ended',
        peerId: viewer.id,
        sessionId: subscription.sessionId,
      });
  }

  private stopPublishing(publisher: Client, room: Room) {
    publisher.sharing = false;
    publisher.rtPublication = undefined;
    for (const viewer of room.members.values()) {
      for (const subscription of viewer.watching.values())
        if (subscription.publisherId === publisher.id)
          this.unsubscribe(viewer, room, subscription.sessionId);
    }
  }

  // O socket caiu: quem está numa sala ganha reconnectGraceMs para voltar com o
  // mesmo clientId e retomar tudo (join-room); só depois disso sai de fato.
  disconnect(client: Client) {
    if (!client.socket) return;
    client.socket = undefined;
    this.clients.delete(client);
    if (!client.roomId || !this.reconnectGraceMs) {
      this.leave(client);
      return;
    }
    client.grace = {
      timer: setTimeout(() => this.leave(client), this.reconnectGraceMs),
      outbox: [],
      overflowed: false,
    };
  }

  leave(client: Client) {
    if (client.grace) clearTimeout(client.grace.timer);
    client.grace = undefined;
    this.clients.delete(client);
    const roomId = client.roomId;
    client.roomId = undefined;
    client.socket = undefined;
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room || !roomId) return;
    for (const sessionId of client.watching.keys())
      this.unsubscribe(client, room, sessionId);
    this.stopPublishing(client, room);
    room.members.delete(client.id);
    if (!room.members.size) this.rooms.delete(roomId);
    else this.broadcast(room);
  }

  pong(client: Client) {
    client.alive = true;
  }

  message(client: Client, data: string | BufferSource) {
    const fail = (message: string) =>
      this.send(client, { type: 'error', message });
    if (Date.now() - client.window > 1000) {
      client.window = Date.now();
      client.count = 0;
    }
    if (++client.count > 150) {
      client.socket?.close(1008, 'Rate limit');
      return;
    }
    let input: unknown;
    try {
      if (typeof data !== 'string') throw new Error();
      input = JSON.parse(data);
    } catch {
      fail('Mensagem inválida.');
      return;
    }
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) {
      fail('Mensagem inválida.');
      return;
    }
    const message = parsed.data;
    if (message.type === 'ping') {
      this.send(client, { type: 'pong' });
      return;
    }
    if (message.type === 'leave') {
      const socket = client.socket;
      this.leave(client);
      socket?.close(1000, 'Left');
      return;
    }
    if (message.type === 'create-room') {
      if (client.roomId) {
        fail('Saia da sala atual antes de criar outra.');
        return;
      }
      const roomId = crypto.randomUUID();
      this.send(client, {
        type: 'room-created',
        roomId,
        roomName: message.name,
        credential: issueRoomCredential(
          this.roomTokenSecret,
          roomId,
          message.name,
          message.password,
        ),
        passwordProtected: Boolean(message.password),
      });
      return;
    }
    if (message.type === 'join-room') {
      if (client.roomId) {
        fail('Você já está em uma sala.');
        return;
      }
      if (client.failedRoomAttempts >= 5) {
        this.send(client, {
          type: 'room-access-denied',
          reason: 'too-many-attempts',
        });
        client.socket?.close(1008, 'Too many room access attempts');
        return;
      }
      const verified = verifyRoomCredential(
        this.roomTokenSecret,
        message.roomId,
        message.credential,
      );
      if (!verified.ok) {
        client.failedRoomAttempts++;
        this.send(client, {
          type: 'room-access-denied',
          reason: verified.reason,
        });
        return;
      }
      let accessToken: string | null = null;
      let accessTokenExpiresAt: number | null = null;
      if (verified.room.passwordProof) {
        const access = message.accessToken
          ? verifyRoomAccessToken(
              this.roomTokenSecret,
              message.roomId,
              message.accessToken,
            )
          : null;
        if (access) {
          accessToken = message.accessToken ?? null;
          accessTokenExpiresAt = access.expiresAt;
        } else if (
          message.password &&
          verifyRoomPassword(
            this.roomTokenSecret,
            verified.room,
            message.password,
          )
        ) {
          const issued = issueRoomAccessToken(
            this.roomTokenSecret,
            message.roomId,
          );
          accessToken = issued.token;
          accessTokenExpiresAt = issued.expiresAt;
        } else {
          client.failedRoomAttempts++;
          this.send(client, {
            type: 'room-access-denied',
            reason: message.password ? 'wrong-password' : 'password-required',
          });
          return;
        }
      }
      let room = this.rooms.get(message.roomId);
      if (!room) {
        room = { name: verified.room.roomName, members: new Map() };
        this.rooms.set(message.roomId, room);
      }
      const previous = message.clientId
        ? room.members.get(message.clientId)
        : undefined;
      if (
        !previous &&
        this.maxRoomParticipants &&
        room.members.size >= this.maxRoomParticipants
      ) {
        fail(
          `Sala cheia: limite de ${this.maxRoomParticipants} participantes.`,
        );
        return;
      }
      // A reconnecting client reclaims its previous identity. Only the originating
      // tab ever knows its own clientId, so a member with it is this same client on
      // a dropped socket: either waiting out its reconnect grace or a half-open
      // connection the heartbeat hasn't reaped yet. When the client still holds its
      // session (resume), its sharing, subscriptions and pending messages move to
      // the new socket, so the P2P connections that kept running meanwhile stay
      // valid and the room never sees a leave. Otherwise the stale entry is evicted.
      let resumed = false;
      let pending: string[] = [];
      if (message.clientId && previous && previous !== client) {
        const grace = previous.grace;
        resumed = Boolean(message.resume) && !grace?.overflowed;
        if (grace) clearTimeout(grace.timer);
        previous.grace = undefined;
        if (resumed) {
          pending = grace?.outbox ?? [];
          client.alias = previous.alias;
          client.sharing = previous.sharing;
          client.rtPublication = previous.rtPublication;
          client.watching = previous.watching;
          previous.watching = new Map();
          previous.sharing = false;
          previous.rtPublication = undefined;
        } else {
          for (const sessionId of previous.watching.keys())
            this.unsubscribe(previous, room, sessionId);
          this.stopPublishing(previous, room);
        }
        room.members.delete(previous.id);
        this.clients.delete(previous);
        previous.roomId = undefined;
        const socket = previous.socket;
        previous.socket = undefined;
        socket?.close(4001, 'Reconectado em outra sessão.');
      }
      if (message.clientId) client.id = message.clientId;
      client.roomId = message.roomId;
      room.members.set(client.id, client);
      this.send(client, {
        type: 'joined',
        roomId: message.roomId,
        roomName: room.name,
        passwordProtected: Boolean(verified.room.passwordProof),
        accessToken,
        accessTokenExpiresAt,
        peerId: client.id,
        peers: this.participants(room),
        resumed,
      });
      if (client.socket)
        for (const queued of pending) client.socket.send(queued);
      this.broadcast(room);
      return;
    }
    const room = client.roomId ? this.rooms.get(client.roomId) : undefined;
    if (!room) {
      fail('Entre em uma sala primeiro.');
      return;
    }
    if (
      message.type === 'sharing-started' ||
      message.type === 'sharing-stopped'
    ) {
      if (message.type === 'sharing-started') client.sharing = true;
      else this.stopPublishing(client, room);
      this.broadcast(room);
      return;
    }
    if (message.type === 'rt-publish') {
      client.sharing = true;
      client.rtPublication = {
        sessionId: message.sessionId,
        video: message.video,
        audio: message.audio,
      };
      this.broadcast(room);
      return;
    }
    if (message.type === 'rt-unpublish') {
      this.stopPublishing(client, room);
      this.broadcast(room);
      return;
    }
    if (message.type === 'set-alias') {
      const alias = message.alias || undefined;
      if (client.alias === alias) return;
      client.alias = alias;
      this.broadcast(room);
      return;
    }
    if (message.type === 'watch') {
      if (!message.targetPeerId) {
        this.unsubscribe(client, room, message.sessionId);
        this.send(client, {
          type: 'watching',
          peerId: null,
          sessionId: message.sessionId,
        });
        return;
      }
      const publisher = message.targetPeerId
        ? room.members.get(message.targetPeerId)
        : undefined;
      const duplicateSession = [...room.members.values()].some(member =>
        member.watching.has(message.sessionId),
      );
      const duplicatePublisher = [...client.watching.values()].some(
        item => item.publisherId === message.targetPeerId,
      );
      if (
        !publisher?.sharing ||
        publisher === client ||
        duplicateSession ||
        duplicatePublisher ||
        client.watching.size >= MAX_WATCHED_STREAMS
      ) {
        this.send(client, {
          type: 'watching',
          peerId: null,
          sessionId: message.sessionId,
        });
        fail('Transmissão indisponível ou seleção inválida.');
        return;
      }
      this.send(client, {
        type: 'watching',
        peerId: publisher?.id ?? null,
        sessionId: message.sessionId,
      });
      if (publisher) {
        client.watching.set(message.sessionId, {
          publisherId: publisher.id,
          sessionId: message.sessionId,
        });
        this.send(publisher, {
          type: 'subscriber-joined',
          peerId: client.id,
          sessionId: message.sessionId,
        });
      }
      return;
    }
    const target = room.members.get(message.targetPeerId);
    if (!target || target === client) {
      fail('Destino inválido.');
      return;
    }
    const targetSubscription = target.watching.get(message.sessionId);
    const clientSubscription = client.watching.get(message.sessionId);
    const sending =
      client.sharing && targetSubscription?.publisherId === client.id;
    const receiving =
      target.sharing && clientSubscription?.publisherId === target.id;
    const authorized =
      message.type === 'offer'
        ? sending
        : message.type === 'answer'
          ? receiving
          : sending || receiving;
    if (!authorized) return;
    const { targetPeerId: _target, ...payload } = message;
    void _target;
    this.send(target, { ...payload, peerId: client.id });
  }

  heartbeat() {
    for (const client of this.clients) {
      if (!client.alive) {
        const socket = client.socket;
        this.disconnect(client);
        socket?.terminate();
        continue;
      }
      client.alive = false;
      client.socket?.ping();
    }
  }

  close() {
    // 1012 = service restart: tells clients this is a redeploy, not a lost connection.
    for (const client of this.clients)
      client.socket?.close(1012, 'Server restarting');
    for (const room of this.rooms.values())
      for (const member of room.members.values())
        if (member.grace) clearTimeout(member.grace.timer);
    this.clients.clear();
    this.rooms.clear();
  }
}
