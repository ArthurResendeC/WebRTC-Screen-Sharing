import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Locator,
} from '@playwright/test';

type TestWindow = Window & {
  testConnections: RTCPeerConnection[];
  testSockets: WebSocket[];
  testTrack: MediaStreamTrack;
  testPictureInPictureRequests: number;
  testAutoPipHandler: (() => void) | null;
  testDisplayOptions: DisplayMediaStreamOptions | undefined;
};
const remoteVideo = (page: Page) =>
  page.getByLabel('Transmissão selecionada', { exact: true });
const secondRemoteVideo = (page: Page) =>
  page.getByLabel('Segunda transmissão selecionada', { exact: true });
const shareButton = (page: Page) => page.locator('[data-share]');
const stopShareButton = (page: Page) => page.locator('[data-stop-share]');
const participantCount = (page: Page) => page.locator('[data-participants]');
const ROOM_PASSWORD = 'password-for-e2e';

async function createProtectedRoom(page: Page, name = 'Sala E2E') {
  await page.getByLabel('Nome da sala').fill(name);
  await page
    .getByLabel('Senha (opcional)', { exact: true })
    .fill(ROOM_PASSWORD);
  await page.getByRole('button', { name: 'Criar sala' }).click();
  await expect(page).toHaveURL(/\/room\//);
}

async function instrument(context: BrowserContext) {
  await context.addInitScript(() => {
    const connections: RTCPeerConnection[] = [];
    const sockets: WebSocket[] = [];
    Object.assign(window, {
      testConnections: connections,
      testSockets: sockets,
      testPictureInPictureRequests: 0,
      testAutoPipHandler: null,
    });

    let pictureInPictureElement: Element | null = null;
    let fullscreenElement: Element | null = null;
    Object.defineProperties(document, {
      pictureInPictureEnabled: { configurable: true, get: () => true },
      pictureInPictureElement: {
        configurable: true,
        get: () => pictureInPictureElement,
      },
      fullscreenEnabled: { configurable: true, get: () => true },
      fullscreenElement: { configurable: true, get: () => fullscreenElement },
    });
    const enterPictureInPicture = (element: HTMLVideoElement) => {
      pictureInPictureElement = element;
      element.dispatchEvent(new Event('enterpictureinpicture'));
    };
    HTMLVideoElement.prototype.requestPictureInPicture = async function () {
      (window as unknown as TestWindow).testPictureInPictureRequests++;
      enterPictureInPicture(this);
      return Object.assign(new EventTarget(), {
        width: 640,
        height: 360,
        onresize: null,
      });
    };
    document.exitPictureInPicture = async () => {
      const previous = pictureInPictureElement;
      pictureInPictureElement = null;
      previous?.dispatchEvent(new Event('leavepictureinpicture'));
    };
    const enterFullscreen = (element: Element) => {
      fullscreenElement = element;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    Element.prototype.requestFullscreen = async function () {
      enterFullscreen(this);
    };
    document.exitFullscreen = async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };

    const mediaSession = navigator.mediaSession;
    const nativeActionHandler =
      mediaSession.setActionHandler.bind(mediaSession);
    mediaSession.setActionHandler = ((
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      if ((action as string) === 'enterpictureinpicture') {
        (window as unknown as TestWindow).testAutoPipHandler = handler
          ? () => handler({ action })
          : null;
        return;
      }
      nativeActionHandler(action, handler);
    }) as typeof mediaSession.setActionHandler;
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        connections.push(this);
      }
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
}
// Several colors stand for several surfaces: each picker call returns the next one.
async function capture(page: Page, color: string | string[], withAudio = true) {
  await page.addInitScript(
    ({ colors, withAudio }) => {
      let calls = 0;
      navigator.mediaDevices.getDisplayMedia = async options => {
        Object.assign(window, { testDisplayOptions: options });
        const color = colors[Math.min(calls++, colors.length - 1)]!;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d')!;
        const paint = () => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 640, 360);
        };
        paint();
        const timer = setInterval(paint, 50);
        const stream = canvas.captureStream(20);
        let audio: AudioContext | undefined;
        if (withAudio) {
          audio = new AudioContext();
          const oscillator = audio.createOscillator();
          const destination = audio.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await audio.resume();
          stream.addTrack(destination.stream.getAudioTracks()[0]);
        }
        const track = stream.getVideoTracks()[0];
        const originalStop = track.stop.bind(track);
        const cleanup = () => {
          clearInterval(timer);
          if (audio?.state !== 'closed') void audio?.close();
        };
        track.stop = () => {
          originalStop();
          cleanup();
        };
        track.addEventListener('ended', cleanup);
        Object.assign(window, { testTrack: track });
        return stream;
      };
    },
    { colors: [color].flat(), withAudio },
  );
}
async function enterRoom(page: Page, name?: string) {
  const passwordGate = page.locator('[data-password-gate]');
  if (await passwordGate.isVisible()) {
    await page.getByLabel('Senha da sala').fill(ROOM_PASSWORD);
    await passwordGate
      .getByRole('button', { name: 'Entrar', exact: true })
      .click();
    await expect(passwordGate).toBeHidden();
  }
  const gate = page.locator('[data-name-gate]');
  // Wait for the controller to render before reading the gate: a stored alias keeps it
  // hidden and there is nothing to do, otherwise fill the name and enter.
  await gate.waitFor({ state: 'attached' });
  if (await gate.isHidden()) return;
  if (name !== undefined)
    await page.getByLabel('Seu nome na sala', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Entrar na sala', exact: true })
    .click();
  await expect(gate).toBeHidden();
}
async function identity(page: Page) {
  return (await page.getByText(/^Você: /).innerText()).replace('Você: ', '');
}
async function choose(viewer: Page, name: string) {
  await viewer
    .getByRole('button', {
      name: new RegExp(`^(Assistir a|Reconectar a) ${name}$`),
    })
    .click();
}
// The player's control bar hides after a few idle seconds, which a loaded machine
// running five pages can spend before a click lands. Focus inside the player keeps
// the bar up, so the click no longer races that timer.
async function pressMediaControl(control: Locator) {
  await control.focus();
  await control.click();
}

async function playing(page: Page, color: 'red' | 'blue', audio: number) {
  await expect
    .poll(() =>
      remoteVideo(page).evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        if (video.videoWidth) ctx.drawImage(video, 0, 0, 1, 1);
        const [red, , blue] = ctx.getImageData(0, 0, 1, 1).data;
        return {
          color: red > 150 ? 'red' : blue > 150 ? 'blue' : 'none',
          audio: (video.srcObject as MediaStream | null)?.getAudioTracks()
            .length,
          playing: !video.paused && video.currentTime > 0,
          muted: video.muted,
        };
      }),
    )
    .toEqual({ color, audio, playing: true, muted: false });
  await expect(
    page.getByText('Conexão: 1/1 conectadas', { exact: true }),
  ).toBeVisible();
  if (audio) {
    await expect
      .poll(() =>
        page.evaluate(async () => {
          let bytes = 0;
          for (const pc of (
            window as unknown as TestWindow
          ).testConnections.filter(pc => pc.connectionState === 'connected')) {
            (await pc.getStats()).forEach(
              (stat: RTCStats & { kind?: string; bytesReceived?: number }) => {
                if (stat.type === 'inbound-rtp' && stat.kind === 'audio')
                  bytes += stat.bytesReceived ?? 0;
              },
            );
          }
          return bytes;
        }),
      )
      .toBeGreaterThan(0);
  }
}
async function activeCounts(page: Page) {
  return page.evaluate(() => {
    const active = (window as unknown as TestWindow).testConnections.filter(
      pc => pc.connectionState !== 'closed',
    );
    return {
      sending: active.filter(pc =>
        pc.getTransceivers().some(t => t.direction === 'sendonly'),
      ).length,
      receiving: active.filter(pc =>
        pc.getTransceivers().some(t => t.currentDirection === 'recvonly'),
      ).length,
      total: active.length,
    };
  });
}
async function cleared(page: Page) {
  // "Cleared" covers both outcomes: the stream element stays but is emptied, or the
  // grid unmounts entirely (the "Transmissão encerrada" screen or the picker).
  await expect
    .poll(async () => {
      const video = remoteVideo(page);
      if ((await video.count()) === 0) return true;
      return video.evaluate(
        (element: HTMLVideoElement) => element.srcObject === null,
      );
    })
    .toBe(true);
}

