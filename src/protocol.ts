// moqft transfer protocol over MoQ Transport draft-16 (moqtail client).
//
// Cloudflare's production relay (relay.cloudflare.mediaoverquic.com) speaks
// draft-16: version negotiation via the "moqt-16" WebTransport subprotocol,
// PUBLISH_NAMESPACE instead of ANNOUNCE, and request-id based SUBSCRIBE.
//
// Wire layout: namespace "moqft/<pathId>" with a single track "file".
// The whole transfer is group 0 / subgroup 0, one object per encrypted record:
//
//   object 0   : AES-GCM(metadata JSON)  {name, size, type, chunkSize, totalChunks}
//   object 1..N: AES-GCM(file chunk i-1)
//
// The sender announces the namespace and waits; the relay forwards the
// receiver's SUBSCRIBE upstream, and the sender starts producing objects only
// once that subscription lands (moqtail serves registered tracks to inbound
// subscriptions automatically).

import {
	FilterType,
	FullTrackName,
	GroupOrder,
	LiveTrackSource,
	Location,
	MOQtailClient,
	MoqtObject,
	ObjectForwardingPreference,
	RequestError,
	SetupParameters,
	Subscribe,
	Tuple,
} from "moqtail"
import { type TransferKeys, decryptObject, encryptObject } from "./crypto"

export const DEFAULT_RELAY = "https://relay.cloudflare.mediaoverquic.com"

const TRACK_NAME = "file"
const CHUNK_SIZE = 256 * 1024
// How many chunks may be in flight (enqueued but not yet confirmed written to
// the relay) before the sender throttles. Window memory = WINDOW * CHUNK_SIZE.
const WINDOW = 16

export interface FileMetadata {
	name: string
	size: number
	type: string
	chunkSize: number
	totalChunks: number
}

export interface Progress {
	sentOrReceived: number
	total: number
}

function trackName(keys: TransferKeys): FullTrackName {
	return FullTrackName.tryNew(`moqft/${keys.pathId}`, TRACK_NAME)
}

export class Sender {
	#client?: MOQtailClient
	#stopped = false

	async send(
		relay: string,
		keys: TransferKeys,
		file: File,
		onStatus: (status: string) => void,
		onProgress: (p: Progress) => void,
	): Promise<void> {
		const ftn = trackName(keys)

		let onSubscribed!: () => void
		const subscribed = new Promise<void>((resolve) => (onSubscribed = resolve))
		let onTerminated!: (reason?: unknown) => void
		const done = new Promise<never>((_, reject) => {
			onTerminated = (reason) => reject(new Error(`session terminated: ${reason ?? "connection closed"}`))
		})

		const client = await MOQtailClient.new({
			url: relay,
			// Without MAX_REQUEST_ID the relay may not send us any requests, so
			// the receiver's SUBSCRIBE would never be forwarded upstream.
			setupParameters: new SetupParameters().addMaxRequestId(1024),
			callbacks: {
				onMessageReceived: (msg) => {
					if (msg instanceof Subscribe && msg.fullTrackName.toString() === ftn.toString()) onSubscribed()
				},
				onSessionTerminated: onTerminated,
			},
		})
		this.#client = client

		// The live source is a stream we push encrypted objects into once a
		// receiver subscribes.
		let controller!: ReadableStreamDefaultController<MoqtObject>
		const stream = new ReadableStream<MoqtObject>({ start: (c) => (controller = c) })
		client.addOrUpdateTrack({
			fullTrackName: ftn,
			trackSource: { live: new LiveTrackSource(stream) },
			publisherPriority: 0,
		})

		onStatus("announcing")
		const announced = await client.publishNamespace(Tuple.fromUtf8Path(`moqft/${keys.pathId}`))
		if (announced instanceof RequestError) {
			throw new Error(`relay refused namespace: ${announced.reasonPhrase.phrase}`)
		}

		onStatus("waiting for receiver")
		await Promise.race([subscribed, done])
		if (this.#stopped) return

		// onMessageReceived fires before moqtail's own handler registers the
		// publication, so wait until it is ready to forward objects.
		while (client.publications.size === 0) await new Promise((r) => setTimeout(r, 20))
		const publication = [...client.publications.values()][0] as { latestLocation?: Location }

		onStatus("sending")
		const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
		const metadata: FileMetadata = {
			name: file.name,
			size: file.size,
			type: file.type,
			chunkSize: CHUNK_SIZE,
			totalChunks,
		}

		const object = (seq: number, payload: Uint8Array) =>
			MoqtObject.newWithPayload(ftn, new Location(0n, BigInt(seq)), 0, ObjectForwardingPreference.Subgroup, 0n, null, payload)

		// moqtail's live-source ingest does not await deliveries, and closing
		// the source cancels the publication even with writes still queued.
		// latestLocation advances as objects actually hit the wire; use it to
		// cap the number of in-flight chunks and to know when it is safe to
		// close. Progress is also reported from it, so the bar tracks real
		// network progress rather than queueing.
		const flushed = async (seq: number) => {
			while (!this.#stopped && (publication.latestLocation?.object ?? -1n) < BigInt(seq)) {
				await new Promise((r) => setTimeout(r, 5))
				const confirmed = Number(publication.latestLocation?.object ?? 0n)
				onProgress({ sentOrReceived: Math.min(file.size, confirmed * CHUNK_SIZE), total: file.size })
			}
		}

		const push = async (seq: number, payload: Uint8Array) => {
			if (this.#stopped) throw new Error("cancelled")
			controller.enqueue(object(seq, await encryptObject(keys, seq, payload)))
			await flushed(seq - WINDOW)
		}

		const sendAll = async () => {
			await push(0, new TextEncoder().encode(JSON.stringify(metadata)))
			for (let i = 0; i < totalChunks; i++) {
				const blob = file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE))
				await push(i + 1, new Uint8Array(await blob.arrayBuffer()))
			}
			await flushed(totalChunks)
			onProgress({ sentOrReceived: file.size, total: file.size })
			controller.close()
		}

		await Promise.race([sendAll(), done])
		onStatus("sent")
	}

