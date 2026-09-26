// The package definitions and the mica-system payload.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { inputsHash, readDeclaration } from '@mica/build-tools'
import { buildPlan, declared } from '../src/debs/docker.ts'
import { selectBuild, selectInputs, selectRuntime, selectSource } from '../src/lock.ts'
import { REPO, run } from './fixture.ts'

test('a build for one architecture takes its own and the all packages, filed into its pool only', () => {
  const packages = [{ name: 'data', arches: ['all' as const] }, { name: 'tool', arches: ['amd64' as const, 'arm64' as const] }]
  expect(buildPlan(packages)).toEqual([
    { name: 'data', arch: 'all', pools: ['amd64', 'arm64'] },
    { name: 'tool', arch: 'amd64', pools: ['amd64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
  ])
  expect(buildPlan(packages, 'arm64')).toEqual([
    { name: 'data', arch: 'all', pools: ['arm64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
  ])
})

describe('the package definitions', () => {
  test('every debs/<package> declares its architectures and has a control template named after it', () => {
    const packages = declared(REPO)
    expect(packages.map(entry => entry.name)).toEqual(['mica-busybox', 'mica-ca-trust', 'mica-ssh', 'mica-system', 'mica-systemd-boot', 'mica-tzdata', 'mica-wifi', 'mica-wifi-ap'])
    for (const entry of packages)
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toStartWith(`Package: ${entry.name}\n`)
    expect(packages.find(entry => entry.name === 'mica-busybox')).toEqual({ name: 'mica-busybox', arches: ['amd64', 'arm64'], inputs: [], build: [], sources: ['busybox'], version: '1.38.0-mica2', epoch: 1790460000 })
    expect(Object.fromEntries(packages.map(entry => [entry.name, entry.version]))).toEqual({ 'mica-busybox': '1.38.0-mica2', 'mica-ca-trust': '20250419-mica3', 'mica-ssh': '1.0.0-3', 'mica-system': '1.1.0-2', 'mica-systemd-boot': '257.13-mica2', 'mica-tzdata': '2026c-mica2', 'mica-wifi': '2.12-mica2', 'mica-wifi-ap': '2.12-mica2' })
  })

  // systemd-boot is compiled from the source of the systemd the lock pins, with the patch that
  // refuses exhausted or unrecorded boot attempts, on build tools pinned for both architectures.
  test('mica-systemd-boot builds the locked systemd release with the attempt patch and pinned build tools', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-systemd-boot/Dockerfile'), 'utf8')
    const { version, url } = selectSource(REPO, 'systemd')
    for (const arch of ['amd64', 'arm64'] as const)
      expect(selectRuntime(REPO, arch, { kind: 'package', name: 'systemd' })[0]!.version.replace(/-[^-]+$/, '')).toBe(version)
    expect(url).toMatch(new RegExp(`^https://snapshot\\.debian\\.org/archive/debian/\\d{8}T\\d{6}Z/pool/main/s/systemd/systemd_${version.replaceAll('.', '\\.')}\\.orig\\.tar\\.gz$`))
    expect(dockerfile).toContain('curl -fsSL --retry 3 -o /systemd.tar.gz "${MICA_SOURCE_SYSTEMD_URL}"')
    expect(dockerfile).toContain('echo "${MICA_SOURCE_SYSTEMD_SHA256}  /systemd.tar.gz" | sha256sum -c -')
    expect(dockerfile).toContain('FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build')
    expect(dockerfile).toContain('\'Mica OS: deployment attempts exhausted\'')
    const patch = readFileSync(join(REPO, 'debs/mica-systemd-boot/persistence.patch'), 'utf8')
    expect(patch).toContain('+                if (entry->tries_left == 0)')
    expect(patch).toContain('Mica OS: attempt state was not persisted; refusing boot')
    const entry = declared(REPO).find(candidate => candidate.name === 'mica-systemd-boot')!
    for (const arch of ['amd64', 'arm64'] as const) {
      const pinned = selectBuild(REPO, arch, 'mica-systemd-boot').map(row => row.name)
      expect(pinned).toEqual(expect.arrayContaining(entry.build))
    }
    expect(readFileSync(join(REPO, 'debs/consumers.pkgs'), 'utf8')).toMatch(/^mica-systemd-boot$/m)
  })

  // BusyBox is compiled from the upstream release, statically, so it needs nothing of the root.
  test('mica-busybox builds the pinned upstream source statically and depends on nothing', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-busybox/Dockerfile'), 'utf8')
    const { version, url } = selectSource(REPO, 'busybox')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(url).toBe(`https://busybox.net/downloads/busybox-${version}.tar.bz2`)
    expect(dockerfile).toContain('echo "${MICA_SOURCE_BUSYBOX_SHA256}  /busybox.tar.bz2" | sha256sum -c -')
    expect(dockerfile).toContain('FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build')
    expect(readFileSync(join(REPO, 'debs/mica-busybox/config'), 'utf8')).toMatch(/^CONFIG_STATIC=y$/m)
    expect(readFileSync(join(REPO, 'debs/mica-busybox/control'), 'utf8')).not.toMatch(/^Depends:/m)
    expect(existsSync(join(REPO, 'debs/mica-busybox/inputs'))).toBe(false)
  })

  // wpa_supplicant and hostapd are compiled from the upstream hostap release with nl80211 only,
  // libnl linked statically and OpenSSL for WPA2 and WPA3: nothing else is configured, and the
  // units keep the names and paths micad drives.
  describe.each([
    { name: 'mica-wifi', source: 'wpa-supplicant', archive: 'wpa_supplicant', unit: 'usr/lib/systemd/system/wpa_supplicant@.service', config: ['CONFIG_AP=y', 'CONFIG_BACKEND=file', 'CONFIG_BGSCAN_SIMPLE=y', 'CONFIG_CTRL_IFACE=y', 'CONFIG_DRIVER_NL80211=y', 'CONFIG_GETRANDOM=y', 'CONFIG_LIBNL32=y', 'CONFIG_NO_CONFIG_BLOBS=y', 'CONFIG_SAE=y', 'CONFIG_TLS=openssl'] },
    { name: 'mica-wifi-ap', source: 'hostapd', archive: 'hostapd', unit: 'usr/lib/systemd/system/hostapd@.service', config: ['CONFIG_CTRL_IFACE=y', 'CONFIG_DRIVER_NL80211=y', 'CONFIG_GETRANDOM=y', 'CONFIG_LIBNL32=y', 'CONFIG_NO_ACCOUNTING=y', 'CONFIG_NO_RADIUS=y', 'CONFIG_NO_VLAN=y', 'CONFIG_SAE=y', 'CONFIG_TLS=openssl'] },
  ])('$name', ({ name, source, archive, unit, config }) => {
    const dockerfile = (): string => readFileSync(join(REPO, 'debs', name, 'Dockerfile'), 'utf8')

    test('builds the pinned upstream hostap release on pinned build tools', () => {
      const { version, url } = selectSource(REPO, source)
      expect(version).toMatch(/^\d+\.\d+$/)
      expect(url).toBe(`https://w1.fi/releases/${archive}-${version}.tar.gz`)
      expect(readFileSync(join(REPO, 'debs', name, 'control'), 'utf8')).toMatch(new RegExp(`^Version: ${version.replaceAll('.', '\\.')}-mica\\d+$`, 'm'))
      const entry = declared(REPO).find(candidate => candidate.name === name)!
      expect(entry).toMatchObject({ arches: ['amd64', 'arm64'], sources: [source], build: ['libnl-3-dev', 'libnl-genl-3-dev', 'libssl-dev', 'pkg-config'] })
      for (const arch of ['amd64', 'arm64'] as const)
        expect(selectBuild(REPO, arch, name).map(row => row.name)).toEqual(expect.arrayContaining(entry.build))
      expect(dockerfile()).toContain('FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build')
      expect(readFileSync(join(REPO, 'debs/consumers.pkgs'), 'utf8')).toMatch(new RegExp(`^${name}$`, 'm'))
    })

    // The headers it compiles against are of the ABI series the root runs: the build snapshot's
    // security archive may carry a newer patch release than the runtime lock.
    test('compiles against the libssl and libnl series the root pins', () => {
      const series = (version: string): string => version.replace(/^\d+:/, '').split('-')[0]!.split('.').slice(0, 2).join('.')
      for (const arch of ['amd64', 'arm64'] as const) {
        const build = new Map(selectBuild(REPO, arch, name).map(row => [row.name, row.version]))
        for (const [dev, runtime] of [['libssl-dev', 'libssl3t64'], ['libnl-3-dev', 'libnl-3-200'], ['libnl-genl-3-dev', 'libnl-genl-3-200']] as const)
          expect(series(build.get(dev)!)).toBe(series(selectRuntime(REPO, arch, { kind: 'package', name: runtime })[0]!.version))
      }
    })

    test('configures exactly the minimal feature set', () => {
      const settings = readFileSync(join(REPO, 'debs', name, 'config'), 'utf8').split('\n').filter(line => /^CONFIG_/.test(line))
      expect(settings.sort()).toEqual([...config])
    })

    test('refuses a binary that loads anything but libc, libcrypto and libnl', () => {
      expect(dockerfile()).toContain('libc.so.6 | libcrypto.so.3 | libnl-3.so.200 | libnl-genl-3.so.200) ;;')
    })

    test('ships the unit micad drives', () => {
      expect(dockerfile()).toContain(`/stage/${unit}`)
    })
  })

  test('the AP unit starts hostapd on the configuration micad renders', () => {
    const service = readFileSync(join(REPO, 'debs/mica-wifi-ap/hostapd@.service'), 'utf8')
    expect(service).toMatch(/^ExecStart=\/usr\/sbin\/hostapd -B -P \/run\/hostapd\.%i\.pid \/etc\/hostapd\/%i\.conf$/m)
    expect(service).toMatch(/^ConditionFileNotEmpty=\/etc\/hostapd\/%i\.conf$/m)
  })

  test('upstream.pkgs no longer pins Debian\'s wpasupplicant or hostapd', () => {
    const roots = readFileSync(join(REPO, 'upstream.pkgs'), 'utf8').split('\n').map(line => line.replace(/#.*/, '').trim())
    expect(roots).not.toContain('wpasupplicant')
    expect(roots).not.toContain('hostapd')
  })
})

// Each producer's mica-inputs declares what its Dockerfile builds from: its
// package, the shared files it reads, and the lock rows of its inputs, build
// closure and sources; mica-build-tools hashes it for every architecture built.
test('every mica-inputs declares what its Dockerfile builds from', () => {
  for (const entry of declared(REPO)) {
    const dockerfile = readFileSync(join(REPO, 'debs', entry.name, 'Dockerfile'), 'utf8')
    expect(readDeclaration(REPO, `debs/${entry.name}`)).toEqual({
      dir: `debs/${entry.name}`,
      packages: [entry.name],
      paths: [...(dockerfile.includes('debs/copyright') ? ['debs/copyright'] : []), ...(dockerfile.includes('from=payload') ? ['payload'] : [])],
      sources: [...entry.inputs.map(input => `input.${input}`), ...(entry.build.length ? [`build.${entry.name}.*`] : []), ...entry.sources.map(source => `source.${source}`)],
      gits: [],
      images: [],
    })
    for (const arch of entry.arches)
      expect(inputsHash(REPO, readDeclaration(REPO, `debs/${entry.name}`), arch)).toMatch(/^[0-9a-f]{64}$/)
  }
})

describe('the Mica names', () => {
  // Mica OS is the only name: no tracked file names the retired project, in its
  // path or its text. The retired name is spelled from its letters so this file
  // does not carry it either.
  test('the retired project name appears in no tracked file or path', () => {
    const retired = ['m', 'o', 's'].join('')
    const word = new RegExp(`(^|[^a-z0-9])${retired}([^a-z0-9]|$)`, 'i')
    const git = (...args: string[]): { code: number, output: string } => run(['git', '-c', 'safe.directory=*', '-C', REPO, ...args])
    const files = git('ls-files')
    expect(files.code).toBe(0)
    expect(files.output.split('\n').filter(path => word.test(path))).toEqual([])
    const text = git('grep', '-nIiE', String.raw`(^|[^a-z0-9])${retired}([^a-z0-9]|$)`)
    expect(text.output.trim()).toBe('')
    expect(existsSync(join(REPO, 'payload/etc/systemd/system/mica.mount'))).toBe(true)
  })

  test('every package is maintained by Mica OS', () => {
    for (const entry of declared(REPO))
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toContain('\nMaintainer: Mica OS <hi@micaos.dev>\n')
  })
})

describe('the mica-system payload', () => {
  const payload = join(REPO, 'payload')
  const entries = (directory: string): string[] => readdirSync(join(payload, directory), { recursive: true }).map(String)

  test('carries no DEBIAN', () => {
    expect(existsSync(join(payload, 'DEBIAN'))).toBe(false)
  })

  test('enables every linked unit from a path that exists, and never dropbear or nftables', () => {
    const system = join(payload, 'etc/systemd/system')
    for (const entry of entries('etc/systemd/system')) {
      const path = join(system, entry)
      if (!lstatSync(path).isSymbolicLink())
        continue
      expect(entry).not.toMatch(/(?:dropbear|nftables)\.service$/)
      const target = readlinkSync(path)
      if (target === '/dev/null' || target.startsWith('/lib/systemd/system/') || target.startsWith('/usr/lib/systemd/system/systemd-'))
        continue
      expect(existsSync(join(payload, target))).toBe(true)
    }
  })

  test('disables nftables.service by preset, and carries nothing of SSH', () => {
    const presets = join(payload, 'usr/lib/systemd/system-preset')
    expect(readFileSync(join(presets, '50-mica-nftables.preset'), 'utf8')).toBe('disable nftables.service\n')
    for (const moved of ['usr/lib/systemd/system-preset/50-mica-dropbear.preset', 'etc/systemd/system/dropbear.service', 'usr/lib/mica/mica-dropbear-prestart'])
      expect(existsSync(join(payload, moved))).toBe(false)
  })

  // The console is an option: no getty starts until login is installed.
  test('holds every getty until the console option installs login', () => {
    for (const unit of ['getty@', 'serial-getty@'])
      expect(readFileSync(join(payload, `etc/systemd/system/${unit}.service.d/10-mica-console.conf`), 'utf8')).toMatch(/^ConditionPathExists=\/usr\/bin\/login$/m)
  })

  test('depends on the floor and on no option', () => {
    const depends = /^Depends: (.*)$/m.exec(readFileSync(join(REPO, 'debs/mica-system/control'), 'utf8'))?.[1] ?? ''
    expect(depends.split(', ')).toEqual(['systemd', 'systemd-sysv', 'systemd-resolved', 'systemd-repart', 'systemd-timesyncd', 'udev', 'dbus', 'passwd', 'quota', 'e2fsprogs'])
    expect(readFileSync(join(REPO, 'debs/mica-system/postinst'), 'utf8')).toMatch(/^LOGIN_SHELL=\/bin\/sh$/m)
  })
})

describe('mica-ssh', () => {
  const directory = join(REPO, 'debs/mica-ssh')

  test('carries SSH: dropbear, its unit, prestart and preset, on top of mica-system', () => {
    const depends = /^Depends: (.*)$/m.exec(readFileSync(join(directory, 'control'), 'utf8'))?.[1] ?? ''
    expect(depends.split(', ')).toEqual(['dropbear-bin', 'mica-system'])
    expect(depends).not.toMatch(/openssh/)
    expect(readFileSync(join(directory, '50-mica-dropbear.preset'), 'utf8')).toBe('disable dropbear.service\n')
    for (const file of ['dropbear.service', 'mica-dropbear-prestart'])
      expect(existsSync(join(directory, file))).toBe(true)
  })

  // dropbear reaches an account through crypt(3) against /etc/shadow, not through
  // PAM; the build refuses the pinned dropbear-bin if either half says otherwise.
  test('refuses a dropbear-bin that depends on PAM or whose binary names libpam', () => {
    const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')
    expect(declared(REPO).find(entry => entry.name === 'mica-ssh')).toMatchObject({ arches: ['all'], inputs: ['dropbear-bin'] })
    expect(dockerfile).toContain('dropbear-bin depends on PAM')
    expect(dockerfile).toContain('names libpam')
  })
})

describe('mica-tzdata', () => {
  const directory = join(REPO, 'debs/mica-tzdata')

  // tzdata's postinst parses a date with GNU date, which the floor does not have;
  // the zones are carried as payload instead, from the pinned archive.
  test('carries the zoneinfo of the pinned tzdata, with no maintainer script', () => {
    expect(declared(REPO).find(entry => entry.name === 'mica-tzdata')).toMatchObject({ arches: ['all'], inputs: ['tzdata'] })
    const input = selectInputs(REPO, 'amd64').find(row => row.name === 'tzdata')!
    const control = readFileSync(join(directory, 'control'), 'utf8')
    expect(control).toMatch(new RegExp(`^Version: ${input.version.replace(/-[^-]*$/, '').replaceAll('.', '\\.')}-mica\\d+$`, 'm'))
    for (const field of ['Provides', 'Conflicts'])
      expect(control).toMatch(new RegExp(`^${field}: tzdata\\b`, 'm'))
    // RULES section 6 refuses Replaces; a device never upgrades a package in place.
    expect(control).not.toMatch(/^Replaces:/m)
    expect(existsSync(join(directory, 'postinst'))).toBe(false)
  })
})

// Under `set -o pipefail`, an early-exiting reader on the right of a pipe (head,
// grep -q/-m, sed -n Nq, read) fails the pipeline when the producer dies of
// SIGPIPE, so the test passes or fails by where the match sits. No script here
// enables pipefail, and the three latent sites are recorded in
// docs/task/20260915-1145-pipefail-shapes.md to be hardened with the next bump of
// their package. This guard keeps the two facts together: a script that enables
// pipefail may not pipe into such a reader.
test('no shell script pipes into an early-exiting reader under pipefail', () => {
  const early = /\|[ \t]*(?:head\b|grep\b[^|]*(?:-[A-Za-z]*[qm]|--quiet|--max-count)|sed\b[^|]*\b\d*q\b|read\b)/
  const scripts = run(['git', '-c', 'safe.directory=*', '-C', REPO, 'ls-files', '--', 'payload', 'debs', '*.sh']).output.split('\n').filter(Boolean)
  const offending: string[] = []
  for (const path of scripts) {
    if (!lstatSync(join(REPO, path)).isFile())
      continue
    const text = readFileSync(join(REPO, path), 'utf8')
    if (!/^#!.*\b(?:ba)?sh\b/.test(text) && !path.endsWith('Dockerfile') && !path.endsWith('.sh'))
      continue
    for (const [index, line] of text.split('\n').entries()) {
      if (/set -o pipefail|set -[a-z]*o pipefail/.test(text) && early.test(line))
        offending.push(`${path}:${index + 1}`)
    }
  }
  expect(offending).toEqual([])
  // The guard sees the shape: a script with pipefail and such a pipe is refused.
  expect(early.test('printf \'%s\\n\' "$x" | grep -qx y')).toBe(true)
  expect(early.test('sed -n "s/^a=//p" "$f" | head -n1')).toBe(true)
  expect(early.test('dpkg-deb --fsys-tarfile "$1" | tar -tf -')).toBe(false)
})
