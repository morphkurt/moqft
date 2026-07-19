// End-to-end test: send a file between two browser pages through the real
// Cloudflare MoQ relay and verify the received bytes match.
//
//   node scripts/e2e.mjs [relay-url]

import { chromium } from "playwright"
import { createServer } from "vite"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const relay = process.argv[2]
const sizeKiB = Number(process.argv[3] ?? 300)

const dir = mkdtempSync(join(tmpdir(), "moqft-"))
const payload = randomBytes(sizeKiB * 1024 + 123) // multiple chunks + ragged tail
const srcPath = join(dir, "testfile.bin")
writeFileSync(srcPath, payload)

const vite = await createServer({ server: { port: 0 } })
await vite.listen()
const url = vite.resolvedUrls.local[0]
console.log("dev server:", url)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()

const senderPage = await ctx.newPage()
const receiverPage = await ctx.newPage()
for (const [name, page] of [["sender", senderPage], ["receiver", receiverPage]]) {
	page.on("console", (m) => console.log(`[${name}]`, m.text()))
	page.on("pageerror", (e) => console.log(`[${name}] pageerror:`, e.message))
}

try {
	await senderPage.goto(url)
	if (relay) await senderPage.fill("#relay", relay)
	await senderPage.setInputFiles("#file-input", srcPath)

	await senderPage.waitForSelector("#code:not(:empty)", { timeout: 15000 })
	const code = await senderPage.textContent("#code")
	console.log("transfer code:", code)

	await senderPage.waitForFunction(
		() => document.getElementById("send-status").textContent.includes("waiting for receiver"),
		{ timeout: 30000 },
	)
	console.log("sender announced, waiting for receiver")

	await receiverPage.goto(url)
	if (relay) await receiverPage.fill("#relay", relay)
	await receiverPage.click("#tab-receive")
	await receiverPage.fill("#code-input", code)

	const downloadPromise = receiverPage.waitForEvent("download", { timeout: 60000 })
	const startedAt = Date.now()
	await receiverPage.click("#receive-btn")

	senderPage.waitForFunction(() => document.getElementById("send-status").textContent.includes("sent"), { timeout: 60000 })
		.then(() => console.log(`sender finished uploading at ${((Date.now() - startedAt) / 1000).toFixed(2)}s`))
		.catch(() => {})

	const download = await downloadPromise
	const seconds = (Date.now() - startedAt) / 1000
	console.log(`transfer took ${seconds.toFixed(2)}s (${(payload.length / seconds / 1024 / 1024).toFixed(2)} MiB/s incl. connect+subscribe)`)
	const destPath = join(dir, "received.bin")
	await download.saveAs(destPath)

	const received = readFileSync(destPath)
	if (Buffer.compare(received, payload) === 0 && download.suggestedFilename() === "testfile.bin") {
		console.log(`PASS: ${received.length} bytes round-tripped intact through the relay`)
		process.exitCode = 0
	} else {
		console.log("FAIL: received bytes differ from sent bytes")
		process.exitCode = 1
	}
} catch (e) {
	console.log("FAIL:", e.message)
	const sendStatus = await senderPage.textContent("#send-status").catch(() => "?")
	const recvStatus = await receiverPage.textContent("#receive-status").catch(() => "?")
	console.log("sender status:", sendStatus, "| receiver status:", recvStatus)
	process.exitCode = 1
} finally {
	await browser.close()
	await vite.close()
}
