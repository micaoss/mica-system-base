// DATA initialisation, /var seeding and the boot-failure handler
// (payload/usr/lib/mica/mica-data-layout, mica-seed-var, mica-boot-failure).
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('state')
afterAll(box.done)

const mode = (path: string): string => (statSync(path).mode & 0o7777).toString(8)

describe('mica-data-layout', () => {
  const bin = join(box.dir, 'layout-bin')
  const quotas = join(box.dir, 'quotas.log')
  // statfs is faked to a small medium; chattr and setquota only log.
  const smallMedium = (): void => fake(bin, 'stat', 'if [ "$1" = -f ]; then printf \'65536 4096 16384\\n\'; else /usr/bin/stat "$@"; fi')
  smallMedium()
  for (const command of ['chattr', 'setquota'])
    fake(bin, command, 'printf "%s\\n" "$*" >>"$MICA_QUOTA_CALLS"')

  const newCase = (name: string): string => {
    const data = join(box.dir, 'layout', name, 'data')
    mkdirSync(data, { recursive: true })
    return data
  }
  const layout = (data: string): number => exec([join(MICA, 'mica-data-layout')], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_QUOTA_CALLS: quotas, MICA_DATA_ROOT: data }).code
  const quota = (): string[] => readFileSync(quotas, 'utf8').split('\n')
  const tree = (root: string): string => (readdirSync(root, { recursive: true }) as string[]).sort().map((path) => {
    const stats = lstatSync(join(root, path))
    return `${path}|${stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? `l${readlinkSync(join(root, path))}` : 'f'}`
  }).join('\n')

  test('a fresh DATA gets every namespace, its modes and its project quotas', () => {
    const data = newCase('fresh')
    expect(layout(data)).toBe(0)
    for (const name of ['state', 'meta', 'cache', 'tmp', 'var', 'containers'])
      expect(lstatSync(join(data, name)).isDirectory()).toBe(true)
    expect(mode(join(data, 'state'))).toBe('700')
    expect(mode(join(data, 'meta'))).toBe('700')
    expect(mode(join(data, 'tmp'))).toBe('1777')
    expect(quota()).toContain(`-P 100 0 0 0 0 ${data}`)
    expect(quota()).toContain(`-P 101 0 32768 0 2048 ${data}`)
    expect(quota()).toContain(`-p 101 +P ${data}/cache ${data}/tmp ${data}/var`)
    expect(quota()).toContain(`-P 102 0 0 0 0 ${data}`)
    expect(quota()).toContain(`-p 102 +P ${data}/containers`)
    expect(existsSync(join(data, 'containers/networks'))).toBe(true)
    expect(mode(join(data, 'containers/tmp'))).toBe('700')
    expect(existsSync(join(data, 'mica/containers/networks'))).toBe(false)
    for (const name of ['ui', 'config', 'containers', 'home', 'root', 'diagnostics'])
      expect(lstatSync(join(data, 'mica', name)).isDirectory()).toBe(true)
    for (const name of ['updates/downloads', 'updates/verified', 'updates/staging', 'apps'])
      expect(existsSync(join(data, 'mica', name))).toBe(true)
    expect(lstatSync(join(data, 'srv')).isDirectory()).toBe(true)
    const modes: [string, string][] = [['mica', '755'], ['srv', '755'], ['mica/ui', '755'], ['containers', '711'], ['mica/home', '755'], ['mica/root', '700'], ['mica/config', '700'], ['mica/diagnostics', '700']]
    for (const [path, want] of modes)
      expect([path, mode(join(data, path))]).toEqual([path, want])

    // Existing content is preserved and a second run changes nothing.
    writeFileSync(join(data, 'mica/ui/value'), 'keep\n')
    writeFileSync(join(data, 'srv/value'), 'user\n')
    const before = tree(data)
    expect(layout(data)).toBe(0)
    expect(readFileSync(join(data, 'mica/ui/value'), 'utf8')).toBe('keep\n')
    expect(readFileSync(join(data, 'srv/value'), 'utf8')).toBe('user\n')
    expect(tree(data)).toBe(before)
  })

  // Following a link at a namespace root would redirect privileged or user
  // writes outside DATA.
  test('a symbolic namespace root is refused and never followed', () => {
    for (const name of ['mica', 'srv', 'state', 'meta', 'cache', 'tmp', 'var', 'containers']) {
      const data = newCase(`foreign-${name}-link`)
      const outside = join(data, '..', 'outside')
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, join(data, name))
      expect([name, layout(data)]).not.toEqual([name, 0])
      expect(readlinkSync(join(data, name))).toBe(outside)
      expect(readdirSync(outside)).toEqual([])
    }
  })

  test('a large medium keeps a bounded variable-data budget', () => {
    fake(bin, 'stat', 'if [ "$1" = -f ]; then printf \'4194304 4096 1048576\\n\'; else /usr/bin/stat "$@"; fi')
    try {
      const data = newCase('large')
      expect(layout(data)).toBe(0)
      expect(quota()).toContain(`-P 101 0 262144 0 16384 ${data}`)
      expect(quota()).toContain(`-P 100 0 0 0 0 ${data}`)
      expect(quota()).toContain(`-P 102 0 0 0 0 ${data}`)
    }
    finally {
      smallMedium()
    }
  })
})

