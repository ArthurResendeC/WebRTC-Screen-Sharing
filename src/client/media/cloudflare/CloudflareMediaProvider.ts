import {
  connectSignaling,
  type SignalingClose,
} from '../../../lib/signaling/client';
import {
  ALIAS_MAX_LENGTH,
  type Participant,
  type ServerMessage,
} from '../../../lib/signaling/messages';
import {
  AUDIO_PROFILE_SETTINGS,
  type AudioProfile,
  setAudioProfile as applyAudioProfile,
  setAudioSending,
  tuneOpus,
} from '../../../lib/webrtc/audio';
import {
  normalizeVideoCodecPreference,
  setVideoCodecPreference,
  type VideoCodecPreference,
} from '../../../lib/webrtc/codecs';
import {
  MAX_VIDEO_BITRATE,
  rtcConfiguration,
  setVideoDegradation,
  type VideoDegradation,
  VIDEO_DEGRADATION_PREFERENCE,
} from '../../../lib/webrtc/rtcConfiguration';
import { reportSignalingDrop } from '../../errorReporting';
import { displayName, participantName } from '../../participantPresentation';
import { inviteUrl, rememberRoomAccess } from '../../roomStorage';
import { playSound, unlockSounds } from '../../sounds';
import { loadTheme, type Theme } from '../../theme';
import {
  type AudioSource,
  captureAudioInput,
  describeShareAudio,
  displayMediaConstraints,
  listAudioInputs,
  usesAudioInput,
} from '../audioCapture';
import {
  CAPTURE_PRESETS,
  persistAlias,
  persistAudioDeviceId,
  persistAudioProfile,
  persistAudioSource,
  persistCaptureQuality,
  persistCodecPreference,
  persistDegradation,
  storedAlias,
  storedAudioDeviceId,
  storedAudioProfile,
  storedAudioSource,
  storedCaptureQuality,
  storedCodecPreference,
  storedDegradation,
} from '../preferences';
import {
  ACCENTS,
  type CaptureQuality,
  type MediaProvider,
  type RemoteStream,
  type ScreenShareState,
} from '../types';
import {
  createRealtimeSession,
  RealtimeError,
  realtimeRenegotiate,
  realtimeTracksClose,
  realtimeTracksNew,
  type TrackRequest,
} from './api';
import { FifoQueue, waitForConnected, waitForIceGathering } from './session';

type Listener = () => void;
type Subscription = {
  videoMid: string;
  audioMid?: string;
  stream: MediaStream;
  publisherSessionId: string;
};
type LocalPublication = {
  videoName: string;
  videoMid: string;
  audioName: string | null;
  audioMid?: string;
};

// Provedor de mídia sobre o SFU Cloudflare Realtime. Uma RTCPeerConnection por
// navegador contra o edge da Cloudflare; o WebSocket carrega presença e "quem
// publicou o quê". Produz o mesmo ScreenShareState do provedor mesh — a UI não muda.
export class CloudflareMediaProvider implements MediaProvider {
  private readonly listeners = new Set<Listener>();
  private readonly clientId = crypto.randomUUID?.() ?? crypto.randomUUID();
  private readonly queue = new FifoQueue();
  private channel: ReturnType<typeof connectSignaling> | null = null;
  private pc: RTCPeerConnection | null = null;
  private ticket: string | null = null;
  private cfSessionId: string | null = null;
  private sessionSeq = 0;
  private joined = false;
  private localStream: MediaStream | null = null;
  private publication: LocalPublication | null = null;
  private sendTransceivers: RTCRtpTransceiver[] = [];
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscribeRetries = new Map<string, number>();
  private readonly midToPeer = new Map<
    string,
    { peerId: string; kind: 'video' | 'audio' }
  >();
  private readonly hidden = new Set<string>();
  private members: Participant[] = [];
  private membersSeeded = false;
  private knownWatcherIds = new Set<string>();
  private wantsToShare = false;
  private capturing = false;
  private started = false;
  private disposed = false;
  private accessTerminal = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private settingsTimer?: ReturnType<typeof setInterval>;
  // O SFU já rejeitou offer alterada uma vez (ver tuneOpus abaixo); quando isso
  // acontece, a sessão desiste do estéreo em vez de ficar sem compartilhar.
  private opusMunge = true;

  private state: ScreenShareState = {
    mediaProvider: 'cloudflare',
    socketState: 'connecting',
    selfId: '',
    members: [],
    selectedIds: [],
    alias: storedAlias(),
    capturing: false,
    switching: false,
    sharing: false,
    localStream: null,
    remoteStreams: [],
    captureInfo: '',
    connectionState: 'aguardando',
    watcherIds: [],
    error: '',
    joinError: '',
    accessError: '',
    roomName: '',
    passwordProtected: false,
    endedReason: null,
    endedPeerId: null,
    theme: loadTheme(),
    accent: ACCENTS[0].color,
    degradation: storedDegradation(),
    captureQuality: storedCaptureQuality(),
    codecPreference: storedCodecPreference(),
    audioSource: storedAudioSource(),
    audioProfile: storedAudioProfile(),
    audioDeviceId: storedAudioDeviceId(),
    audioInputs: [],
    audioMuted: false,
    audioLive: false,
    inviteCopied: false,
  };

