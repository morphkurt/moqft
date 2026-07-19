# moqft — secure file transfer over MoQ

AirDrop-style file transfer in the browser, using [Media over QUIC](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) with **Cloudflare's public MoQ relay network** as the rendezvous/transport. End-to-end encrypted: the relay only ever sees ciphertext and a random-looking namespace.

## How it works

1. **Sender** drops a file. The app generates a random 128-bit secret, shown as a base32 transfer code (and QR / share link).
2. From that secret, HKDF-SHA256 derives two independent values:
   - a **path id** → the MoQ namespace `moqft/<pathId>` announced on the relay (public, reveals nothing about the secret),
   - a **data key** → AES-256-GCM key (never leaves the two browsers).
3. The sender announces the namespace (`PUBLISH_NAMESPACE`) and waits.
4. The **receiver** enters the code, derives the same values, and subscribes to track `file`. The relay forwards the subscription upstream.
5. The sender streams the file as MoQ objects: object 0 is encrypted metadata (name/size/type/chunk count), objects 1..N are encrypted 64 KiB chunks. Each object is sealed with a counter nonce bound to its sequence number, so a malicious relay can't reorder, replay, or tamper without detection (GCM auth failure).
6. The receiver decrypts, reassembles, verifies the size, and saves the file.

## Protocol notes (hard-won)

- Cloudflare's production relay (`https://relay.cloudflare.mediaoverquic.com`) speaks **moq-transport draft-16**, not draft-07 as some docs still say. Version negotiation is via the `moqt-16` WebTransport subprotocol; `CLIENT_SETUP`/`SERVER_SETUP` carry parameters only.
- Client library: [moqtail](https://github.com/moqtail/moqtail) `0.12.1` (the npm release speaks `moqt-16`; the repo main branch has moved to `moqt-18`).
- The publisher **must advertise `MAX_REQUEST_ID`** in setup parameters, otherwise the relay silently refuses to forward subscriptions upstream (you'll see `REQUESTS_BLOCKED`) and answers subscribers with an immediate `PUBLISH_DONE`.
- moqtail's `LiveTrackSource` does not await deliveries and cancels the publication when the source closes, so the sender confirms each object hit the wire (`publication.latestLocation`) before pushing the next / closing — this also gives natural backpressure.

## Develop

```sh
npm install
npm run dev        # local app at http://localhost:5173
npm run build      # typecheck + production build
npm run e2e        # real end-to-end transfer through the CF relay in headless Chromium
                   # (optional args: relay-url, size-in-KiB)
```

Requires a WebTransport-capable browser (Chrome/Edge; Safari support is still experimental).

## Security model

- The transfer code is the only secret; treat it like a one-time password. 26 base32 chars ≈ 128 bits of entropy — not guessable, and the namespace is unlinkable to it without HKDF preimage.
- The relay (and anyone watching it) learns only: someone announced a random namespace, ~how many bytes moved, and when.
- A wrong code cannot decrypt (subscribe simply finds nothing, or GCM rejects).
- One transfer per code; codes are single-use by construction (fresh random secret per send).

## Performance

The sender keeps a window of 16 × 256 KiB chunks in flight (confirmed via the publication's `latestLocation`), so encryption, queueing, and QUIC transmission overlap and the receiver finishes ~60 ms after the sender. Measured ~5.3 MiB/s sustained through the relay on a residential connection with both peers on one machine — at that point the sender's uplink (or the relay's per-stream flow control), not the app, is the ceiling. `npm run e2e "" 50000` prints throughput for your own link.

## Limitations / next steps

- Received files are assembled in memory — fine up to a few hundred MB; use the File System Access API for streaming writes to go beyond.
- One receiver per announced transfer (first subscriber wins).
- Safari needs WebTransport behind a flag.