test('protected room validates its password and each browser manages its own favorite', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await createProtectedRoom(page, 'Planejamento semanal');
  await enterRoom(page, 'Criador');
  await expect(
    page.getByText('Planejamento semanal', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', {
      name: 'Abrir sala favorita Planejamento semanal',
    }),
  ).toBeVisible();
  const invite = page.url();
  expect(invite).toContain('#credential=');
  expect(invite).not.toContain(ROOM_PASSWORD);

  const participantContext = await browser.newContext();
  const participant = await participantContext.newPage();
  await participant.goto(invite);
  await expect(
    participant.getByRole('link', { name: 'Voltar ao início' }),
  ).toBeVisible();
  await participant.getByLabel('Senha da sala').fill('wrong-password');
  await participant
    .getByRole('button', { name: 'Entrar', exact: true })
    .click();
  await expect(
    participant.getByText('Senha incorreta. Tente novamente.'),
  ).toBeVisible();
  await participant.getByLabel('Senha da sala').fill(ROOM_PASSWORD);
  await participant
    .getByRole('button', { name: 'Entrar', exact: true })
    .click();
  await enterRoom(participant, 'Convidado');
  await participant
    .getByRole('button', { name: 'Favoritar', exact: true })
    .click();
  await expect(
    participant.getByRole('button', { name: 'Favoritada', exact: true }),
  ).toBeVisible();
  expect(
    await participant.evaluate(
      password => Object.values(localStorage).join(' ').includes(password),
      ROOM_PASSWORD,
    ),
  ).toBe(false);

  await participant.goto('/');
  await expect(
    participant.getByText('Salas favoritas', { exact: true }),
  ).toBeVisible();
  await participant.getByText('Planejamento semanal', { exact: true }).click();
  await expect(participant.locator('[data-password-gate]')).toHaveCount(0);
  await expect(participant.locator('[data-participants]')).toHaveText('2');
  await participantContext.close();
});

