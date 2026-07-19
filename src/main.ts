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

// If opened via a share link (#code in fragment, never sent to any server),
// jump straight to receiving.
if (location.hash.length > 1) {
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

	const code = generateCode()
	const keys = await deriveKeys(code)

	dropzone.hidden = true
	$("send-session").hidden = false

	const codeEl = $("code")
	codeEl.textContent = formatCode(code)
	codeEl.onclick = () => void navigator.clipboard.writeText(formatCode(code))

	const shareUrl = `${location.origin}${location.pathname}#${formatCode(code)}`
	await QRCode.toCanvas($<HTMLCanvasElement>("qr"), shareUrl, { width: 180, margin: 0 })

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

	const receiver = new Receiver()
	try {
		const keys = await deriveKeys(code)
		const { metadata, blob } = await receiver.receive(
			relayInput.value,
			keys,
			(status) => (receiveStatus.textContent = status),
			(p: Progress) => (receiveProgress.value = p.total ? (100 * p.sentOrReceived) / p.total : 100),
		)

		receiveStatus.textContent = `received ${metadata.name} (${metadata.size.toLocaleString()} bytes)`
		const url = URL.createObjectURL(blob)
		const a = document.createElement("a")
		a.href = url
		a.download = metadata.name
		a.textContent = `Save ${metadata.name}`
		$("download-area").append(a)
		a.click()
	} catch (e) {
		receiver.stop()
		receiveStatus.textContent = `error: ${(e as Error).message}`
	} finally {
		receiveBtn.disabled = false
	}
}
