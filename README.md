# ReShare

Aplicação privada para até **dez participantes**. Cada pessoa pode transmitir a própria tela e assistir a **até duas transmissões remotas por vez**, inclusive enquanto transmite. A mídia segue diretamente entre navegadores por WebRTC; o servidor Bun entrega o frontend e transporta somente signaling por WebSocket.

## Stack e arquitetura

- Bun 1.4, React 19, TypeScript e CSS.
- A sala é composta por componentes React separados para navegação, participantes, palco e modais; o controlador de sessão mantém signaling, captura e ciclo de vida WebRTC fora da camada visual.
- Um único `Bun.serve()` atende `/`, `/room/:roomId`, `/health`, `/config.json` e o WebSocket `/signaling`.
- Zod valida todas as mensagens nos dois lados.
- Participantes conectados ficam em memória. O nome e a proteção da sala ficam em um convite assinado, dispensando banco de dados.
- Cada assinatura usa um `RTCPeerConnection` unidirecional. Um transmissor tem uma conexão de envio por espectador; cada participante mantém no máximo duas conexões de recebimento.

## Desenvolvimento local

Instale o [Bun](https://bun.com/docs/installation) e execute:

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Abra http://localhost:3000. O Bun recompila frontend e servidor durante o desenvolvimento. Para simular produção:

```bash
bun run build
bun run start
```

O processo deve iniciar a partir da raiz; o script `start` entra em `dist` para que o manifesto de assets gerado pelo HTML import seja resolvido corretamente.

## Uso

1. Informe um nome, escolha opcionalmente uma senha e clique em **Criar sala**. Nas salas protegidas, compartilhe o link e a senha separadamente.
2. Quem abrir um convite protegido informa a senha uma vez. Após a entrada, o navegador guarda um token de acesso por 30 dias; a senha em si nunca é salva pelo ReShare.
3. A sala criada é favoritada automaticamente. Outros participantes podem favoritá-la pelo botão da sala; os favoritos também aparecem como atalhos na barra lateral.
4. Ao entrar na sala, escolha em **Seu nome na sala** um apelido (até 32 caracteres) que substitui o nome padrão `Participante <id>` para todos. O valor fica salvo no navegador, é reenviado ao reconectar e pode ser alterado depois em **Configurações**.
5. Qualquer participante pode clicar em **Compartilhar tela** e escolher tela, janela ou aba. Marque áudio no seletor quando disponível.
6. Escolha uma pessoa que esteja transmitindo na barra lateral ou no seletor de telas. Trocar a seleção fecha a recepção anterior.
7. O preview local permanece sem som. O vídeo remoto não é silenciado; se o navegador bloquear autoplay com áudio, clique em **Reproduzir vídeo e áudio**.
8. O botão nativo de parar captura, **Parar compartilhamento** ou fechar a aba encerram tracks e conexões relacionadas.
9. Uma queda curta do signaling (rede, proxy) não interrompe nada: a mídia é P2P e continua, o servidor guarda o lugar de quem caiu por 20 s e a reconexão automática o retoma, sem saída e entrada na sala. Passado esse prazo, ou depois de um deploy, a sala é refeita do zero.

## Instalação como aplicativo

Em navegadores compatíveis, use a opção **Instalar ReShare** da barra de endereço ou do menu do navegador. A versão
instalada abre em uma janela própria e mantém a interface disponível depois da primeira visita. Salas, signaling e
transmissões continuam exigindo internet; quando a conexão volta, uma sala aberta tenta se reconectar automaticamente.

A captura solicita 2560 × 1440 a 60 FPS como valores ideais. A interface mostra largura, altura, FPS e presença de áudio realmente entregues por `getSettings()`. Áudio de sistema depende do navegador, sistema operacional e tipo de superfície selecionada.

## Testes

```bash
bun run typecheck
bun run lint
bun run format:check
bun run knip
bun test
bun run build
bunx playwright install --with-deps chromium
bun run test:e2e
```

`bun run lint` usa [oxlint](https://oxc.rs) com verificação type-aware via `tsgolint` (`oxlint --type-aware`); `bun run format` aplica o [oxfmt](https://oxc.rs) e `bun run format:check` valida. As configurações ficam em `.oxlintrc.json` e `.oxfmtrc.json`. `bun run knip` ([knip](https://knip.dev), config em `knip.json`) aponta arquivos, exports e dependências sem uso.

O teste unitário do signaling cobre lotação, isolamento, autorização de relay, duas seleções simultâneas, publicações simultâneas, apelidos de participantes, mensagens inválidas, taxa e backpressure. Os testes de peers cobrem ICE recebido antes do SDP, sessões antigas e cleanup independente. O Playwright usa WebRTC real com vídeo e áudio sintéticos em múltiplas abas.

Para duas máquinas, use o domínio HTTPS do Railway ou outro domínio com TLS válido. `getDisplayMedia()` exige contexto seguro; HTTP por IP da rede local não basta. Crie a sala no PC A, abra o mesmo convite no PC B e escolha a transmissão. Redes diferentes podem exigir TURN.

## Fluxo WebRTC

`create-room` gera um UUID e uma credencial assinada contendo o nome imutável e, quando configurado, um verificador protegido da senha. Em cada `join-room`, o servidor valida o convite e aceita uma senha ou um token de acesso assinado ainda válido. O token dura 30 dias e fica salvo no navegador; a senha não. Depois da validação, o servidor cria a representação em memória, gera um `peerId`, envia o snapshot e publica mudanças com `room-state`. Assim, o mesmo convite funciona depois que a sala fica vazia ou o servidor reinicia, desde que `ROOM_TOKEN_SECRET` não mude. `sharing-started` apenas anuncia disponibilidade; nenhuma mídia passa pelo servidor.

Ao selecionar um transmissor, o espectador envia `watch` com um `sessionId` novo e prepara uma conexão de recepção. Até duas assinaturas podem ficar ativas por espectador. O servidor confirma com `watching` e envia `subscriber-joined` ao transmissor. O transmissor cria uma conexão exclusiva para essa assinatura, adiciona as tracks, cria/aplica a offer e a envia. O espectador aplica a offer, cria/aplica a answer e devolve. ICE é enviado incrementalmente; candidatos que chegam antes de `remoteDescription` ficam em uma fila limitada e são aplicados depois do SDP.

O servidor só encaminha offer, answer e ICE quando remetente, destino, sala, direção e assinatura coincidem. Mensagens atrasadas são descartadas. Trocar ou encerrar uma assinatura fecha a conexão nos dois lados sem afetar outras transmissões.

## Bitrate, codecs e custo

`src/lib/webrtc/rtcConfiguration.ts` centraliza ICE e o teto `MAX_VIDEO_BITRATE`, cujo padrão é 15 Mbps **por espectador**. Após a answer, o transmissor altera `encodings[].maxBitrate` a partir de `RTCRtpSender.getParameters()`, define `degradationPreference` e chama `setParameters()`; a mesma rotina roda de novo quando as configurações mudam ao vivo. O valor é uma solicitação: navegador, congestionamento, CPU e captura podem entregar menos.

`MIN_VIDEO_BITRATE` (2,5 Mbps) e `START_VIDEO_BITRATE` (8 Mbps) são injetados na SDP de vídeo como `x-google-min-bitrate` / `x-google-start-bitrate` por `src/lib/webrtc/sdp.ts`, evitando que o bitrate desabe numa tela estática e suba lentamente quando o conteúdo volta a se mover. A track de captura usa `contentHint = 'motion'`. Só o Chrome/Edge respeitam as dicas `x-google-*`; `0` desativa cada uma.

Não dá para fixar resolução, FPS e bitrate ao mesmo tempo — sob carga um deles cede. As Configurações expõem essa escolha ("Sob carga, priorizar": fluidez / equilíbrio / nitidez → `maintain-framerate` / `balanced` / `maintain-resolution`, padrão fluidez) e a qualidade da captura (1080p·60 / 1440p·30 / 1440p·60, padrão 1080p·60). As duas ficam no `localStorage` e valem para o próximo compartilhamento; a preferência de degradação e a taxa de quadros também se aplicam a uma transmissão em andamento.

As Configurações permitem preferir Automático, VP8, VP9, H.264 ou AV1 no próximo compartilhamento. Opções não suportadas pelo navegador ficam desabilitadas. A preferência é aplicada antes de cada offer com `RTCRtpTransceiver.setCodecPreferences()` e mantém os demais codecs como fallback, portanto o codec efetivo ainda pode variar por espectador. **Debug WebRTC** exibe capacidades locais, estados de conexão e estatísticas de RTP a cada dois segundos somente enquanto a seção está aberta.

Em mesh, o custo de vídeo fica principalmente na máquina de quem transmite. Quatro espectadores podem exigir até cerca de 60 Mbps de upload mais áudio e overhead, além de múltiplos encoders. Railway recebe apenas mensagens pequenas de signaling e os arquivos do frontend.

## TURN

O STUN público configurado é adequado para desenvolvimento, mas não atravessa todas as combinações de NAT, CGNAT, firewall ou bloqueio de UDP. TURN passa a ser necessário para conectividade confiável entre redes diferentes porque retransmite mídia quando o caminho direto falha.

Configure fora do Git:

```dotenv
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

O servidor entrega essa configuração ao navegador em `/config.json`. Credenciais WebRTC são visíveis ao cliente; prefira credenciais TURN temporárias. Adicione também URLs TCP/TLS oferecidas pelo provedor para redes que bloqueiam UDP.

## Camada de mídia: WebRTC ou Cloudflare Realtime

A mídia tem dois provedores atrás de uma mesma interface (`src/client/media/`):

- **`webrtc`** (padrão): malha P2P como descrito acima. Uma `RTCPeerConnection` por
  assinatura, custo de envio na máquina de quem transmite, limite prático de
  participantes, TURN próprio.
- **`cloudflare`**: o SFU [Cloudflare Realtime](https://developers.cloudflare.com/realtime/)
  cuida de transporte, NAT e TURN no edge global. Cada navegador abre **uma**
  `RTCPeerConnection` contra a Cloudflare; a tela é enviada uma vez e o SFU
  distribui. Sem limite de participantes e sem o teto de duas lives — todas as telas
  aparecem automaticamente. O `server/signaling.ts` continua carregando presença e
  "quem publicou o quê" (`rt-publish` / `rt-unpublish`); o App Secret fica no
  servidor e o navegador só fala com o proxy `/realtime/*` da mesma origem.

O provedor é escolhido em tempo de execução por `/config.json`, controlado pela
variável `MEDIA_PROVIDER`. Trocar o valor e reiniciar troca o transporte de toda
sessão nova, sem novo build; o rollback é voltar a variável. Não há servidor para
hospedar — só um app Cloudflare Realtime (dashboard → Realtime → SFU) e as
variáveis `CLOUDFLARE_REALTIME_APP_ID` / `CLOUDFLARE_REALTIME_APP_SECRET`. Egress
custa US$0,05/GB com 1.000 GB/mês grátis. Testes do modo Cloudflare:
`bun run test:e2e:cloudflare` (exige as duas variáveis). Detalhes em
[`deploy/README.md`](deploy/README.md).

## Deploy na Railway

A infraestrutura está em `.railway/railway.ts` e usa um único serviço `web`, uma réplica, health check `/health`, build `bun run build` e start `bun run start`. Consulte [.railway/README.md](.railway/README.md) para o procedimento de migração e deploy pela CLI.

Defina `ROOM_TOKEN_SECRET` com pelo menos 32 caracteres aleatórios e preserve o valor entre deploys. Trocar ou perder esse segredo invalida todos os convites existentes. Em desenvolvimento, quando a variável não existe, é usado apenas um valor local fixo e inseguro.

## Limitações

- Sem contas ou recuperação administrativa: salas podem ser públicas ou protegidas; nome e eventual senha são imutáveis.
- Participantes, identidades e seleções online desaparecem ao reiniciar o processo; convite e nome da sala permanecem válidos.
- Favoritos pertencem somente ao perfil atual do navegador e desaparecem ao limpar os dados do site.
- Uma réplica; escalar exige estado compartilhado e afinidade ou outro desenho de signaling.
- Sem SFU, gravação, chat, microfone ou retomada automática de ICE.
- Cada participante assiste até duas transmissões por vez; isso aumenta o consumo de banda e processamento no receptor, e os áudios podem se sobrepor.
- Qualidade e áudio variam por navegador, dispositivo e rede.

## Referências oficiais

A implementação segue o fluxo descrito em [WebRTC.org](https://webrtc.org/?hl=pt-br) e na [MDN WebRTC API](https://developer.mozilla.org/pt-BR/docs/Web/API/WebRTC_API): `getDisplayMedia`, `addTrack`, offer/answer, descrições local/remota, trickle ICE, `ontrack`, `close`, `getParameters`/`setParameters`, `getCapabilities` e `getStats`. A fila ICE existe porque `addIceCandidate()` depende da descrição remota correspondente. O frontend e o build usam [HTML imports e fullstack server do Bun](https://bun.com/docs/bundler/fullstack), e o signaling usa [WebSockets nativos do Bun](https://bun.com/docs/runtime/http/websockets).
