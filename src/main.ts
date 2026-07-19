import QRCode from "qrcode"
import { deriveKeys, formatCode, generateCode, normalizeCode } from "./crypto"
import { DEFAULT_RELAY, Receiver, Sender, type Progress } from "./protocol"

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const relayInput = $<HTMLInputElement>("relay")
relayInput.value = DEFAULT_RELAY

// Tabs
const paneSend = $("pane-send")
const paneReceive = $("pane-receive")
const tabSend = $<HTMLButtonElement>("tab-send")
const tabReceive = $<HTMLButtonElement>("tab-receive")

function showTab(tab: "send" | "receive") {
	paneSend.hidden = tab !== "send"
	paneReceive.hidden = tab !== "receive"
	tabSend.classList.toggle("active", tab === "send")
	tabReceive.classList.toggle("active", tab === "receive")
}
tabSend.onclick = () => showTab("send")
tabReceive.onclick = () => showTab("receive")

// Parse URL fragment.
// #s:CODE  → receiver-first: sender opens page with a preset code
// #CODE    → legacy receiver link: pre-fill the code input
let presetSendCode: string | undefined
if (location.hash.startsWith("#s:")) {
	presetSendCode = location.hash.slice(3)
	showTab("send")
} else if (location.hash.length > 1) {
	$<HTMLInputElement>("code-input").value = location.hash.slice(1)
	showTab("receive")
}

// --- Send ---

const dropzone = $("dropzone")
const fileInput = $<HTMLInputElement>("file-input")
const sendStatus = $("send-status")
const sendProgress = $<HTMLProgressElement>("send-progress")

let sender: Sender | undefined

dropzone.onclick = () => fileInput.click()
dropzone.ondragover = (e) => {
	e.preventDefault()
	dropzone.classList.add("dragover")
}
dropzone.ondragleave = () => dropzone.classList.remove("dragover")
dropzone.ondrop = (e) => {
	e.preventDefault()
	dropzone.classList.remove("dragover")
	const file = e.dataTransfer?.files[0]
	if (file) void startSend(file)
}
fileInput.onchange = () => {
	const file = fileInput.files?.[0]
	if (file) void startSend(file)
}

async function startSend(file: File) {
	sender?.stop()

	// Receiver-first: use the code they generated; otherwise generate our own.
	const code = presetSendCode ? normalizeCode(presetSendCode) : generateCode()
	const keys = await deriveKeys(code)

	dropzone.hidden = true
	$("send-session").hidden = false

	if (!presetSendCode) {
		// Sender-first: show code and QR for the receiver to scan/enter.
		$("send-session-share").hidden = false
		const codeEl = $("code")
		codeEl.textContent = formatCode(code)
		codeEl.onclick = () => void navigator.clipboard.writeText(formatCode(code))
		const shareUrl = `${location.origin}${location.pathname}#${formatCode(code)}`
		await QRCode.toCanvas($<HTMLCanvasElement>("qr"), shareUrl, { width: 180, margin: 0 })
	} else {
		$("send-session-share").hidden = true
	}

	sendProgress.hidden = false
	sender = new Sender()
	try {
		await sender.send(
			relayInput.value,
			keys,
			file,
			(status) => (sendStatus.textContent = `${status} — ${file.name}`),
			(p: Progress) => (sendProgress.value = p.total ? (100 * p.sentOrReceived) / p.total : 100),
		)
	} catch (e) {
		sendStatus.textContent = `error: ${(e as Error).message}`
	}
}

$("send-cancel").onclick = () => {
	sender?.stop()
	sender = undefined
	$("send-session").hidden = true
	dropzone.hidden = false
	fileInput.value = ""
	sendProgress.value = 0
}

// --- Receive ---

const receiveBtn = $<HTMLButtonElement>("receive-btn")
const receiveStatus = $("receive-status")
const receiveProgress = $<HTMLProgressElement>("receive-progress")

