// Download one URL for cache.ts.
export {}
const [url, destination] = Bun.argv.slice(2)
if (!url || !destination || !url.startsWith('https://'))
  throw new Error('usage: fetch.ts <https-url> <destination>')
// 44: this host does not have the file. Expected from a pool mirror, so not retried.
const ABSENT = 44
// One controller bounds headers and body. It is still a timer on this event loop,
// so cache.ts enforces the hard ceiling from outside.
const DEADLINE_MS = 180_000
for (let attempt = 1; ; attempt++) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (response.status === 404)
      process.exit(ABSENT)
    if (!response.ok || !response.url.startsWith('https://'))
      throw new Error(`download failed: ${response.status} ${url}`)
    await Bun.write(destination, response)
    break
  }
  catch (error) {
    if (attempt === 3)
      throw error
    await Bun.sleep(1_000 * attempt)
  }
  finally {
    clearTimeout(deadline)
  }
}