  constructor(
    private readonly roomId: string,
    private readonly credential: string,
    private roomPassword?: string,
    private roomAccessToken?: string,
  ) {}

  getSnapshot = () => this.state;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ScreenShareState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setError(error: string) {
    this.update({ error });
  }

  private isCurrent(seq: number) {
    return seq === this.sessionSeq && !this.disposed;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    unlockSounds();
    setVideoDegradation(this.state.degradation);
    applyAudioProfile(this.state.audioProfile);
    setAudioSending(false);
    document.addEventListener('visibilitychange', this.wakeReconnect);
    window.addEventListener('online', this.wakeReconnect);
    window.addEventListener('pageshow', this.wakeReconnect);
    this.startSession();
  }

  nameOf(peerId: string | null) {
    if (!peerId) return '';
    const member = this.state.members.find(entry => entry.peerId === peerId);
    return member ? displayName(member) : participantName(peerId);
  }

  // ---- preferences ----

  setAlias(value: string) {
    const alias = value.trim().slice(0, ALIAS_MAX_LENGTH);
    persistAlias(alias);
    this.update({ alias });
    if (this.joined) {
      try {
        this.channel?.send({ type: 'set-alias', alias });
      } catch {
        // Reconnection re-sends it.
      }
    }
  }

  setTheme(theme: Theme) {
    this.update({ theme });
  }

  setAccent(accent: string) {
    if (ACCENTS.some(entry => entry.color === accent)) this.update({ accent });
  }

  setDegradation(value: VideoDegradation) {
    setVideoDegradation(value);
    persistDegradation(value);
    this.update({ degradation: value });
    void this.applyEncodeParameters();
  }

  async setCaptureQuality(value: CaptureQuality) {
    persistCaptureQuality(value);
    this.update({ captureQuality: value });
    const track = this.localStream?.getVideoTracks()[0];
    if (track?.readyState !== 'live') return;
    try {
      await track.applyConstraints(CAPTURE_PRESETS[value]);
    } catch {
      this.setError(
        'O navegador não reconfigurou a captura ao vivo; a nova qualidade vale no próximo compartilhamento.',
      );
    }
  }

  setCodecPreference(value: VideoCodecPreference) {
    persistCodecPreference(normalizeVideoCodecPreference(value));
    this.update({ codecPreference: normalizeVideoCodecPreference(value) });
  }

  // Nenhuma destas vale na transmissão em curso: o seletor só entrega áudio no
  // momento da captura, e trocar a track exigiria republicar no SFU.
  setAudioSource(value: AudioSource) {
    persistAudioSource(value);
    this.update({ audioSource: value });
  }

  setAudioProfile(value: AudioProfile) {
    persistAudioProfile(value);
    applyAudioProfile(value);
    this.update({ audioProfile: value });
    void this.applyEncodeParameters();
  }

  setAudioDevice(deviceId: string) {
    persistAudioDeviceId(deviceId);
    this.update({ audioDeviceId: deviceId });
  }

  // Desliga a codificação em vez da track: sem bytes no ar e sem republicar.
  setAudioMuted(value: boolean) {
    this.update({ audioMuted: value });
    setAudioSending(this.state.audioLive && !value);
    void this.applyEncodeParameters();
  }

  async refreshAudioInputs() {
    this.update({ audioInputs: await listAudioInputs() });
  }

  // O áudio vem da captura ou de uma entrada, nunca dos dois: misturar exigiria um
  // grafo de Web Audio, e este app compartilha tela, não conversa.
  private async captureAudio(captured: MediaStream) {
    const source = this.state.audioSource;
    if (source === 'none') return null;
    if (!usesAudioInput(source)) return captured.getAudioTracks()[0] ?? null;
    try {
      return await captureAudioInput(
        this.state.audioDeviceId,
        this.state.audioProfile,
      );
    } catch (error) {
      this.setError(
        error instanceof Error
          ? `Não foi possível abrir a entrada de áudio: ${error.message}`
          : 'Não foi possível abrir a entrada de áudio.',
      );
      return null;
    }
  }

  // ---- room access ----

  reconnect() {
    this.reconnectAttempts = 0;
    this.accessTerminal = false;
    this.startSession();
  }

  retryRoomPassword(password: string) {
    if (this.disposed || this.state.accessError === 'too-many-attempts') return;
    this.roomPassword = password;
    this.roomAccessToken = undefined;
    this.accessTerminal = false;
    this.reconnectAttempts = 0;
    this.update({ accessError: '', joinError: '' });
    this.startSession();
  }