test('creates and enters a room without a password', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Nome da sala').fill('Sala sem senha');
  const optionalPassword = page.getByLabel('Senha (opcional)', { exact: true });
  await page.getByRole('button', { name: 'Mostrar senha' }).click();
  await expect(optionalPassword).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Ocultar senha' }).click();
  await expect(optionalPassword).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Criar sala' }).click();
  await expect(page).toHaveURL(/\/room\//);
  await enterRoom(page, 'Visitante');
  await expect(page.locator('[data-password-gate]')).toHaveCount(0);
  await expect(page.getByText('Sala sem senha', { exact: true })).toBeVisible();
});

test('five participants: simultaneous publishing, reciprocal watching and two remote streams', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  const errors: string[] = [];
  context.on('page', page =>
    page.on('pageerror', error => errors.push(error.message)),
  );
  a.on('pageerror', error => errors.push(error.message));
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const url = a.url();
  const b = await context.newPage();
  await capture(b, '#0000ff', false);
  await b.goto(url);
  await enterRoom(b);
  const bName = await identity(b);
  const viewers: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const viewer = await context.newPage();
    await viewer.goto(url);
    await enterRoom(viewer);
    await identity(viewer);
    viewers.push(viewer);
  }
  await expect(participantCount(a)).toHaveText('5');
  await shareButton(a).click();
  await shareButton(b).click();
  await expect(b.locator('[data-capture-info]')).toContainText(
    'Sem áudio nesta captura',
  );
  // Publishing with no subscribers does not create any RTP connections.
  await expect
    .poll(() => activeCounts(a))
    .toEqual({ sending: 0, receiving: 0, total: 0 });
  await Promise.all([choose(a, bName), choose(b, aName)]);
  await playing(a, 'blue', 0);
  await playing(b, 'red', 1);
  const bControls = b.locator('[data-media-controls]').first();
  await expect
    .poll(() =>
      bControls.evaluate(element => getComputedStyle(element).opacity),
    )
    .toBe('0');
  await remoteVideo(b).hover();
  await expect
    .poll(() =>
      bControls.evaluate(element => getComputedStyle(element).opacity),
    )
    .toBe('1');
  await pressMediaControl(
    b.getByRole('button', { name: 'Aumentar zoom', exact: true }),
  );
  await expect(
    b.getByRole('button', {
      name: 'Redefinir zoom, atualmente 125%',
      exact: true,
    }),
  ).toBeEnabled();
  expect(
    await remoteVideo(b).evaluate(
      (video: HTMLVideoElement) => video.style.transform,
    ),
  ).toContain('scale(1.25)');
  await b
    .getByRole('button', {
      name: 'Redefinir zoom, atualmente 125%',
      exact: true,
    })
    .click();
  await expect(
    b.getByRole('button', { name: 'Diminuir zoom', exact: true }),
  ).toBeDisabled();
  expect(
    await remoteVideo(b).evaluate(
      (video: HTMLVideoElement) => video.style.transform,
    ),
  ).toContain('scale(1)');
  const muteButton = b.getByRole('button', {
    name: 'Desligar áudio',
    exact: true,
  });
  await muteButton.click();
  await expect(
    b.getByRole('button', { name: 'Ligar áudio', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(remoteVideo(b)).toHaveJSProperty('muted', true);
  await b.getByRole('button', { name: 'Ligar áudio', exact: true }).click();
  await expect(remoteVideo(b)).toHaveJSProperty('muted', false);
  const volumeSlider = b.getByRole('slider', { name: 'Volume', exact: true });
  await volumeSlider.fill('40');
  await expect(remoteVideo(b)).toHaveJSProperty('volume', 0.4);
  await volumeSlider.fill('0');
  await expect(remoteVideo(b)).toHaveJSProperty('muted', true);
  await b.getByRole('button', { name: 'Ligar áudio', exact: true }).click();
  await expect(remoteVideo(b)).toHaveJSProperty('muted', false);
  await expect(remoteVideo(b)).toHaveJSProperty('volume', 0.4);
  await expect(volumeSlider).toHaveValue('40');

  await expect
    .poll(() =>
      b.evaluate(() =>
        Boolean((window as unknown as TestWindow).testAutoPipHandler),
      ),
    )
    .toBe(true);
  await b.evaluate(() =>
    (window as unknown as TestWindow).testAutoPipHandler?.(),
  );
  await expect(
    b.getByRole('button', { name: 'Sair do picture-in-picture', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(
    await b.evaluate(
      () => (window as unknown as TestWindow).testPictureInPictureRequests,
    ),
  ).toBe(1);
  await b
    .getByRole('button', { name: 'Sair do picture-in-picture', exact: true })
    .click();

  await b
    .getByRole('button', { name: 'Abrir em tela cheia', exact: true })
    .click();
  await expect(
    b.getByRole('button', { name: 'Sair da tela cheia', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await b
    .getByRole('button', { name: 'Sair da tela cheia', exact: true })
    .click();
  for (const viewer of viewers) {
    await choose(viewer, aName);
    await playing(viewer, 'red', 1);
  }
  await expect
    .poll(() => activeCounts(a))
    .toEqual({ sending: 4, receiving: 1, total: 5 });
  const c = viewers[0];
  await choose(c, bName);
  await expect(secondRemoteVideo(c)).toBeVisible();
  await expect
    .poll(() =>
      secondRemoteVideo(c).evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d')!;
        if (video.videoWidth) context.drawImage(video, 0, 0, 1, 1);
        const [red, , blue] = context.getImageData(0, 0, 1, 1).data;
        return {
          color: red > 150 ? 'red' : blue > 150 ? 'blue' : 'none',
          playing: !video.paused,
        };
      }),
    )
    .toEqual({ color: 'blue', playing: true });
  await expect
    .poll(() => activeCounts(c))
    .toEqual({ sending: 0, receiving: 2, total: 2 });
  await expect
    .poll(() => activeCounts(a))
    .toEqual({ sending: 4, receiving: 1, total: 5 });
  await expect
    .poll(() => activeCounts(b))
    .toEqual({ sending: 2, receiving: 1, total: 3 });

  const streamGrid = c.locator('.remote-stream-grid');
  await expect(streamGrid).toHaveClass(/layout-rows/);
  await c
    .getByRole('button', {
      name: 'Exibir transmissões lado a lado',
      exact: true,
    })
    .click();
  await expect(streamGrid).toHaveClass(/layout-columns/);
  await c
    .getByRole('button', { name: 'Empilhar transmissões', exact: true })
    .click();
  await expect(streamGrid).toHaveClass(/layout-rows/);

  const sidebarToggle = c.getByRole('button', {
    name: 'Recolher painel de participantes',
    exact: true,
  });
  await sidebarToggle.click();
  await expect(c.locator('#room-sidebar')).toHaveClass(/is-collapsed/);
  await expect(
    c.getByRole('button', {
      name: 'Expandir painel de participantes',
      exact: true,
    }),
  ).toHaveAttribute('aria-expanded', 'false');
  await c
    .getByRole('button', {
      name: 'Expandir painel de participantes',
      exact: true,
    })
    .click();
  await expect(c.locator('#room-sidebar')).not.toHaveClass(/is-collapsed/);

  // Each live can be stopped independently while the other remains connected.
  await pressMediaControl(
    c.getByRole('button', { name: 'Deixar de assistir', exact: true }).first(),
  );
  await playing(c, 'blue', 0);
  await expect
    .poll(() => activeCounts(c))
    .toEqual({ sending: 0, receiving: 1, total: 1 });
  await expect
    .poll(() => activeCounts(a))
    .toEqual({ sending: 3, receiving: 1, total: 4 });
  // Native stop only ends B's publication, preserving B's reception of A.
  await b.evaluate(() => {
    const track = (window as unknown as TestWindow).testTrack;
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
  await cleared(a);
  await playing(b, 'red', 1);
  // C was left on B's ended screen, so B sharing again reopens it on its own.
  await shareButton(b).click();
  await playing(c, 'blue', 0);
  await pressMediaControl(
    viewers[2].getByRole('button', { name: 'Deixar de assistir', exact: true }),
  );
  await cleared(viewers[2]);
  await expect
    .poll(() => activeCounts(viewers[2]))
    .toEqual({ sending: 0, receiving: 0, total: 0 });
  expect(
    await viewers[2].evaluate(
      () => (window as unknown as TestWindow).testAutoPipHandler,
    ),
  ).toBeNull();
  await a.close(); // Creator leaving does not close the room or B's stream.
  await expect(participantCount(b)).toHaveText('4');
  await cleared(b);
  await playing(c, 'blue', 0);
  await choose(viewers[1], bName);
  await playing(viewers[1], 'blue', 0);
  await stopShareButton(b).click();
  await cleared(c);
  await cleared(viewers[1]);
  expect(errors).toEqual([]);
});

test('participant aliases replace the default name for everyone and survive reconnect', async ({
  page: a,
  browser,
}) => {
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a, 'Sala da Alice');
  // The name gate is the first thing shown on entry.
  await enterRoom(a, 'Alice');
  await expect(a.getByText('Você: Alice', { exact: true })).toBeVisible();
  await expect(a.locator('[data-identity-name]')).toHaveText('Alice');

  // A second participant from a fresh browser (own storage) keeps the default name.
  const bContext = await browser.newContext();
  const b = await bContext.newPage();
  await b.goto(a.url());
  await enterRoom(b);

  // A's alias replaces the default name for everyone else.
  await expect(b.getByText('Alice', { exact: true })).toBeVisible();

  await shareButton(a).click();
  await expect(
    b.getByRole('button', { name: 'Assistir a Alice', exact: true }),
  ).toBeVisible();
  await expect(
    b.getByRole('button', { name: /^Assistir a Participante / }),
  ).toHaveCount(0);

  // A can rename from settings and everyone sees the new name.
  await a.getByRole('button', { name: 'Configurações' }).click();
  await a.getByLabel('Alterar seu nome na sala').fill('Alicia');
  await a.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(a.locator('[data-identity-name]')).toHaveText('Alicia');
  await expect(
    b.getByRole('button', { name: 'Assistir a Alicia', exact: true }),
  ).toBeVisible();

  // The alias is stored locally and re-announced after a fresh session.
  await a.reload();
  await enterRoom(a);
  await expect(a.getByText('Você: Alicia', { exact: true })).toBeVisible();
  await expect(b.getByText('Alicia', { exact: true })).toBeVisible();
  await bContext.close();
});

const dropSignaling = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as TestWindow).testSockets
      .filter(socket => new URL(socket.url).pathname === '/signaling')
      .forEach(socket => socket.close()),
  );

// The remote stream on screen is the same object across a signaling drop only if
// the P2P connection carrying it was never torn down and renegotiated.
const markStream = (page: Page) =>
  remoteVideo(page).evaluate((video: HTMLVideoElement) => {
    (window as unknown as { markedStream: unknown }).markedStream =
      video.srcObject;
  });
const sameStream = (page: Page) =>
  remoteVideo(page).evaluate(
    (video: HTMLVideoElement) =>
      video.srcObject ===
      (window as unknown as { markedStream: unknown }).markedStream,
  );
const reconnected = (page: Page) =>
  expect(page.getByText(/Reconectando/)).toHaveCount(0);

test('a single lost signaling socket reconnects on its own and resumes sharing and watching', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#0000ff');
  await b.goto(a.url());
  await enterRoom(b);
  const bName = await identity(b);
  await shareButton(a).click();
  await shareButton(b).click();
  await Promise.all([choose(a, bName), choose(b, aName)]);
  await playing(a, 'blue', 1);
  await playing(b, 'red', 1);

  // B's socket drops. No button to press: B's socket comes back on its own and
  // the server hands back B's place, so neither stream is renegotiated.
  await markStream(a);
  await markStream(b);
  await dropSignaling(b);
  await reconnected(b);
  await expect(participantCount(b)).toHaveText('2');
  await playing(b, 'red', 1);
  expect(await sameStream(a)).toBe(true);
  expect(await sameStream(b)).toBe(true);
  expect(
    await b.evaluate(
      () => (window as unknown as TestWindow).testTrack.readyState,
    ),
  ).toBe('live');
  await playing(a, 'blue', 1);
});

test('a pure publisher whose socket drops keeps publishing to its viewer after reconnecting', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await b.goto(a.url());
  await enterRoom(b);
  await shareButton(a).click();
  await choose(b, aName);
  await playing(b, 'red', 1);

  // A only publishes — it is not watching anyone. Its socket drops and comes back
  // on its own; B's view never stops.
  await markStream(b);
  await dropSignaling(a);
  await reconnected(a);
  await expect(participantCount(a)).toHaveText('2');
  expect(await sameStream(b)).toBe(true);
  expect(
    await a.evaluate(
      () => (window as unknown as TestWindow).testTrack.readyState,
    ),
  ).toBe('live');
  await playing(b, 'red', 1);
});

test('a redeploy drops every socket at once and the room restores itself without interaction', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  const errors: string[] = [];
  context.on('page', page =>
    page.on('pageerror', error => errors.push(error.message)),
  );
  a.on('pageerror', error => errors.push(error.message));
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#0000ff');
  await b.goto(a.url());
  await enterRoom(b);
  const bName = await identity(b);
  await shareButton(a).click();
  await shareButton(b).click();
  await Promise.all([choose(a, bName), choose(b, aName)]);
  await playing(a, 'blue', 1);
  await playing(b, 'red', 1);

  // Simulate a Railway deploy: the server drops, every client socket closes together.
  await Promise.all([dropSignaling(a), dropSignaling(b)]);

  await expect(participantCount(a)).toHaveText('2');
  await expect(participantCount(b)).toHaveText('2');
  // Both captures survived the reconnect, so nobody re-picks a screen.
  expect(
    await a.evaluate(
      () => (window as unknown as TestWindow).testTrack.readyState,
    ),
  ).toBe('live');
  expect(
    await b.evaluate(
      () => (window as unknown as TestWindow).testTrack.readyState,
    ),
  ).toBe('live');
  // Both streams resume without touching the picker.
  await playing(a, 'blue', 1);
  await playing(b, 'red', 1);
  expect(errors).toEqual([]);
});

async function chooseAudioSource(page: Page, option: RegExp) {
  const settings = page.getByRole('button', {
    name: 'Configurações',
    exact: true,
  });
  if ((await page.locator('.settings-panel').count()) === 0)
    await settings.click();
  await page
    .getByRole('combobox', { name: 'De onde vem o áudio da transmissão' })
    .click();
  await page.getByRole('option', { name: option }).click();
}

async function inboundBytes(page: Page, kind: 'audio' | 'video') {
  return page.evaluate(async (wanted: string) => {
    let bytes = 0;
    for (const pc of (window as unknown as TestWindow).testConnections.filter(
      pc => pc.connectionState === 'connected',
    )) {
      (await pc.getStats()).forEach(
        (stat: RTCStats & { kind?: string; bytesReceived?: number }) => {
          if (stat.type === 'inbound-rtp' && stat.kind === wanted)
            bytes += stat.bytesReceived ?? 0;
        },
      );
    }
    return bytes;
  }, kind);
}

test('the sharer silences the audio without disturbing the video or renegotiating', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#0000ff', false);
  await b.goto(a.url());
  await enterRoom(b);
  await shareButton(a).click();
  await choose(b, aName);
  await playing(b, 'red', 1);
  const before = await activeCounts(b);

  await a.getByRole('button', { name: 'Configurações', exact: true }).click();
  await a.getByRole('button', { name: 'Mudo', exact: true }).click();

  // Muting deactivates the encoding: the audio stops arriving while the same
  // connection keeps carrying video, so nobody has to renegotiate.
  await expect
    .poll(async () => {
      const first = await inboundBytes(b, 'audio');
      await b.waitForTimeout(600);
      return (await inboundBytes(b, 'audio')) - first;
    })
    .toBe(0);
  const video = await inboundBytes(b, 'video');
  await expect.poll(() => inboundBytes(b, 'video')).toBeGreaterThan(video);
  expect(await activeCounts(b)).toEqual(before);

  // And it comes back on the same connection.
  await a.getByRole('button', { name: 'Ligado', exact: true }).click();
  const silent = await inboundBytes(b, 'audio');
  await expect.poll(() => inboundBytes(b, 'audio')).toBeGreaterThan(silent);
  expect(await activeCounts(b)).toEqual(before);
});

