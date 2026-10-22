import {
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from './messages';

// App-level heartbeat: a backgrounded or half-open socket can stay "open" for minutes
// after the server is gone. Ping regularly and treat a ping left unanswered for
// PONG_TIMEOUT_MS as a disconnect. The deadline counts from the ping, not from the
// last message: a hidden tab's timers can fire a minute late, and a late tick must
// not be mistaken for a dead socket.
const PING_INTERVAL_MS = 12_000;
const PONG_TIMEOUT_MS = 20_000;

// What a heartbeat tick does, given when the last ping went out and when anything
// last arrived from the server.
export function heartbeatAction(
  now: number,
  pingSentAt: number,
  lastActivity: number,
) {
  if (pingSentAt <= lastActivity) return 'ping';
  return now - pingSentAt > PONG_TIMEOUT_MS ? 'timeout' : 'wait';
}

export type SignalingClose = { code: number; reason: string; openMs: number };

export function connectSignaling(
  roomId: string,
  credential: string,
  password: string | undefined,
  accessToken: string | undefined,
  clientId: string,
  onMessage: (message: ServerMessage) => void,
  onState: (state: string, close?: SignalingClose) => void,
  resume = false,
) {
  const url = new URL('/signaling', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const send = (message: ClientMessage) => {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error('Signaling desconectado.');
    socket.send(JSON.stringify(message));
  };

  let openedAt = 0;
  let lastActivity = 0;
  let pingSentAt = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const closeInfo = (code: number, reason: string): SignalingClose => ({
    code,
    reason,
    openMs: openedAt ? Date.now() - openedAt : 0,
  });
  const startHeartbeat = () => {
    stopHeartbeat();
    lastActivity = Date.now();
    pingSentAt = 0;
    heartbeat = setInterval(() => {
      const now = Date.now();
      const action = heartbeatAction(now, pingSentAt, lastActivity);
      if (action === 'timeout') {
        stopHeartbeat();
        onState('disconnected', closeInfo(4000, 'heartbeat timeout'));
        socket.close();
        return;
      }
      // Still waiting on a reply that isn't late yet: keep its deadline.
      if (action === 'wait') return;
      try {
        send({ type: 'ping' });
        pingSentAt = now;
      } catch {
        /* Not open yet or already closing; onclose reports it. */
      }
    }, PING_INTERVAL_MS);
  };
  // A tab coming back to the foreground may have slept through its pings: check
  // the socket right away instead of waiting for the next tick.
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || !heartbeat) return;
    if (pingSentAt > lastActivity) return;
    try {
      send({ type: 'ping' });
      pingSentAt = Date.now();
    } catch {
      /* onclose reports it. */
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  // Closing or reloading the tab is a real leave: tell the server so it doesn't
  // hold the place for a reconnect that will never come.
  const leave = () => {
    try {
      send({ type: 'leave' });
    } catch {
      /* Already closed: the server's reconnect grace covers it. */
    }
  };
  window.addEventListener('pagehide', leave);
  const detach = () => {
    stopHeartbeat();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', leave);
  };

  socket.onopen = () => {
    openedAt = Date.now();
    onState('connected');
    send({
      type: 'join-room',
      roomId,
      credential,
      ...(password ? { password } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(clientId ? { clientId } : {}),
      ...(resume ? { resume } : {}),
    });
    startHeartbeat();
  };
  socket.onmessage = (event: MessageEvent<unknown>) => {
    lastActivity = Date.now();
    try {
      if (typeof event.data !== 'string') throw new Error();
      const message = serverMessageSchema.parse(JSON.parse(event.data));
      if (message.type === 'pong') return;
      onMessage(message);
    } catch {
      stopHeartbeat();
      onState('invalid-message', closeInfo(4002, 'invalid message'));
      socket.close();
    }
  };
  // No onerror: onclose always follows an error and carries the close code.
  socket.onclose = event => {
    detach();
    // 1012 is only sent by our own server on shutdown (redeploy). 1001 comes from
    // whatever proxy sits in between going away, which is not a new version.
    onState(
      event.code === 1012 ? 'restarting' : 'disconnected',
      closeInfo(event.code, event.reason),
    );
  };
  return {
    send,
    // leave: this tab is done with the room (not a reconnect).
    close: (leaving = false) => {
      if (leaving) leave();
      detach();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    },
  };
}

export function createRoom(name: string, password?: string) {
  return new Promise<Extract<ServerMessage, { type: 'room-created' }>>(
    (resolve, reject) => {
      const url = new URL('/signaling', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      const finish = (
        error?: Error,
        room?: Extract<ServerMessage, { type: 'room-created' }>,
      ) => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        if (error) reject(error);
        else if (room) resolve(room);
      };
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            type: 'create-room',
            name,
            ...(password ? { password } : {}),
          }),
        );
      socket.onmessage = event => {
        try {
          if (typeof event.data !== 'string') throw new Error();
          const message = serverMessageSchema.parse(JSON.parse(event.data));
          if (message.type === 'room-created') finish(undefined, message);
          else if (message.type === 'error') finish(new Error(message.message));
        } catch {
          finish(new Error('O servidor retornou uma resposta inválida.'));
        }
      };
      socket.onerror = () =>
        finish(new Error('Não foi possível conectar ao servidor.'));
      socket.onclose = () =>
        finish(new Error('A conexão foi encerrada antes da criação da sala.'));
    },
  );
}
