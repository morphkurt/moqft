// Debug: log every control message on sender and receiver sides.
import { chromium } from "playwright"
import { createServer } from "vite"

const vite = await createServer({ server: { port: 0 } })
await vite.listen()
const url = vite.resolvedUrls.local[0]

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const sender = await ctx.newPage()
const receiver = await ctx.newPage()
for (const [name, page] of [["S", sender], ["R", receiver]]) {
	page.on("console", (m) => console.log(`[${name}]`, m.text()))
	page.on("pageerror", (e) => console.log(`[${name}] pageerror:`, e.message))
}

await sender.goto(url)
await receiver.goto(url)

const pathId = "deadbeef" + Date.now().toString(16)

const senderDone = sender.evaluate(async (pathId) => {
	const m = await import("/node_modules/moqtail/dist/index.js")
	const c = await import("/node_modules/moqtail/dist/client.js")
	c.MOQtailClient.setLogLevel?.(1)
	const client = await c.MOQtailClient.new({ url: "https://relay.cloudflare.mediaoverquic.com", setupParameters: new m.SetupParameters().addMaxRequestId(1024), callbacks: {
		onMessageReceived: (msg) => console.log("S recv:", msg.constructor.name, JSON.stringify(msg, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 300)),
		onMessageSent: (msg) => console.log("S sent:", msg.constructor.name),
		onSessionTerminated: (r) => console.log("S terminated:", r),
		onDataSent: (d) => console.log("S data sent:", d.constructor.name, JSON.stringify(d, (k,v)=>typeof v==="bigint"?v.toString():v instanceof Uint8Array?("len:"+v.length):v).slice(0,200)),
	} })

	const ftn = m.FullTrackName.tryNew(`moqft/${pathId}`, "file")
	let controller
	const stream = new ReadableStream({ start: (ctl) => (controller = ctl) })
	client.addOrUpdateTrack({ fullTrackName: ftn, trackSource: { live: new c.LiveTrackSource(stream) }, publisherPriority: 0 })

	const res = await client.publishNamespace(m.Tuple.fromUtf8Path(`moqft/${pathId}`))
	console.log("S publishNamespace result:", res.constructor.name)

	// wait 20s logging whatever happens; push an object when publication appears
	for (let i = 0; i < 100; i++) {
		if (client.publications.size > 0) {
			console.log("S publication registered! pushing objects")
			for (let seq = 0; seq <= 20; seq++) {
				controller.enqueue(m.MoqtObject.newWithPayload(ftn, new m.Location(0n, BigInt(seq)), 0, m.ObjectForwardingPreference.Subgroup, 0n, null, new Uint8Array(65536).fill(seq)))
			}
			controller.close()
			console.log("S closed live source")
			break
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	await new Promise((r) => setTimeout(r, 5000))
	return "sender done"
}, pathId)

await new Promise((r) => setTimeout(r, 3000))

const receiverDone = receiver.evaluate(async (pathId) => {
	const m = await import("/node_modules/moqtail/dist/index.js")
	const c = await import("/node_modules/moqtail/dist/client.js")
	const client = await c.MOQtailClient.new({ url: "https://relay.cloudflare.mediaoverquic.com", setupParameters: new m.SetupParameters().addMaxRequestId(1024), callbacks: {
		onMessageReceived: (msg) => console.log("R recv:", msg.constructor.name, JSON.stringify(msg, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 300)),
		onMessageSent: (msg) => console.log("R sent:", msg.constructor.name),
		onDataReceived: (d) => console.log("R data recv:", d.constructor.name, JSON.stringify(d, (k,v)=>typeof v==="bigint"?v.toString():v instanceof Uint8Array?("len:"+v.length):v).slice(0,200)),
	} })

	const ftn = m.FullTrackName.tryNew(`moqft/${pathId}`, "file")
	const res = await client.subscribe({ fullTrackName: ftn, priority: 0, groupOrder: m.GroupOrder.Original, forward: true, filterType: m.FilterType.LatestObject })
	if (res instanceof m.RequestError) return "R subscribe error: " + res.reasonPhrase.phrase
	console.log("R subscribed ok, reading...")
	const reader = res.stream.getReader()
	const got = []
	for (;;) {
		const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 15000))
		const r2 = await Promise.race([reader.read(), timeout])
		if (r2 === "timeout") { got.push("TIMEOUT"); break }
		if (r2.done) { got.push("DONE"); break }
		got.push(`obj ${r2.value.location.group}:${r2.value.location.object} len=${r2.value.payload?.length}`)
	}
	return "R got: " + got.join(", ")
}, pathId)

console.log(await receiverDone)
console.log(await senderDone)
await browser.close()
await vite.close()