test('the sharer switches surfaces while viewers stay on the same connection', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, ['#ff0000', '#0000ff']);
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#00ff00', false);
  await b.goto(a.url());
  await enterRoom(b);
  await shareButton(a).click();
  await choose(b, aName);
  await playing(b, 'red', 1);
  const before = await activeCounts(b);
  const first = await a.evaluate(
    () => (window as unknown as TestWindow).testTrack.id,
  );

  await a.locator('[data-switch-share]').click();

  // The new surface reaches the viewer through the sender it already had: no new
  // subscription, no ended screen, and the old capture is released.
  await playing(b, 'blue', 1);
  expect(await activeCounts(b)).toEqual(before);
  await expect(b.getByText('Transmissão encerrada')).toHaveCount(0);
  expect(
    await a.evaluate(
      first =>
        (window as unknown as TestWindow).testTrack.id !== first &&
        (window as unknown as TestWindow).testTrack.readyState === 'live',
      first,
    ),
  ).toBe(true);
  await expect(a.locator('[data-switch-share]')).toBeEnabled();
});

test('cancelling the picker while switching keeps the current surface on the air', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#0000ff', false);
  await b.goto(a.url());
  await enterRoom(b);
  await shareButton(a).click();
  await choose(b, aName);
  await playing(b, 'red', 1);
  const before = await activeCounts(b);

  await a.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  });
  await a.locator('[data-switch-share]').click();

  await expect(a.locator('[data-switch-share]')).toBeEnabled();
  await expect(stopShareButton(a)).toBeEnabled();
  await playing(b, 'red', 1);
  expect(await activeCounts(b)).toEqual(before);
});