receiveBtn.onclick = async () => {
	const code = normalizeCode($<HTMLInputElement>("code-input").value)
	if (code.length < 26) {
		receiveStatus.textContent = "that code looks too short"
		return
	}

	receiveBtn.disabled = true
	receiveProgress.hidden = false
	$("download-area").innerHTML = ""

	// Open the save picker now, while we still have the user gesture context.
	// We don't know the filename yet so suggest "download"; the actual name
	// is shown in the status line once metadata arrives.
	let writable: FileSystemWritableFileStream | undefined
	if ("showSaveFilePicker" in window) {
		try {
			const handle = await (window as any).showSaveFilePicker({ suggestedName: "download" }) as FileSystemFileHandle
			writable = await handle.createWritable()
		} catch {
			// User cancelled or browser blocked — fall back to blob download.
		}
	}

	const receiver = new Receiver()
	try {
		const keys = await deriveKeys(code)
		const { metadata, blob } = await receiver.receive(
			relayInput.value,
			keys,
			(status) => (receiveStatus.textContent = status),
			(p: Progress) => (receiveProgress.value = p.total ? (100 * p.sentOrReceived) / p.total : 100),
			writable,
		)

		receiveStatus.textContent = `received ${metadata.name} (${metadata.size.toLocaleString()} bytes)`

		if (!writable) {
			const url = URL.createObjectURL(blob!)
			const a = document.createElement("a")
			a.href = url
			a.download = metadata.name
			a.textContent = `Save ${metadata.name}`
			$("download-area").append(a)
			a.click()
		}
	} catch (e) {
		receiver.stop()
		await writable?.abort().catch(() => {})
		receiveStatus.textContent = `error: ${(e as Error).message}`
	} finally {
		receiveBtn.disabled = false
	}
}

// --- Prepare to receive (receiver-first flow) ---

let prepareReceiver: Receiver | undefined

let prepareCode = ""

$("prepare-btn").onclick = async () => {
	prepareCode = generateCode()

	$("receive-entry").hidden = true
	$("receive-prepare").hidden = false
	$("prepare-actions").hidden = false
	receiveStatus.textContent = ""
	receiveProgress.hidden = true
	receiveProgress.value = 0
	$("download-area").innerHTML = ""

	$("prepare-code").textContent = formatCode(prepareCode)

	const shareUrl = `${location.origin}${location.pathname}#s:${formatCode(prepareCode)}`
	await QRCode.toCanvas($<HTMLCanvasElement>("prepare-qr"), shareUrl, { width: 180, margin: 0 })
}

$("prepare-start").onclick = async () => {
	$("prepare-actions").hidden = true
	receiveProgress.hidden = false
	receiveStatus.textContent = "subscribing…"

	prepareReceiver = new Receiver()
	try {
		const keys = await deriveKeys(prepareCode)
		const { metadata, blob } = await prepareReceiver.receive(
			relayInput.value,
			keys,
			(status) => (receiveStatus.textContent = status),
			(p: Progress) => (receiveProgress.value = p.total ? (100 * p.sentOrReceived) / p.total : 100),
		)

		receiveStatus.textContent = `received ${metadata.name} (${metadata.size.toLocaleString()} bytes)`

		const url = URL.createObjectURL(blob!)
		const a = document.createElement("a")
		a.href = url
		a.download = metadata.name
		a.textContent = `Save ${metadata.name}`
		$("download-area").append(a)
		a.click()
	} catch (e) {
		if (!(e instanceof Error && e.message === "cancelled")) {
			receiveStatus.textContent = `error: ${(e as Error).message}`
		}
	} finally {
		prepareReceiver = undefined
		$("receive-prepare").hidden = true
		$("receive-entry").hidden = false
	}
}

$("prepare-cancel").onclick = async () => {
	await prepareReceiver?.stop()
	prepareReceiver = undefined
	$("receive-prepare").hidden = true
	$("receive-entry").hidden = false
}
