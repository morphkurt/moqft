// moqft transfer protocol over MoQ Transport draft-16 (moqtail client).
//
// Wire layout — namespace "moqft/<pathId>":
//
//   Track "meta"   (sender → receiver)
//     Object 0        : AES-GCM(FileMetadata JSON)   domain=Meta seq=0
//     Objects 1..M    : AES-GCM(TransferManifest JSON) domain=Meta seq=1..M
//                       published after each chunk window flush
//
//   Track "file"   (sender → receiver)
//     Objects 1..N    : AES-GCM(file chunk i-1)       domain=File seq=1..N
//
//   Track "repair" (sender → receiver)
//     Objects 0..     : [4-byte chunkSeq BE] + AES-GCM(chunk) domain=File seq=chunkSeq
//                       published when the sender receives a NACK
//
// Namespace "moqft-nack/<pathId>":
//
//   Track "nack"   (receiver → sender)
//     Objects 0..     : AES-GCM(NackMessage JSON)     domain=Nack seq=0..
//                       published on reconnect with the list of missing chunks
//
// Reconnect flow:
//   1. Receiver tracks received chunk seqs in a Map across sessions.
//   2. On disconnect the outer receive() loop retries with back-off.
//   3. On reconnect the receiver publishes a NACK with missing chunk seqs
//      and re-subscribes to "file" using FilterType.AbsoluteStart at the
//      first sequential gap, and to "repair" using LatestObject.
//   4. The sender (still connected) receives the NACK subscription,
//      reads the missing list and retransmits those chunks to "repair".

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
import { TrackDomain, type TransferKeys, decryptObject, encryptObject } from "./crypto"

export const DEFAULT_RELAY = "https://relay.cloudflare.mediaoverquic.com"

const CHUNK_SIZE = 256 * 1024
const WINDOW = 16
const MAX_RECONNECT_ATTEMPTS = 5

export interface FileMetadata {
	name: string
	size: number
	type: string
	chunkSize: number
	totalChunks: number
}

export interface TransferManifest {
	sentUpTo: number
	totalChunks: number
}

export interface NackMessage {
	missing: number[]
}

export interface Progress {
	sentOrReceived: number
	total: number
}

// --- Track name helpers ---

function mainNs(keys: TransferKeys) { return `moqft/${keys.pathId}` }
function nackNs(keys: TransferKeys) { return `moqft-nack/${keys.pathId}` }

function metaFTN(keys: TransferKeys)   { return FullTrackName.tryNew(mainNs(keys), "meta") }
function fileFTN(keys: TransferKeys)   { return FullTrackName.tryNew(mainNs(keys), "file") }
function repairFTN(keys: TransferKeys) { return FullTrackName.tryNew(mainNs(keys), "repair") }
function nackFTN(keys: TransferKeys)   { return FullTrackName.tryNew(nackNs(keys), "nack") }

function obj(ftn: FullTrackName, seq: number, payload: Uint8Array): MoqtObject {
	return MoqtObject.newWithPayload(ftn, new Location(0n, BigInt(seq)), 0, ObjectForwardingPreference.Subgroup, 0n, null, payload)
}

