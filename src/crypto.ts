// End-to-end crypto for moqft.
//
// Trust model: the MoQ relay is untrusted. A single 128-bit secret (the
// "transfer code") is shared out-of-band (typed or scanned by the receiver).
// Everything else is derived from it via HKDF-SHA256 with distinct info
// strings:
//
//   path key  -> public rendezvous namespace on the relay (random-looking,
//                reveals nothing about the secret thanks to HKDF)
//   data key  -> AES-256-GCM key for the file contents
//
// Each MoQ object is encrypted independently with a counter nonce (object
// sequence number). The key is unique per transfer, so counter nonces never
// repeat under the same key. GCM authentication means a wrong code or a
// tampering relay yields a decrypt failure, not corrupt output.

const SALT = new TextEncoder().encode("moqft/v1")

// Crockford-style base32, no padding: unambiguous to read aloud or type.
const B32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export interface TransferKeys {
	// Hex namespace component the relay sees; safe to be public.
	pathId: string
	// AES-256-GCM key for file data; never leaves the client.
	dataKey: CryptoKey
}

export function generateCode(): string {
	const secret = crypto.getRandomValues(new Uint8Array(16))
	return encodeBase32(secret)
}

export async function deriveKeys(code: string): Promise<TransferKeys> {
	const secret = decodeBase32(normalizeCode(code))
	if (secret.length != 16) throw new Error("invalid code")

	const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits", "deriveKey"])

	const pathBits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode("path") },
		ikm,
		128,
	)

	const dataKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode("data") },
		ikm,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	)

	const pathId = [...new Uint8Array(pathBits)].map((b) => b.toString(16).padStart(2, "0")).join("")
	return { pathId, dataKey }
}

export async function encryptObject(keys: TransferKeys, seq: number, plaintext: Uint8Array): Promise<Uint8Array> {
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, keys.dataKey, plaintext as BufferSource)
	return new Uint8Array(ct)
}

export async function decryptObject(keys: TransferKeys, seq: number, ciphertext: Uint8Array): Promise<Uint8Array> {
	try {
		const pt = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce(seq) },
			keys.dataKey,
			ciphertext as BufferSource,
		)
		return new Uint8Array(pt)
	} catch {
		throw new Error("decryption failed: wrong code or corrupted data")
	}
}

// 96-bit big-endian counter nonce. Binding the object sequence number into
// the nonce also prevents the relay reordering or replaying chunks.
function nonce(seq: number): Uint8Array {
	const iv = new Uint8Array(12)
	new DataView(iv.buffer).setBigUint64(4, BigInt(seq))
	return iv
}

export function formatCode(code: string): string {
	return normalizeCode(code).replace(/(.{4})(?=.)/g, "$1-")
}

export function normalizeCode(code: string): string {
	return code.toLowerCase().replace(/[^0-9a-z]/g, "").replace(/o/g, "0").replace(/[il]/g, "1")
}

function encodeBase32(bytes: Uint8Array): string {
	let bits = 0
	let value = 0
	let out = ""
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
	return out
}

function decodeBase32(str: string): Uint8Array {
	let bits = 0
	let value = 0
	const out: number[] = []
	for (const ch of str) {
		const idx = B32_ALPHABET.indexOf(ch)
		if (idx < 0) throw new Error(`invalid code character: ${ch}`)
		value = (value << 5) | idx
		bits += 5
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff)
			bits -= 8
		}
	}
	return new Uint8Array(out)
}
