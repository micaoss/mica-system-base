// A minimal OCI distribution client: bearer tokens from the registry's challenge,
// blob and manifest pushes, reads, and an anonymous-read check.
import { fail } from './errors.ts'

export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

export interface Response { status: number, body: Uint8Array<ArrayBuffer>, headers: Headers }

export class Registry {
  readonly host: string
  readonly owner: string
  private readonly url: string
  private readonly bearers = new Map<string, string>()

  // `value` is <host>[:port]/<owner>; `token` is the write credential, empty for reads.
  constructor(value: string, private readonly user: string, private readonly token: string, plainHttp = false) {
    const match = /^([A-Z0-9.-]+(?::\d+)?)\/([A-Z0-9][\w./-]*[A-Z0-9])$/i.exec(value)
    if (!match)
      fail(`registry '${value}' is not <host>[:port]/<owner>`)
    this.host = match[1]!
    this.owner = match[2]!
    if (plainHttp && !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(this.host))
      fail(`plain HTTP is for a local test registry, not ${this.host}`)
    this.url = `${plainHttp ? 'http' : 'https'}://${this.host}`
  }

  private async challenge(repo: string, actions: string, secret: string): Promise<string> {
    const probe = await fetch(`${this.url}/v2/${repo}/tags/list`, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined)
    const challenge = probe?.headers.get('www-authenticate') ?? ''
    if (!/^bearer /i.test(challenge))
      return ''
    const realm = /realm="([^"]*)"/.exec(challenge)?.[1]
    const service = /service="([^"]*)"/.exec(challenge)?.[1] ?? ''
    if (!realm)
      fail(`${this.host} challenged with no realm: ${challenge}`)
    const query = new URLSearchParams({ service, scope: `repository:${repo}:${actions}` })
    const answer = await fetch(`${realm}?${query}`, {
      headers: secret ? { Authorization: `Basic ${btoa(`${this.user}:${secret}`)}` } : {},
      signal: AbortSignal.timeout(60_000),
    }).then(response => response.json() as Promise<{ token?: string, access_token?: string }>).catch(() => ({}) as { token?: string, access_token?: string })
    const token = answer.token ?? answer.access_token ?? ''
    if (!token)
      fail(`${realm} issued no ${secret ? '' : 'anonymous '}token for ${actions} on ${this.host}/${repo}`)
    return token
  }

  private async bearer(repo: string, actions: string): Promise<string> {
    const key = `${repo} ${actions}`
    if (!this.bearers.has(key))
      this.bearers.set(key, await this.challenge(repo, actions, this.token))
    return this.bearers.get(key)!
  }

  // Status 0 is a transport failure; a redirect is followed without credentials.
  async request(method: string, repo: string, actions: string, path: string, init: { headers?: Record<string, string>, body?: Uint8Array } = {}): Promise<Response> {
    const bearer = await this.bearer(repo, actions)
    const headers = { ...init.headers, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
    const target = path.startsWith('http') ? path : `${this.url}/v2/${repo}/${path}`
    try {
      let response = await fetch(target, { method, headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(1_800_000) })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location)
        response = await fetch(new URL(location, target), { method, signal: AbortSignal.timeout(1_800_000) })
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()), headers: response.headers }
    }
    catch {
      return { status: 0, body: new Uint8Array(), headers: new Headers() }
    }
  }

  async manifest(repo: string, reference: string): Promise<Response> {
    return this.request('GET', repo, 'pull', `manifests/${reference}`, { headers: { Accept: `${OCI_INDEX}, ${OCI_MANIFEST}` } })
  }

  async putBlob(repo: string, bytes: Uint8Array): Promise<string> {
    const digest = `sha256:${sha256(bytes)}`
    if ((await this.request('HEAD', repo, 'pull,push', `blobs/${digest}`)).status === 200)
      return digest
    const started = await this.request('POST', repo, 'pull,push', 'blobs/uploads/', { headers: { 'Content-Length': '0' } })
    if (started.status !== 202)
      fail(`starting an upload to ${this.host}/${repo} answered HTTP ${started.status}`)
    const location = started.headers.get('location')
    if (!location)
      fail(`the upload to ${this.host}/${repo} came with no Location`)
    const target = new URL(location, `${this.url}/`)
    target.searchParams.set('digest', digest)
    const put = await this.request('PUT', repo, 'pull,push', target.toString(), { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (put.status !== 201)
      fail(`uploading ${digest} to ${this.host}/${repo} answered HTTP ${put.status}`)
    return digest
  }

  async putManifest(repo: string, reference: string, mediaType: string, bytes: Uint8Array): Promise<string> {
    const put = await this.request('PUT', repo, 'pull,push', `manifests/${reference}`, { headers: { 'Content-Type': mediaType }, body: bytes })
    if (put.status !== 201)
      fail(`putting the manifest ${reference} to ${this.host}/${repo} answered HTTP ${put.status}`)
    return `sha256:${sha256(bytes)}`
  }

  // <repo>:<reference> read with no credential at all; undefined when it cannot be.
  async anonymous(repo: string, reference: string): Promise<Uint8Array | undefined> {
    const reader = new Registry(`${this.host}/${this.owner}`, '', '', this.url.startsWith('http:'))
    try {
      const manifest = await reader.manifest(repo, reference)
      return manifest.status === 200 ? manifest.body : undefined
    }
    catch {
      return undefined
    }
  }

  // A blob read with no credential, returned only when it matches its digest.
  async anonymousBlob(repo: string, digest: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const reader = new Registry(`${this.host}/${this.owner}`, '', '', this.url.startsWith('http:'))
    try {
      const blob = await reader.request('GET', repo, 'pull', `blobs/${digest}`)
      return blob.status === 200 && `sha256:${sha256(blob.body)}` === digest ? blob.body : undefined
    }
    catch {
      return undefined
    }
  }
}