	async stop() {
		this.#stopped = true
		await this.#client?.disconnect().catch(() => {})
	}
}

export class Receiver {
	#client?: MOQtailClient

	async receive(
		relay: string,
		keys: TransferKeys,
		onStatus: (status: string) => void,
		onProgress: (p: Progress) => void,
		writable?: FileSystemWritableFileStream,
	): Promise<{ metadata: FileMetadata; blob?: Blob }> {
		const client = await MOQtailClient.new({
			url: relay,
			setupParameters: new SetupParameters().addMaxRequestId(1024),
		})
		this.#client = client

		onStatus("subscribing")
		const result = await client.subscribe({
			fullTrackName: trackName(keys),
			priority: 0,
			groupOrder: GroupOrder.Original,
			forward: true,
			filterType: FilterType.LatestObject,
		})
		if (result instanceof RequestError) {
			throw new Error(`subscribe failed: ${result.reasonPhrase.phrase} (is the sender online?)`)
		}

		onStatus("waiting for data")
		let metadata: FileMetadata | undefined
		const chunks = writable ? undefined : new Map<number, Uint8Array>()
		let receivedChunks = 0
		let receivedBytes = 0

		const reader = result.stream.getReader()
		try {
			for (;;) {
				const { value: obj, done } = await reader.read()
				if (done) throw new Error("transfer ended before all chunks arrived")
				if (!obj.payload) continue // status-only object

				const seq = Number(obj.location.object)
				const plain = await decryptObject(keys, seq, obj.payload)

				if (seq === 0) {
					metadata = JSON.parse(new TextDecoder().decode(plain)) as FileMetadata
					onStatus(`receiving ${metadata.name}`)
				} else {
					if (writable) {
						await writable.write(plain as Uint8Array<ArrayBuffer>)
					} else {
						chunks!.set(seq, plain)
					}
					receivedChunks++
					receivedBytes += plain.byteLength
					if (metadata) onProgress({ sentOrReceived: receivedBytes, total: metadata.size })
				}

				if (metadata && receivedChunks === metadata.totalChunks) {
					if (writable) {
						await writable.close()
						return { metadata }
					}
					const parts: Uint8Array<ArrayBuffer>[] = []
					for (let i = 1; i <= metadata.totalChunks; i++) {
						const part = chunks!.get(i)
						if (!part) throw new Error(`missing chunk ${i}`)
						parts.push(part as Uint8Array<ArrayBuffer>)
					}
					const blob = new Blob(parts, { type: metadata.type || "application/octet-stream" })
					if (blob.size !== metadata.size) throw new Error("size mismatch after reassembly")
					return { metadata, blob }
				}
			}
		} finally {
			reader.releaseLock()
			await client.disconnect().catch(() => {})
		}
	}

	async stop() {
		await this.#client?.disconnect().catch(() => {})
	}
}