  dismissJoinError() {
    this.update({ joinError: '' });
  }

  dismissEnded() {
    this.update({ endedReason: null, endedPeerId: null });
  }

  async copyInvite() {
    try {
      await navigator.clipboard.writeText(
        inviteUrl({ roomId: this.roomId, credential: this.credential }),
      );
      this.update({ inviteCopied: true });
    } catch {
      this.setError(
        'Não foi possível copiar. Copie a URL da barra do navegador.',
      );
    }
  }

  getPeers() {
    return null;
  }

  // ---- sharing ----

  async toggleShare() {
    if (this.state.sharing || this.capturing) this.stopSharing(true);
    else await this.share();
  }

  async share() {
    const seq = this.sessionSeq;
    if (!this.joined || !this.pc || this.state.sharing || this.capturing)
      return;
    this.update({ error: '', endedReason: null, endedPeerId: null });
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
      this.setError(
        'Captura de tela exige HTTPS (ou localhost) e um navegador compatível.',
      );
      return;
    }
    this.capturing = true;
    this.update({ capturing: true });
    try {
      const captured = await navigator.mediaDevices.getDisplayMedia(
        displayMediaConstraints(
          CAPTURE_PRESETS[this.state.captureQuality],
          this.state.audioSource,
        ),
      );
      const stale = () => !this.isCurrent(seq) || !this.joined;
      if (stale()) {
        captured.getTracks().forEach(track => track.stop());
        return;
      }
      const screenTrack = captured.getVideoTracks()[0];
      if (!screenTrack)
        throw new Error('A captura não retornou uma track de vídeo.');
      screenTrack.contentHint = 'motion';
      screenTrack.onended = () => this.stopSharing(true);
      const audioTrack = await this.captureAudio(captured);
      if (stale()) {
        audioTrack?.stop();
        captured.getTracks().forEach(track => track.stop());
        return;
      }
      this.update({ audioLive: Boolean(audioTrack) });
      setAudioSending(Boolean(audioTrack) && !this.state.audioMuted);
      this.localStream = new MediaStream(
        audioTrack ? [screenTrack, audioTrack] : [screenTrack],
      );
      this.wantsToShare = true;
      await this.queue.run(() => this.publish(seq, this.localStream!));
    } catch (error) {
      if (!this.isCurrent(seq)) return;
      if (error instanceof RealtimeError) {
        // Publicação falhou no SFU: mantém wantsToShare para o reconnect re-publicar.
        this.teardownCaptureKeepingIntent();
        this.handleTrackError(seq, error);
      } else {
        this.teardownCapture();
        this.setError(
          error instanceof Error
            ? `Não foi possível capturar: ${error.message}`
            : 'Captura cancelada.',
        );
      }
    } finally {
      this.capturing = false;
      if (this.isCurrent(seq)) this.update({ capturing: false });
    }
  }

  // Outra superfície no lugar da atual sem republicar: os mids e os trackNames no
  // SFU continuam os mesmos, então quem assiste nem precisa saber da troca.
  async switchShare() {
    const seq = this.sessionSeq;
    const previous = this.localStream;
    if (
      !this.joined ||
      !this.state.sharing ||
      !previous ||
      this.capturing ||
      this.state.switching
    )
      return;
    const stale = () =>
      !this.isCurrent(seq) ||
      !this.joined ||
      !this.state.sharing ||
      this.localStream !== previous;
    this.update({ switching: true, error: '' });
    let captured: MediaStream | null = null;
    let audioTrack: MediaStreamTrack | null = null;
    try {
      try {
        captured = await navigator.mediaDevices.getDisplayMedia(
          displayMediaConstraints(
            CAPTURE_PRESETS[this.state.captureQuality],
            this.state.audioSource,
          ),
        );
      } catch {
        // Seletor cancelado: o que já estava no ar continua.
        return;
      }
      if (stale()) return;
      const screenTrack = captured.getVideoTracks()[0];
      if (!screenTrack)
        throw new Error('A captura não retornou uma track de vídeo.');
      audioTrack = await this.captureAudio(captured);
      if (stale()) return;
      // Sem track de áudio publicada não há o que trocar, e publicar uma agora
      // obrigaria cada espectador a assinar de novo.
      if (audioTrack && !this.publication?.audioMid) {
        audioTrack.stop();
        audioTrack = null;
        this.setError(
          'Esta transmissão começou sem áudio; o som da nova captura entra ao compartilhar de novo.',
        );
      }
      const next = new MediaStream(
        audioTrack ? [screenTrack, audioTrack] : [screenTrack],
      );
      const replaced = await this.queue.run(async () => {
        if (stale()) return false;
        for (const tx of this.sendTransceivers) {
          const kind = tx.sender.track?.kind ?? tx.receiver.track.kind;
          await tx.sender.replaceTrack(
            next.getTracks().find(track => track.kind === kind) ?? null,
          );
        }
        return true;
      });
      if (!replaced || stale()) return;
      screenTrack.contentHint = 'motion';
      screenTrack.onended = () => this.stopSharing(true);
      for (const track of [...previous.getTracks(), ...captured.getTracks()]) {
        if (next.getTracks().includes(track)) continue;
        track.onended = null;
        track.stop();
      }
      captured = null;
      audioTrack = null;
      this.localStream = next;
      this.update({
        localStream: next,
        audioLive: next.getAudioTracks().length > 0,
      });
      setAudioSending(this.state.audioLive && !this.state.audioMuted);
      this.startCaptureInfo(next);
      await this.applyEncodeParameters();
    } catch (error) {
      if (this.isCurrent(seq))
        this.setError(
          error instanceof Error
            ? `Não foi possível trocar a tela: ${error.message}`
            : 'Não foi possível trocar a tela.',
        );
    } finally {
      audioTrack?.stop();
      captured?.getTracks().forEach(track => track.stop());
      if (this.isCurrent(seq)) this.update({ switching: false });
    }
  }

  private async publish(seq: number, captured: MediaStream) {
    const pc = this.pc;
    if (!this.isCurrent(seq) || !pc || !this.ticket) return;
    const videoTrack = captured.getVideoTracks()[0]!;
    const audioTrack = captured.getAudioTracks()[0];
    const videoTx = pc.addTransceiver(videoTrack, { direction: 'sendonly' });
    setVideoCodecPreference(videoTx, this.state.codecPreference);
    const audioTx = audioTrack
      ? pc.addTransceiver(audioTrack, { direction: 'sendonly' })
      : undefined;

    // Sem munge de vídeo para o SFU: os hints x-google-*-bitrate são específicos de
    // browser-para-browser e o Cloudflare devolve uma answer que o Chrome não
    // consegue reconciliar ("Failed to set remote video description send parameters").
    // O teto de bitrate é aplicado depois via RTCRtpSender.setParameters(). Os
    // parâmetros de Opus são padrão (RFC 7587) e vão na própria offer, porque sem
    // stereo declarado o SFU responde mono e o perfil de música não muda nada.
    const offer = await pc.createOffer();
    const munged = this.opusMunge && Boolean(offer.sdp);
    if (offer.sdp && munged)
      offer.sdp = tuneOpus(offer.sdp, this.state.audioProfile);
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    if (!this.isCurrent(seq)) return;

    const videoName = crypto.randomUUID();
    const audioName = audioTx ? crypto.randomUUID() : null;
    const tracks: TrackRequest[] = [
      { location: 'local', mid: videoTx.mid!, trackName: videoName },
    ];
    if (audioTx && audioName)
      tracks.push({
        location: 'local',
        mid: audioTx.mid!,
        trackName: audioName,
      });

    const res = await realtimeTracksNew(this.ticket, {
      sessionDescription: { type: 'offer', sdp: pc.localDescription!.sdp },
      tracks,
    });
    if (!this.isCurrent(seq)) return;
    if (res.sessionDescription) {
      try {
        await pc.setRemoteDescription(res.sessionDescription);
      } catch (error) {
        // Mesmo risco do munge de vídeo: uma offer alterada pode voltar numa answer
        // que o Chrome não reconcilia. Nesse caso o estéreo é o que se perde, não a
        // transmissão — a sessão reconecta e republica sem o ajuste.
        if (!munged) throw error;
        this.opusMunge = false;
        throw new RealtimeError('unavailable', 0);
      }
    }

    this.publication = {
      videoName,
      videoMid: videoTx.mid!,
      audioName,
      audioMid: audioTx?.mid ?? undefined,
    };
    this.sendTransceivers = audioTx ? [videoTx, audioTx] : [videoTx];
    await this.applyEncodeParameters();

    // Só anuncia depois que o PC está de pé e enviando: pull antes disso dá
    // "Track not found on remote peer" nos outros participantes.
    this.update({ localStream: captured, sharing: true });
    this.startCaptureInfo(captured);
    await waitForConnected(pc);
    if (!this.isCurrent(seq)) return;
    this.channel?.send({
      type: 'rt-publish',
      sessionId: this.cfSessionId!,
      video: videoName,
      audio: audioName,
    });
  }

  private startCaptureInfo(captured: MediaStream) {
    const screenTrack = captured.getVideoTracks()[0];
    if (!screenTrack) return;
    const tick = () => {
      const s = screenTrack.getSettings();
      this.update({
        captureInfo: `Captura real: ${s.width ?? '?'} × ${s.height ?? '?'} · ${s.frameRate ?? 'indisponível'} FPS · ${describeShareAudio(this.state.audioSource, this.state.audioLive, this.state.audioMuted)}`,
      });
    };
    tick();
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.settingsTimer = setInterval(tick, 2000);
  }

  private async applyEncodeParameters() {
    for (const tx of this.sendTransceivers) {
      const sender = tx.sender;
      const kind = sender.track?.kind;
      if (kind !== 'video' && kind !== 'audio') continue;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) continue;
      if (kind === 'audio') {
        for (const encoding of parameters.encodings) {
          encoding.active = this.state.audioLive && !this.state.audioMuted;
          encoding.maxBitrate =
            AUDIO_PROFILE_SETTINGS[this.state.audioProfile].maxAverageBitrate;
        }
      } else {
        parameters.degradationPreference = VIDEO_DEGRADATION_PREFERENCE;
        if (MAX_VIDEO_BITRATE)
          for (const encoding of parameters.encodings)
            encoding.maxBitrate = MAX_VIDEO_BITRATE;
      }
      try {
        await sender.setParameters(parameters);
      } catch {
        // Optional tuning; the stream continues without it.
      }
    }
  }

  stopSharing(notify = true) {
    const wasActive = this.state.sharing || this.capturing;
    this.wantsToShare = false;
    const publication = this.publication;
    const ticket = this.ticket;
    this.publication = null;
    this.teardownCapture();
    if (publication && ticket) {
      const mids = [
        publication.videoMid,
        ...(publication.audioMid ? [publication.audioMid] : []),
      ];
      void this.queue
        .run(() => realtimeTracksClose(ticket, mids))
        .catch(() => {});
    }
    for (const tx of this.sendTransceivers) {
      try {
        tx.stop();
      } catch {
        // already stopped
      }
    }
    this.sendTransceivers = [];
    if (notify && this.joined) {
      try {
        this.channel?.send({ type: 'rt-unpublish' });
      } catch {
        // Reconnection announces the change.
      }
    }
    if (notify && wasActive)
      this.update({ endedReason: 'me', endedPeerId: null });
  }

  private teardownCapture() {
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.settingsTimer = undefined;
    setAudioSending(false);
    this.localStream?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    this.localStream = null;
    this.capturing = false;
    this.update({
      sharing: false,
      capturing: false,
      switching: false,
      captureInfo: '',
      localStream: null,
      audioLive: false,
    });
  }

  // Publicação falhou mas queremos re-tentar no reconnect: para os timers e some
  // com o preview, mas mantém a MediaStream viva para resumeShare() re-publicar.
  private teardownCaptureKeepingIntent() {
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.settingsTimer = undefined;
    this.capturing = false;
    this.update({
      sharing: false,
      capturing: false,
      captureInfo: '',
      localStream: null,
    });
  }

  // ---- watching (auto-subscribe every share; no cap) ----

  watch(peerId: string) {
    const seq = this.sessionSeq;
    const sharing = this.members.some(
      member => member.peerId === peerId && member.rt,
    );
    if (!sharing && !this.hidden.has(peerId)) return;
    if (this.hidden.has(peerId)) {
      this.hidden.delete(peerId);
      playSound('viewer-join');
    } else {
      this.hidden.add(peerId);
      playSound('viewer-leave');
    }
    this.update({ endedReason: null, endedPeerId: null });
    this.reconcile(seq);
  }

  // ---- session lifecycle ----

  private readonly wakeReconnect = () => {
    if (this.disposed || navigator.onLine === false || this.accessTerminal)
      return;
    if (
      this.state.socketState === 'connected' ||
      this.state.socketState === 'connecting'
    )
      return;
    if (document.visibilityState === 'hidden') return;
    this.reconnectAttempts = 0;
    this.startSession();
  };

  private scheduleReconnect() {
    if (
      this.disposed ||
      this.reconnectTimer ||
      navigator.onLine === false ||
      this.accessTerminal
    )
      return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startSession();
    }, delay);
  }

  private teardown(leaving = false) {
    this.joined = false;
    this.ticket = null;
    this.cfSessionId = null;
    this.channel?.close(leaving);
    this.channel = null;
    this.pc?.close();
    this.pc = null;
    // Stale refs from the closed PC; publish() re-creates them on resume. wantsToShare
    // and localStream stay so a reconnect can re-publish the same capture.
    this.sendTransceivers = [];
    this.publication = null;
    this.subscriptions.clear();
    this.subscribeRetries.clear();
    this.midToPeer.clear();
    this.members = [];
    this.membersSeeded = false;
    this.knownWatcherIds = new Set();
  }

  private startSession() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.disposed) return;
    const seq = ++this.sessionSeq;
    this.teardown();

    if (navigator.onLine === false) {
      this.update({
        socketState: 'disconnected',
        selfId: '',
        members: [],
        selectedIds: [],
        remoteStreams: [],
        watcherIds: [],
        connectionState: 'aguardando',
        error:
          'Você está offline. A conexão será retomada quando a internet voltar.',
        joinError: '',
        accessError: '',
      });
      return;
    }

    this.update({
      socketState: 'connecting',
      selfId: '',
      members: [],
      selectedIds: [],
      remoteStreams: [],
      watcherIds: [],
      connectionState: 'aguardando',
      error: this.reconnectAttempts > 0 ? 'Reconectando à sala…' : '',
      joinError: '',
      accessError: '',
      endedReason: null,
      endedPeerId: null,
    });

    let wsQueue = Promise.resolve();
    this.channel = connectSignaling(
      this.roomId,
      this.credential,
      this.roomPassword,
      this.roomAccessToken,
      this.clientId,
      message => {
        wsQueue = wsQueue
          .then(() => this.receive(seq, message))
          .catch(() => {});
      },
      (socketState, close) => this.onSocketState(seq, socketState, close),
    );
  }

  private onSocketState(
    seq: number,
    socketState: string,
    close?: SignalingClose,
  ) {
    if (!this.isCurrent(seq)) return;
    // "connected" for the UI means the Cloudflare session is up, not just the WS —
    // establishSession() flips socketState once the PC is ready.
    if (socketState === 'connected') return;
    if (close && this.joined) reportSignalingDrop(close);
    this.update({ socketState });
    this.joined = false;
    this.pc?.close();
    this.pc = null;
    this.subscriptions.clear();
    this.subscribeRetries.clear();
    this.midToPeer.clear();
    this.update({
      selfId: '',
      selectedIds: [],
      members: [],
      remoteStreams: [],
      watcherIds: [],
    });
    if (this.disposed || this.accessTerminal) return;
    this.setError(
      socketState === 'restarting'
        ? 'Nova versão publicada. Reconectando à sala…'
        : 'Conexão perdida. Reconectando à sala…',
    );
    this.scheduleReconnect();
  }

  private async receive(seq: number, message: ServerMessage) {
    if (!this.isCurrent(seq)) return;
    switch (message.type) {
      case 'joined':
        this.reconnectAttempts = 0;
        this.roomAccessToken = message.accessToken ?? undefined;
        rememberRoomAccess({
          roomId: message.roomId,
          roomName: message.roomName,
          credential: this.credential,
          ...(message.accessToken ? { accessToken: message.accessToken } : {}),
          ...(message.accessTokenExpiresAt
            ? { accessTokenExpiresAt: message.accessTokenExpiresAt }
            : {}),
        });
        this.update({
          selfId: message.peerId,
          roomName: message.roomName,
          passwordProtected: message.passwordProtected,
          accessToken: message.accessToken ?? undefined,
          accessTokenExpiresAt: message.accessTokenExpiresAt ?? undefined,
          accessError: '',
          error: '',
        });
        this.updateMembers(seq, message.peers);
        await this.queue.run(() => this.establishSession(seq));
        if (this.state.alias) {
          try {
            this.channel?.send({ type: 'set-alias', alias: this.state.alias });
          } catch {
            // resent on reconnect
          }
        }
        await this.resumeShare(seq);
        this.reconcile(seq);
        break;
      case 'room-access-denied':
        this.accessTerminal =
          message.reason === 'too-many-attempts' ||
          message.reason === 'invalid-invite';
        this.update({ accessError: message.reason });
        break;
      case 'room-state':
        this.updateMembers(seq, message.peers);
        this.reconcile(seq);
        break;
      case 'error':
        this.update(
          this.joined
            ? { error: message.message }
            : { joinError: message.message },
        );
        break;
      default:
        break;
    }
  }

  private async establishSession(seq: number) {
    if (!this.isCurrent(seq)) return;
    // Igual ao fluxo de referência da Cloudflare: a sessão é criada sem offer e a
    // primeira operação de track (publish ou subscribe) estabelece o PC. Sem
    // placeholder de transceiver e sem munge de SDP — o SFU é exigente com a answer.
    const pc = new RTCPeerConnection({
      bundlePolicy: 'max-bundle',
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        ...(rtcConfiguration.iceServers ?? []),
      ],
    });
    this.pc = pc;
    pc.ontrack = event => this.onTrack(seq, event);
    pc.onconnectionstatechange = () => {
      if (!this.isCurrent(seq)) return;
      this.renderConnectionState();
      if (pc.connectionState === 'failed') {
        this.setError('Conexão de mídia perdida. Reconectando…');
        this.scheduleReconnect();
      }
    };

    try {
      const session = await createRealtimeSession({
        roomId: this.roomId,
        credential: this.credential,
        password: this.roomPassword,
        accessToken: this.roomAccessToken,
      });
      if (!this.isCurrent(seq)) {
        pc.close();
        return;
      }
      this.ticket = session.ticket;
      this.cfSessionId = session.sessionId;
      this.joined = true;
      this.reconnectAttempts = 0;
      this.update({ socketState: 'connected', error: '' });
      this.renderConnectionState();
    } catch (error) {
      if (!this.isCurrent(seq)) return;
      this.handleAccessError(error);
    }
  }

  // Erros de operações de track: convite/senha inválidos são terminais; qualquer
  // outra coisa (sessão coletada pelo SFU, falha de rede, SDP recusada) → recria a
  // sessão do zero. O backoff exponencial limita o retry.
  private handleTrackError(seq: number, error: unknown) {
    if (!this.isCurrent(seq)) return;
    if (
      error instanceof RealtimeError &&
      (error.reason === 'invalid-invite' ||
        error.reason === 'password-required' ||
        error.reason === 'wrong-password' ||
        error.reason === 'too-many-attempts')
    ) {
      this.handleAccessError(error);
      return;
    }
    this.ticket = null;
    this.cfSessionId = null;
    this.setError('Reconectando à mídia…');
    this.scheduleReconnect();
  }

  private handleAccessError(error: unknown) {
    if (
      error instanceof RealtimeError &&
      (error.reason === 'invalid-invite' ||
        error.reason === 'password-required' ||
        error.reason === 'wrong-password' ||
        error.reason === 'too-many-attempts')
    ) {
      this.accessTerminal =
        error.reason === 'invalid-invite' ||
        error.reason === 'too-many-attempts';
      this.update({ accessError: error.reason });
      return;
    }
    this.update({ socketState: 'disconnected' });
    this.setError('Servidor de mídia indisponível. Tentando novamente…');
    this.scheduleReconnect();
  }

  private async resumeShare(seq: number) {
    const track = this.localStream?.getVideoTracks()[0];
    if (
      !this.wantsToShare ||
      !this.localStream ||
      track?.readyState !== 'live'
    ) {
      if (this.wantsToShare) this.teardownCapture();
      this.wantsToShare = false;
      return;
    }
    try {
      await this.queue.run(() => this.publish(seq, this.localStream!));
    } catch (error) {
      if (error instanceof RealtimeError) this.handleTrackError(seq, error);
      else this.teardownCapture();
    }
  }

  // ---- subscriptions ----

  private reconcile(seq: number) {
    if (!this.isCurrent(seq) || !this.joined) return;
    const sharers = this.members.filter(
      m => m.rt && m.peerId !== this.state.selfId,
    );
    const visible = sharers.filter(m => !this.hidden.has(m.peerId));

    for (const peerId of Array.from(this.subscriptions.keys())) {
      const still = visible.find(m => m.peerId === peerId);
      if (
        !still ||
        this.subscriptions.get(peerId)!.publisherSessionId !==
          still.rt!.sessionId
      ) {
        this.unsubscribe(peerId);
      }
    }
    for (const member of visible) {
      if (!this.subscriptions.has(member.peerId)) {
        void this.queue
          .run(() => this.subscribeTo(seq, member))
          .catch(error => this.handleTrackError(seq, error));
      }
    }

    const previous = this.state.selectedIds;
    const selectedIds = visible.map(m => m.peerId);
    const droppedWatched = previous.find(
      id => !sharers.some(m => m.peerId === id) && !this.hidden.has(id),
    );
    this.update({
      selectedIds,
      endedReason:
        droppedWatched && selectedIds.length === 0
          ? 'remote'
          : this.state.endedReason,
      endedPeerId:
        droppedWatched && selectedIds.length === 0
          ? droppedWatched
          : this.state.endedPeerId,
    });
    this.renderConnectionState();
  }

  private async subscribeTo(seq: number, member: Participant) {
    const pc = this.pc;
    if (
      !this.isCurrent(seq) ||
      !pc ||
      !this.ticket ||
      !member.rt ||
      this.subscriptions.has(member.peerId)
    )
      return;
    const tracks: TrackRequest[] = [
      {
        location: 'remote',
        sessionId: member.rt.sessionId,
        trackName: member.rt.video,
      },
    ];
    if (member.rt.audio)
      tracks.push({
        location: 'remote',
        sessionId: member.rt.sessionId,
        trackName: member.rt.audio,
      });

    const res = await realtimeTracksNew(this.ticket, { tracks });
    if (!this.isCurrent(seq)) return;

    // O publicador ainda não está enviando pacotes (corrida no anúncio); tenta de
    // novo daqui a pouco, até um limite.
    if (
      !res.sessionDescription ||
      (res.tracks ?? []).some(t => t.errorCode || !t.mid)
    ) {
      const attempts = (this.subscribeRetries.get(member.peerId) ?? 0) + 1;
      this.subscribeRetries.set(member.peerId, attempts);
      if (attempts <= 8) setTimeout(() => this.reconcile(seq), 1200);
      return;
    }
    this.subscribeRetries.delete(member.peerId);

    const stream = new MediaStream();
    const sub: Subscription = {
      videoMid: '',
      stream,
      publisherSessionId: member.rt.sessionId,
    };
    const mids: string[] = [];
    for (const t of res.tracks ?? []) {
      if (!t.mid) continue;
      mids.push(t.mid);
      const kind = t.trackName === member.rt.audio ? 'audio' : 'video';
      this.midToPeer.set(t.mid, { peerId: member.peerId, kind });
      if (kind === 'video') sub.videoMid = t.mid;
      else sub.audioMid = t.mid;
    }
    this.subscriptions.set(member.peerId, sub);

    try {
      if (res.sessionDescription) {
        await pc.setRemoteDescription(res.sessionDescription);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await realtimeRenegotiate(this.ticket, {
          type: 'answer',
          sdp: pc.localDescription!.sdp,
        });
      }
    } catch (error) {
      // Deixa o estado consistente para o próximo reconcile poder tentar de novo.
      this.subscriptions.delete(member.peerId);
      for (const mid of mids) this.midToPeer.delete(mid);
      throw error;
    }
    this.rebuildRemoteStreams();
  }

  private unsubscribe(peerId: string) {
    const sub = this.subscriptions.get(peerId);
    if (!sub) return;
    this.subscriptions.delete(peerId);
    const mids = [sub.videoMid, ...(sub.audioMid ? [sub.audioMid] : [])].filter(
      Boolean,
    );
    for (const mid of mids) this.midToPeer.delete(mid);
    sub.stream.getTracks().forEach(track => track.stop());
    const ticket = this.ticket;
    if (ticket && mids.length)
      void this.queue
        .run(() => realtimeTracksClose(ticket, mids))
        .catch(() => {});
    this.rebuildRemoteStreams();
  }

  private onTrack(seq: number, event: RTCTrackEvent) {
    if (!this.isCurrent(seq)) return;
    const mid = event.transceiver.mid;
    const info = mid ? this.midToPeer.get(mid) : undefined;
    if (!info) return;
    const sub = this.subscriptions.get(info.peerId);
    if (!sub) return;
    if (!sub.stream.getTracks().includes(event.track))
      sub.stream.addTrack(event.track);
    this.rebuildRemoteStreams();
  }

  private rebuildRemoteStreams() {
    const remoteStreams: RemoteStream[] = [];
    for (const [peerId, sub] of this.subscriptions) {
      if (sub.stream.getVideoTracks().length) {
        remoteStreams.push({
          peerId,
          sessionId: sub.publisherSessionId,
          stream: sub.stream,
        });
      }
    }
    this.update({ remoteStreams });
    this.renderConnectionState();
  }

  private renderConnectionState() {
    const selected = this.state.selectedIds.length;
    const connected = this.state.remoteStreams.length;
    const failed = this.pc?.connectionState === 'failed';
    const connectionState = failed
      ? 'failed'
      : selected === 0
        ? 'aguardando'
        : `${connected}/${selected} conectada${selected > 1 ? 's' : ''}`;
    const selfId = this.state.selfId;
    const watcherIds = this.state.sharing
      ? this.members.filter(m => m.peerId !== selfId).map(m => m.peerId)
      : [];
    for (const id of watcherIds)
      if (!this.knownWatcherIds.has(id)) playSound('viewer-join');
    for (const id of this.knownWatcherIds)
      if (!watcherIds.includes(id)) playSound('viewer-leave');
    this.knownWatcherIds = new Set(watcherIds);
    this.update({ connectionState, watcherIds });
  }

  private updateMembers(seq: number, next: Participant[]) {
    if (!this.isCurrent(seq)) return;
    const previous = this.members;
    const selfId = this.state.selfId;
    if (this.membersSeeded) {
      for (const member of next) {
        const before = previous.find(p => p.peerId === member.peerId);
        if (!before && member.peerId !== selfId) playSound('connect');
        if (before && !before.rt && member.rt && member.peerId !== selfId)
          playSound('share-start');
        if (before && before.rt && !member.rt && member.peerId !== selfId)
          playSound('share-stop');
      }
      for (const member of previous) {
        if (
          member.peerId !== selfId &&
          !next.some(p => p.peerId === member.peerId)
        )
          playSound('disconnect');
      }
    }
    this.membersSeeded = true;
    for (const id of Array.from(this.hidden))
      if (!next.some(m => m.peerId === id)) this.hidden.delete(id);
    for (const id of Array.from(this.subscribeRetries.keys()))
      if (!next.some(m => m.peerId === id)) this.subscribeRetries.delete(id);
    this.members = next;
    this.update({ members: next });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.sessionSeq++;
    document.removeEventListener('visibilitychange', this.wakeReconnect);
    window.removeEventListener('online', this.wakeReconnect);
    window.removeEventListener('pageshow', this.wakeReconnect);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.teardownCapture();
    this.teardown(true);
    this.listeners.clear();
  }
}