// --- Sender ---

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
		const mFTN = metaFTN(keys)
		const fFTN = fileFTN(keys)
		const rFTN = repairFTN(keys)
		const nFTN = nackFTN(keys)

		let onSubscribed!: () => void
		const subscribed = new Promise<void>((resolve) => (onSubscribed = resolve))
		let onTerminated!: (reason?: unknown) => void
		const done = new Promise<never>((_, reject) => {
			onTerminated = (reason) => reject(new Error(`session terminated: ${reason ?? "connection closed"}`))
		})

		const client = await MOQtailClient.new({
			url: relay,
			setupParameters: new SetupParameters().addMaxRequestId(1024),
			callbacks: {
				onMessageReceived: (msg) => {
					if (msg instanceof Subscribe && msg.fullTrackName.toString() === fFTN.toString()) onSubscribed()
				},
				onSessionTerminated: onTerminated,
			},
		})
		this.#client = client

		let metaCtrl!:   ReadableStreamDefaultController<MoqtObject>
		let fileCtrl!:   ReadableStreamDefaultController<MoqtObject>
		let repairCtrl!: ReadableStreamDefaultController<MoqtObject>

		const metaStream   = new ReadableStream<MoqtObject>({ start: (c) => (metaCtrl   = c) })
		const fileStream   = new ReadableStream<MoqtObject>({ start: (c) => (fileCtrl   = c) })
		const repairStream = new ReadableStream<MoqtObject>({ start: (c) => (repairCtrl = c) })

		client.addOrUpdateTrack({ fullTrackName: mFTN, trackSource: { live: new LiveTrackSource(metaStream) },   publisherPriority: 0 })
		client.addOrUpdateTrack({ fullTrackName: fFTN, trackSource: { live: new LiveTrackSource(fileStream) },   publisherPriority: 0 })
		client.addOrUpdateTrack({ fullTrackName: rFTN, trackSource: { live: new LiveTrackSource(repairStream) }, publisherPriority: 0 })

		onStatus("announcing")
		const announced = await client.publishNamespace(Tuple.fromUtf8Path(mainNs(keys)))
		if (announced instanceof RequestError) {
			throw new Error(`relay refused namespace: ${announced.reasonPhrase.phrase}`)
		}

		// Listen for NACKs from receiver and retransmit to repair track in background.
		void this.#handleNacks(client, nFTN, rFTN, keys, file, repairCtrl)

		onStatus("waiting for receiver")
		await Promise.race([subscribed, done])
		if (this.#stopped) return

		while (client.publications.size === 0) await new Promise((r) => setTimeout(r, 20))
		const publication = [...client.publications.values()][0] as { latestLocation?: Location }

		onStatus("sending")
		const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
		const metadata: FileMetadata = { name: file.name, size: file.size, type: file.type, chunkSize: CHUNK_SIZE, totalChunks }

		let manifestSeq = 0

		const publishManifest = async (sentUpTo: number) => {
			manifestSeq++
			const payload = await encryptObject(keys, TrackDomain.Meta, manifestSeq, new TextEncoder().encode(JSON.stringify({ sentUpTo, totalChunks } satisfies TransferManifest)))
			metaCtrl.enqueue(obj(mFTN, manifestSeq, payload))
		}

		const flushed = async (seq: number) => {
			while (!this.#stopped && (publication.latestLocation?.object ?? -1n) < BigInt(seq)) {
				await new Promise((r) => setTimeout(r, 5))
				const confirmed = Number(publication.latestLocation?.object ?? 0n)
				onProgress({ sentOrReceived: Math.min(file.size, confirmed * CHUNK_SIZE), total: file.size })
			}
		}

		// Object 0 on meta track = file metadata.
		const metaPayload = await encryptObject(keys, TrackDomain.Meta, 0, new TextEncoder().encode(JSON.stringify(metadata)))
		metaCtrl.enqueue(obj(mFTN, 0, metaPayload))

		const push = async (seq: number, chunk: Uint8Array) => {
			if (this.#stopped) throw new Error("cancelled")
			fileCtrl.enqueue(obj(fFTN, seq, await encryptObject(keys, TrackDomain.File, seq, chunk)))
			await flushed(seq - WINDOW)
			await publishManifest(seq)
		}

		const sendAll = async () => {
			for (let i = 0; i < totalChunks; i++) {
				const blob = file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE))
				await push(i + 1, new Uint8Array(await blob.arrayBuffer()))
			}
			await flushed(totalChunks)
			onProgress({ sentOrReceived: file.size, total: file.size })
			fileCtrl.close()
			metaCtrl.close()
		}

		await Promise.race([sendAll(), done])
		onStatus("sent")
	}

	// Subscribe to the receiver's NACK track. For each NACK, re-encrypt the
	// requested chunks and publish them to the repair track.
	async #handleNacks(
		client: MOQtailClient,
		nFTN: FullTrackName,
		rFTN: FullTrackName,
		keys: TransferKeys,
		file: File,
		repairCtrl: ReadableStreamDefaultController<MoqtObject>,
	): Promise<void> {
		const result = await client.subscribe({
			fullTrackName: nFTN,
			priority: 0,
			groupOrder: GroupOrder.Original,
			forward: true,
			filterType: FilterType.LatestObject,
		}).catch(() => null)
		if (!result || result instanceof RequestError) return

		let repairSeq = 0
		const reader = result.stream.getReader()
		try {
			for (;;) {
				const { value: nackObj, done } = await reader.read()
				if (done || this.#stopped) break
				if (!nackObj.payload) continue

				const seq = Number(nackObj.location.object)
				const plain = await decryptObject(keys, TrackDomain.Nack, seq, nackObj.payload)
				const { missing } = JSON.parse(new TextDecoder().decode(plain)) as NackMessage

				for (const chunkSeq of missing) {
					if (this.#stopped) break
					const start = (chunkSeq - 1) * CHUNK_SIZE
					const end   = Math.min(file.size, chunkSeq * CHUNK_SIZE)
					const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer())
					const encrypted = await encryptObject(keys, TrackDomain.File, chunkSeq, chunk)

					// Repair payload: 4-byte BE original chunkSeq + encrypted chunk.
					const payload = new Uint8Array(4 + encrypted.length)
					new DataView(payload.buffer).setUint32(0, chunkSeq)
					payload.set(encrypted, 4)

					repairCtrl.enqueue(obj(rFTN, repairSeq++, payload))
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async stop() {
		this.#stopped = true
		await this.#client?.disconnect().catch(() => {})
	}
}

// --- Receiver ---

interface ReceiveState {
	chunks: Map<number, Uint8Array>
	metadata?: FileMetadata
	manifest?: TransferManifest
}

export class Receiver {
	#client?: MOQtailClient
	#stopped = false

	async receive(
		relay: string,
		keys: TransferKeys,
		onStatus: (status: string) => void,
		onProgress: (p: Progress) => void,
	): Promise<{ metadata: FileMetadata; blob: Blob }> {
		const state: ReceiveState = { chunks: new Map() }

		for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
			if (this.#stopped) throw new Error("cancelled")
			if (attempt > 0) {
				const delay = Math.min(1000 * 2 ** (attempt - 1), 16_000)
				onStatus(`reconnecting in ${delay / 1000}s…`)
				await new Promise((r) => setTimeout(r, delay))
				onStatus("reconnecting…")
			}

			try {
				const complete = await this.#connect(relay, keys, state, onStatus, onProgress)
				if (complete) break
				if (attempt === MAX_RECONNECT_ATTEMPTS) throw new Error("transfer incomplete after max retries")
			} catch (e) {
				if (this.#stopped) throw e
				if (attempt === MAX_RECONNECT_ATTEMPTS) throw e
				// else loop to retry
			}
		}

		const { metadata, chunks } = state
		if (!metadata) throw new Error("no metadata received")

		const parts: Uint8Array<ArrayBuffer>[] = []
		for (let i = 1; i <= metadata.totalChunks; i++) {
			const chunk = chunks.get(i)
			if (!chunk) throw new Error(`missing chunk ${i} after transfer`)
			parts.push(chunk as Uint8Array<ArrayBuffer>)
		}
		const blob = new Blob(parts, { type: metadata.type || "application/octet-stream" })
		if (blob.size !== metadata.size) throw new Error("size mismatch after reassembly")
		return { metadata, blob }
	}

	// Single connection attempt. Returns true when all chunks received, false
	// when the session dropped before completion (caller will retry).
	async #connect(
		relay: string,
		keys: TransferKeys,
		state: ReceiveState,
		onStatus: (status: string) => void,
		onProgress: (p: Progress) => void,
	): Promise<boolean> {
		const client = await MOQtailClient.new({
			url: relay,
			setupParameters: new SetupParameters().addMaxRequestId(1024),
		})
		this.#client = client

		// Announce NACK namespace so sender can subscribe and receive retransmit
		// requests. Failures are non-fatal (NACK is best-effort).
		const nFTN = nackFTN(keys)
		let nackCtrl!: ReadableStreamDefaultController<MoqtObject>
		const nackStream = new ReadableStream<MoqtObject>({ start: (c) => (nackCtrl = c) })
		client.addOrUpdateTrack({ fullTrackName: nFTN, trackSource: { live: new LiveTrackSource(nackStream) }, publisherPriority: 0 })
		await client.publishNamespace(Tuple.fromUtf8Path(nackNs(keys))).catch(() => {})

		// Subscribe to meta (always LatestObject — we want the current manifest).
		onStatus("subscribing")
		const metaResult = await client.subscribe({
			fullTrackName: metaFTN(keys),
			priority: 0,
			groupOrder: GroupOrder.Original,
			forward: true,
			filterType: FilterType.LatestObject,
		})
		if (metaResult instanceof RequestError) {
			throw new Error(`subscribe failed: ${metaResult.reasonPhrase.phrase} (is the sender online?)`)
		}

		// Subscribe to file from the first chunk we haven't received yet.
		const nextSeq = this.#firstMissingSeq(state)
		const fileResult = await client.subscribe({
			fullTrackName: fileFTN(keys),
			priority: 0,
			groupOrder: GroupOrder.Original,
			forward: true,
			...(nextSeq > 1
				? { filterType: FilterType.AbsoluteStart, startLocation: new Location(0n, BigInt(nextSeq)) }
				: { filterType: FilterType.LatestObject }),
		})
		if (fileResult instanceof RequestError) {
			throw new Error(`file subscribe failed: ${fileResult.reasonPhrase.phrase}`)
		}

		// Subscribe to repair track (best-effort; may not exist yet).
		const repairResult = await client.subscribe({
			fullTrackName: repairFTN(keys),
			priority: 0,
			groupOrder: GroupOrder.Original,
			forward: true,
			filterType: FilterType.LatestObject,
		}).catch(() => null)

		// If we're reconnecting and have a manifest, tell the sender what's missing.
		if (state.manifest) {
			const missing = this.#missingChunks(state)
			if (missing.length > 0) {
				const nackSeq = 0
				const payload = await encryptObject(keys, TrackDomain.Nack, nackSeq, new TextEncoder().encode(JSON.stringify({ missing } satisfies NackMessage)))
				nackCtrl.enqueue(obj(nFTN, nackSeq, payload))
			}
		}

		// Run meta, file, and repair readers concurrently. They all share state.
		// resolveComplete fires as soon as all chunks are in hand; at that point
		// we bail out of the parallel readers and return true.
		let resolveComplete!: () => void
		let rejectComplete!:  (e: Error) => void
		const completion = new Promise<void>((res, rej) => { resolveComplete = res; rejectComplete = rej })

		let receivedBytes = [...state.chunks.values()].reduce((s, c) => s + c.byteLength, 0)

		const checkComplete = () => {
			if (state.metadata && state.chunks.size === state.metadata.totalChunks) resolveComplete()
		}

		const readMeta = async () => {
			const reader = metaResult.stream.getReader()
			try {
				for (;;) {
					const { value: mo, done } = await reader.read()
					if (done) return
					if (!mo.payload) continue
					const seq = Number(mo.location.object)
					const plain = await decryptObject(keys, TrackDomain.Meta, seq, mo.payload)
					if (seq === 0) {
						state.metadata = JSON.parse(new TextDecoder().decode(plain)) as FileMetadata
						onStatus(`receiving ${state.metadata.name}`)
						checkComplete()
					} else {
						state.manifest = JSON.parse(new TextDecoder().decode(plain)) as TransferManifest
					}
				}
			} finally {
				reader.releaseLock()
			}
		}

		const readChunk = (seq: number, plain: Uint8Array) => {
			if (state.chunks.has(seq)) return
			state.chunks.set(seq, plain)
			receivedBytes += plain.byteLength
			if (state.metadata) onProgress({ sentOrReceived: receivedBytes, total: state.metadata.size })
			checkComplete()
		}

		const readFile = async () => {
			const reader = fileResult.stream.getReader()
			try {
				for (;;) {
					const { value: fo, done } = await reader.read()
					if (done) return
					if (!fo.payload) continue
					const seq = Number(fo.location.object)
					readChunk(seq, await decryptObject(keys, TrackDomain.File, seq, fo.payload))
				}
			} finally {
				reader.releaseLock()
			}
		}

		const readRepair = async () => {
			if (!repairResult || repairResult instanceof RequestError) return
			const reader = repairResult.stream.getReader()
			try {
				for (;;) {
					const { value: ro, done } = await reader.read()
					if (done) return
					if (!ro.payload) continue
					// Repair payload layout: [4-byte BE chunkSeq][encrypted chunk]
					const chunkSeq = new DataView(ro.payload.buffer, ro.payload.byteOffset).getUint32(0)
					const encrypted = ro.payload.slice(4)
					readChunk(chunkSeq, await decryptObject(keys, TrackDomain.File, chunkSeq, encrypted))
				}
			} finally {
				reader.releaseLock()
			}
		}

		const allStreamsClosed = Promise.all([readMeta(), readFile(), readRepair()])
			.catch((e) => rejectComplete(e as Error))

		try {
			await Promise.race([completion, allStreamsClosed])
			return state.metadata !== undefined && state.chunks.size === state.metadata.totalChunks
		} finally {
			await client.disconnect().catch(() => {})
		}
	}

	// Returns the lowest chunk seq (1-based) not yet in state.chunks, scanning
	// sequentially from 1. Used to set the AbsoluteStart position on reconnect.
	#firstMissingSeq(state: ReceiveState): number {
		if (!state.metadata) return 1
		let seq = 1
		while (state.chunks.has(seq)) seq++
		return seq
	}

	// Returns all chunk seqs the sender has confirmed sending (per manifest)
	// that the receiver does not yet have.
	#missingChunks(state: ReceiveState): number[] {
		if (!state.manifest) return []
		const missing: number[] = []
		for (let i = 1; i <= state.manifest.sentUpTo; i++) {
			if (!state.chunks.has(i)) missing.push(i)
		}
		return missing
	}

	async stop() {
		this.#stopped = true
		await this.#client?.disconnect().catch(() => {})
	}
}