describe('mica-seed-var', () => {
  test('seeds /var once and keeps what the device changed', () => {
    const root = join(box.dir, 'seed-var')
    const template = join(root, 'template')
    mkdirSync(join(root, 'data/var'), { recursive: true })
    mkdirSync(join(template, 'lib/service'), { recursive: true })
    mkdirSync(join(template, 'tmp'), { recursive: true })
    chmodSync(join(template, 'lib/service'), 0o700)
    chmodSync(join(template, 'tmp'), 0o1777)
    writeFileSync(join(template, 'lib/service/config'), 'factory\n')
    symlinkSync('/run', join(template, 'run'))
    const seed = (): number => exec(['sh', join(MICA, 'mica-seed-var')], { PATH: SYSTEM_PATH, MICA_DATA_ROOT: join(root, 'data'), MICA_VAR_TEMPLATE: template }).code
    const variable = join(root, 'data/var')

    expect(seed()).toBe(0)
    expect(readFileSync(join(variable, 'lib/service/config'), 'utf8')).toBe('factory\n')
    expect(mode(join(variable, 'lib/service'))).toBe('700')
    expect(mode(join(variable, 'tmp'))).toBe('1777')
    expect(readlinkSync(join(variable, 'run'))).toBe('/run')

    writeFileSync(join(variable, 'lib/service/config'), 'runtime\n')
    mkdirSync(join(variable, 'lib/new-service'))
    expect(seed()).toBe(0)
    expect(readFileSync(join(variable, 'lib/service/config'), 'utf8')).toBe('runtime\n')
    expect(existsSync(join(variable, 'lib/new-service'))).toBe(true)

    rmSync(join(variable, 'lib/service/config'))
    expect(seed()).toBe(0)
    expect(existsSync(join(variable, 'lib/service/config'))).toBe(false)

    renameSync(variable, join(root, 'kept-var'))
    symlinkSync(join(root, 'kept-var'), variable)
    expect(seed()).not.toBe(0)
  })
})

describe('mica-boot-failure', () => {
  const root = join(box.dir, 'boot-failure')
  const bin = join(root, 'bin')
  const trace = join(root, 'trace')
  const marker = join(root, 'shared-data-failure')
  fake(bin, 'systemctl', 'echo "systemctl $*" >> "$MICA_TEST_TRACE"\ncase "$1" in is-active) exit "$MICA_TEST_DATA";; esac')
  fake(bin, 'mica-deploy', 'echo "mica-deploy $*" >> "$MICA_TEST_TRACE"\nexit "$MICA_TEST_RETIRE"')
  // The recovery marker is moved into the sandbox so a host marker is never read.
  const script = join(root, 'failure')
  writeFileSync(script, readFileSync(join(MICA, 'mica-boot-failure'), 'utf8').replaceAll('/run/mica/shared-data-failure', marker))

  const failure = (data: string, retire: string): string[] => {
    writeFileSync(trace, '')
    exec(['bash', script], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_TEST_TRACE: trace, MICA_TEST_DATA: data, MICA_TEST_RETIRE: retire })
    return readFileSync(trace, 'utf8').split('\n').filter(Boolean)
  }

  test('a failed boot is retired and rebooted', () => {
    const lines = failure('0', '0')
    expect(lines).toContain('mica-deploy fail-boot')
    expect(lines.at(-1)).toBe('systemctl --no-block reboot')
    expect(lines.at(-2)).toBe('mica-deploy fail-boot')
  })

  test('a retirement that fails powers off instead of rebooting', () => {
    const lines = failure('0', '1')
    expect(lines).toContain('systemctl --no-block poweroff')
    expect(lines.some(line => line.includes('reboot'))).toBe(false)
  })

  test('missing shared DATA powers off and never retires', () => {
    const lines = failure('1', '0')
    expect(lines).toContain('systemctl --no-block poweroff')
    expect(lines.some(line => line.startsWith('mica-deploy'))).toBe(false)
  })

  test('the shared-DATA failure marker powers off and never retires', () => {
    writeFileSync(marker, '')
    const lines = failure('0', '0')
    expect(lines).toContain('systemctl --no-block poweroff')
    expect(lines.some(line => line.startsWith('mica-deploy'))).toBe(false)
  })
})