test('a viewer left on the ended screen starts watching again when the sharer comes back', async ({
  page: a,
  context,
}) => {
  await instrument(context);
  await capture(a, '#ff0000');
  await a.goto('/');
  await createProtectedRoom(a);
  await enterRoom(a);
  const aName = await identity(a);
  const b = await context.newPage();
  await capture(b, '#0000ff', false);
  await b.goto(a.url());
  await enterRoom(b);
  await shareButton(a).click();
  await choose(b, aName);
  await playing(b, 'red', 1);

  await stopShareButton(a).click();
  await expect(
    b.getByText('Transmissão encerrada', { exact: true }),
  ).toBeVisible();
  await shareButton(a).click();
  await playing(b, 'red', 1);

  // Going back to the list is a choice: the next share waits for a click again.
  await stopShareButton(a).click();
  await b.getByRole('button', { name: 'Voltar para a lista' }).click();
  await shareButton(a).click();
  await expect(
    b.getByRole('button', { name: `Assistir a ${aName}`, exact: true }),
  ).toBeVisible();
  await expect(remoteVideo(b)).toHaveCount(0);
});

test('the picker is asked to leave the system mix out unless the sharer asks for it', async ({
  page,
  context,
}) => {
  await instrument(context);
  await capture(page, '#ff0000');
  await page.goto('/');
  await createProtectedRoom(page);
  await enterRoom(page);
  await shareButton(page).click();

  // The default: a screen capture cannot pick up whatever else is playing on the
  // machine because the picker never offers it, and a window capture is asked for
  // that window's own audio instead of the system mix it would otherwise default to.
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).testDisplayOptions,
    ),
  ).toMatchObject({
    systemAudio: 'exclude',
    windowAudio: 'window',
    selfBrowserSurface: 'exclude',
  });

  await stopShareButton(page).click();
  await chooseAudioSource(page, /com o mix do sistema/);
  await shareButton(page).click();
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).testDisplayOptions,
    ),
  ).toMatchObject({ systemAudio: 'include', windowAudio: 'system' });

  // And the choice is remembered, so nobody re-enables it by accident on the next visit.
  await page.reload();
  await enterRoom(page);
  await shareButton(page).click();
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).testDisplayOptions,
    ),
  ).toMatchObject({ systemAudio: 'include', windowAudio: 'system' });

  // Choosing no audio at all stops the picker from being asked for any.
  await stopShareButton(page).click();
  await chooseAudioSource(page, /^Sem áudio$/);
  await shareButton(page).click();
  expect(
    await page.evaluate(
      () => (window as unknown as TestWindow).testDisplayOptions,
    ),
  ).toMatchObject({
    audio: false,
    systemAudio: 'exclude',
    windowAudio: 'exclude',
  });
  await expect(page.locator('[data-capture-info]')).toContainText('Sem áudio');
});
