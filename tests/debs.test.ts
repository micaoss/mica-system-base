// The package definitions and the mica-system payload.
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { inputsHash, readDeclaration } from '@mica/build-tools'
import { buildPlan, declared } from '../src/debs/docker.ts'
import { lstatExists } from '../src/rootfs.ts'
import { inputRoots } from '../src/pin-inputs.ts'
import { UPSTREAM, upstreamOf, upstreamVersion } from '../src/update.ts'
import { selectBuild, selectInputs, selectRuntime, selectSource } from '../src/lock.ts'
import { REPO, run } from './fixture.ts'

test('a build for one architecture takes its own and the all packages, filed into its pool only', () => {
  const packages = [{ name: 'data', arches: ['all' as const] }, { name: 'tool', arches: ['amd64' as const, 'arm64' as const] }, { name: 'small', arches: ['armhf' as const] }]
  expect(buildPlan(packages)).toEqual([
    { name: 'data', arch: 'all', pools: ['amd64', 'arm64', 'armhf'] },
    { name: 'tool', arch: 'amd64', pools: ['amd64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
    { name: 'small', arch: 'armhf', pools: ['armhf'] },
  ])
  expect(buildPlan(packages, 'arm64')).toEqual([
    { name: 'data', arch: 'all', pools: ['arm64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
  ])
  expect(buildPlan(packages, 'armhf')).toEqual([
    { name: 'data', arch: 'all', pools: ['armhf'] },
    { name: 'small', arch: 'armhf', pools: ['armhf'] },
  ])
})

// An `all` package taking inputs is built in the amd64 image for the armhf pool
// too, so armhf's build takes amd64's inputs for it; a package of armhf's own
// takes armhf's. Both are what the armhf build caches.
test('armhf takes the amd64 inputs, and its own for its own packages', () => {
  expect(selectInputs(REPO, 'amd64').some(row => row.architecture === 'amd64')).toBe(true)
  expect(selectInputs(REPO, 'amd64').some(row => row.architecture === 'armhf')).toBe(false)
  const armhf = selectInputs(REPO, 'armhf')
  expect(armhf.filter(row => row.architecture !== 'armhf')).toEqual(selectInputs(REPO, 'amd64'))
  expect(armhf.filter(row => row.architecture === 'armhf').map(row => row.name).sort()).toEqual(['openssh-client', 'openssh-server'])
})

test('an input is pinned for the architectures that build the packages taking it', () => {
  const packages = [
    { arches: ['all' as const], inputs: ['data'] },
    { arches: ['amd64' as const, 'armhf' as const], inputs: ['tool'] },
  ]
  expect(inputRoots(packages, 'amd64')).toEqual(['data', 'tool'])
  expect(inputRoots(packages, 'arm64')).toEqual(['data'])
  expect(inputRoots(packages, 'armhf')).toEqual(['tool'])
})

describe('the package definitions', () => {
  test('every debs/<package> declares its architectures and has a control template named after it', () => {
    const packages = declared(REPO)
    expect(packages.map(entry => entry.name)).toEqual(['mica-bluetooth', 'mica-busybox', 'mica-ca-trust', 'mica-mdev', 'mica-openrc', 'mica-openssh', 'mica-ssh', 'mica-storage-ubi', 'mica-system', 'mica-systemd', 'mica-systemd-boot', 'mica-tzdata', 'mica-wifi', 'mica-wifi-ap'])
    for (const entry of packages)
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toStartWith(`Package: ${entry.name}\n`)
    expect(packages.find(entry => entry.name === 'mica-busybox')).toMatchObject({ arches: ['amd64', 'arm64', 'armhf'], inputs: [], build: [], sources: ['busybox'] })
    // Every version is <upstream>-mica<revision>, the upstream being the version
    // of the lock row the package follows (src/update.ts keeps both so).
    for (const entry of packages) {
      expect(entry.version).toMatch(/^[0-9][\w.+~]*-mica\d+$/)
      expect(entry.epoch).toBeGreaterThan(0)
      expect(upstreamOf(entry.version)).toBe(upstreamOf(upstreamVersion(REPO, UPSTREAM[entry.name]!)))
    }
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

  // BusyBox is compiled from the upstream release, statically, so it needs nothing of the root;
  // for armhf with the amd64 C image's cross toolchain, running nothing it built.
  test('mica-busybox builds the pinned upstream source statically and depends on nothing', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-busybox/Dockerfile'), 'utf8')
    const { version, url } = selectSource(REPO, 'busybox')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(url).toBe(`https://busybox.net/downloads/busybox-${version}.tar.bz2`)
    expect(dockerfile).toContain('echo "${MICA_SOURCE_BUSYBOX_SHA256}  /busybox.tar.bz2" | sha256sum -c -')
    expect(dockerfile).toContain('FROM --platform=${MICA_BUILD_PLATFORM} ${MICA_BUILD_C_IMAGE} AS build')
    expect(dockerfile).toContain('armhf) export CROSS_COMPILE=arm-linux-gnueabihf- ;;')
    expect(dockerfile).not.toContain('./busybox')
    expect(readFileSync(join(REPO, 'debs/mica-busybox/config'), 'utf8')).toMatch(/^CONFIG_STATIC=y$/m)
    expect(readFileSync(join(REPO, 'debs/mica-busybox/control'), 'utf8')).not.toMatch(/^Depends:/m)
    expect(existsSync(join(REPO, 'debs/mica-busybox/inputs'))).toBe(false)
  })

  // Every applet of the shipped configuration, reached by plain name as a fallback:
  // one link each under /usr/libexec/busybox, named from the busybox.links the build writes from
  // that configuration (nothing built runs), so the set follows the config.
  test('mica-busybox links every applet under /usr/libexec/busybox, from the build\'s own list', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-busybox/Dockerfile'), 'utf8')
    expect(dockerfile).toContain('COPY --from=build /src/busybox /src/busybox.links /src/LICENSE /in/busybox/')
    expect(dockerfile).toContain('ln -s /usr/bin/busybox "/stage/usr/libexec/busybox/$applet"')
    // Under /usr, the image content: nothing at the root of the tree.
    expect(dockerfile).not.toMatch(/\/stage\/busybox\b/)
  })

  // Sourced by /etc/profile in every login shell, over SSH and on a getty alike,
  // whichever the init: /usr/libexec/busybox goes last, once.
  describe('mica-busybox\'s PATH', () => {
    const script = join(REPO, 'debs/mica-busybox/payload/etc/profile.d/mica-busybox.sh')
    const path = (initial: string, then = ''): string => {
      const ran = run(['sh', '-c', `. "$1"; . "$1"; ${then}printf %s "$PATH"`, 'sh', script], { PATH: initial })
      expect(ran.code).toBe(0)
      return ran.output
    }

    test('puts /usr/libexec/busybox last, once', () => {
      expect(path('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/libexec/busybox')
      expect(path('/usr/bin:/usr/libexec/busybox:/bin')).toBe('/usr/bin:/usr/libexec/busybox:/bin')
    })

    // ip of iproute2 (a full product's) resolves to the root's binary, not the applet.
    test('leaves every command the root ships ahead of the applets', () => {
      const sbin = mkdtempSync(join(tmpdir(), 'mica-busybox-path.'))
      try {
        writeFileSync(join(sbin, 'ip'), '#!/bin/sh\n')
        chmodSync(join(sbin, 'ip'), 0o755)
        expect(path(`${sbin}:/usr/bin:/bin`, 'command -v ip; ')).toBe(`${join(sbin, 'ip')}\n${sbin}:/usr/bin:/bin:/usr/libexec/busybox`)
      }
      finally {
        rmSync(sbin, { recursive: true, force: true })
      }
    })
  })

  // wpa_supplicant and hostapd are compiled from the upstream hostap release with nl80211 only,
  // libnl linked statically and OpenSSL for WPA2 and WPA3: nothing else is configured, and the
  // units keep the names and paths micad drives.
  describe.each([
    { name: 'mica-wifi', source: 'wpa-supplicant', archive: 'wpa_supplicant', bind: 'etc-wpa_supplicant', unit: 'usr/lib/systemd/system/wpa_supplicant@.service', libs: 'libc.so.6 | libcrypto.so.3 | libnl-3.so.200 | libnl-genl-3.so.200', config: ['CONFIG_AP=y', 'CONFIG_BACKEND=file', 'CONFIG_BGSCAN_SIMPLE=y', 'CONFIG_CTRL_IFACE=y', 'CONFIG_DRIVER_NL80211=y', 'CONFIG_GETRANDOM=y', 'CONFIG_LIBNL32=y', 'CONFIG_NO_CONFIG_BLOBS=y', 'CONFIG_SAE=y', 'CONFIG_TLS=openssl'] },
    { name: 'mica-wifi-ap', source: 'hostapd', archive: 'hostapd', bind: 'etc-hostapd', unit: 'usr/lib/systemd/system/hostapd@.service', libs: 'libc.so.6 | libm.so.6 | libcrypto.so.3 | libnl-3.so.200 | libnl-genl-3.so.200', config: ['CONFIG_ACS=y', 'CONFIG_CTRL_IFACE=y', 'CONFIG_DRIVER_NL80211=y', 'CONFIG_GETRANDOM=y', 'CONFIG_LIBNL32=y', 'CONFIG_NO_ACCOUNTING=y', 'CONFIG_NO_RADIUS=y', 'CONFIG_NO_VLAN=y', 'CONFIG_SAE=y', 'CONFIG_TLS=openssl'] },
  ])('$name', ({ name, source, archive, bind, unit, libs, config }) => {
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

    // libm is hostapd's, for ACS; it is libc6's like libc.
    test('refuses a binary that loads anything but libc, libcrypto and libnl', () => {
      expect(dockerfile()).toContain(`case "$lib" in ${libs}) ;;`)
    })

    // micad's automatic channel is hostapd's ACS (channel=acs_survey).
    test.if(name === 'mica-wifi-ap')('refuses a hostapd built without ACS', () => {
      expect(dockerfile()).toContain('grep -a -q \'ACS: Automatic channel selection started\' hostapd || { echo \'error: hostapd is built without ACS\'')
    })

    test('ships the unit micad drives', () => {
      expect(dockerfile()).toContain(`/stage/${unit}`)
    })

    // The root is read-only: systemd cannot create a bind's mount point there, so the
    // package that ships the STATE bind ships the directory it mounts over.
    test('ships the mount point of its STATE bind', () => {
      const where = /^Where=(\/etc\/\S+)$/m.exec(readFileSync(join(REPO, 'debs', name, `${bind}.mount`), 'utf8'))?.[1]
      expect(where).toBeDefined()
      expect(dockerfile()).toContain(`install -d -m 0755 /stage${where};`)
    })
  })

  test('the AP unit starts hostapd on the configuration micad renders', () => {
    const service = readFileSync(join(REPO, 'debs/mica-wifi-ap/hostapd@.service'), 'utf8')
    expect(service).toMatch(/^ExecStart=\/usr\/sbin\/hostapd -B -P \/run\/hostapd\.%i\.pid \/etc\/hostapd\/%i\.conf$/m)
    expect(service).toMatch(/^ConditionFileNotEmpty=\/etc\/hostapd\/%i\.conf$/m)
  })

  test('locks/upstream.pkgs does not pin Debian\'s wpasupplicant or hostapd', () => {
    const roots = readFileSync(join(REPO, 'locks/upstream.pkgs'), 'utf8').split('\n').map(line => line.replace(/#.*/, '').trim())
    expect(roots).not.toContain('wpasupplicant')
    expect(roots).not.toContain('hostapd')
  })
})

// armhf roots keep DATA in UBI: mica-storage-ubi, armhf only and carrying nothing but its
// copyright, provides the e2fsprogs and fdisk that mica-system and mica-openrc depend on.
test('mica-storage-ubi stands in for e2fsprogs and fdisk on armhf only', () => {
  expect(declared(REPO).find(entry => entry.name === 'mica-storage-ubi')).toMatchObject({ arches: ['armhf'], inputs: [], build: [], sources: [] })
  const control = readFileSync(join(REPO, 'debs/mica-storage-ubi/control'), 'utf8')
  expect(control).toMatch(/^Provides: e2fsprogs, fdisk$/m)
  expect(control).toMatch(/^Conflicts: e2fsprogs, fdisk$/m)
  expect(control).not.toMatch(/^Depends:/m)
  expect(readFileSync(join(REPO, 'debs/mica-system/control'), 'utf8')).toMatch(/^Depends: .*\be2fsprogs\b/m)
  expect(readFileSync(join(REPO, 'debs/mica-openrc/control'), 'utf8')).toMatch(/^Depends: .*\bfdisk\b/m)
  expect(existsSync(join(REPO, 'debs/mica-storage-ubi/payload'))).toBe(false)
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
  test('every package is maintained by Mica OS', () => {
    for (const entry of declared(REPO))
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toContain('\nMaintainer: Mica OS <hi@micaos.dev>\n')
  })
})

describe('the mica-system payload', () => {
  const payload = join(REPO, 'payload')

  test('carries no DEBIAN', () => {
    expect(existsSync(join(payload, 'DEBIAN'))).toBe(false)
  })

  // The floor has no init: nothing of either is in mica-system.
  test('carries nothing of an init, and nothing of SSH', () => {
    for (const path of ['etc/systemd', 'usr/lib/systemd', 'etc/init.d', 'etc/runlevels', 'usr/lib/mica/mica-init'])
      expect(existsSync(join(payload, path))).toBe(false)
    for (const ssh of ['etc/systemd/system/dropbear.service', 'usr/lib/mica/mica-dropbear-prestart'])
      expect(existsSync(join(payload, ssh))).toBe(false)
  })

  test('depends on the floor, on no init and on no option', () => {
    const depends = /^Depends: (.*)$/m.exec(readFileSync(join(REPO, 'debs/mica-system/control'), 'utf8'))?.[1] ?? ''
    expect(depends.split(', ')).toEqual(['dbus', 'passwd', 'e2fsprogs'])
    expect(readFileSync(join(REPO, 'debs/mica-system/postinst'), 'utf8')).toMatch(/^LOGIN_SHELL=\/bin\/sh$/m)
  })
})

describe('the mica-systemd payload', () => {
  const payload = join(REPO, 'debs/mica-systemd/payload')
  const entries = (directory: string): string[] => readdirSync(join(payload, directory), { recursive: true }).map(String)

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

  test('gives timesyncd the NTP servers micad saved on DATA, once /var/lib/mica is mounted', () => {
    expect(readlinkSync(join(payload, 'etc/systemd/timesyncd.conf.d/60-mica-servers.conf'))).toBe('/var/lib/mica/time/timesyncd.conf')
    expect(readFileSync(join(payload, 'etc/systemd/system/systemd-timesyncd.service.d/10-data.conf'), 'utf8')).toMatch(/^After=.*\bvar-lib-mica\.mount\b/m)
  })

  test('keeps the network and DNS micad configures on DATA, linked in before networkd and resolved start', () => {
    const lines = readFileSync(join(payload, 'usr/lib/tmpfiles.d/mica-network.conf'), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#'))
    expect(lines.map(l => l.split(/\s+/).filter(f => f !== '-').join(' '))).toEqual([
      'd /var/lib/mica/network/networkd 0755 root root',
      'L /run/systemd/network /var/lib/mica/network/networkd',
      'd /var/lib/mica/dns/resolved.conf.d 0755 root root',
      'L /run/systemd/resolved.conf.d /var/lib/mica/dns/resolved.conf.d',
    ])
    for (const unit of ['systemd-networkd', 'systemd-resolved']) {
      const conf = readFileSync(join(payload, `etc/systemd/system/${unit}.service.d/10-data.conf`), 'utf8')
      expect(conf).toMatch(/^After=.*\bvar-lib-mica\.mount\b/m)
      expect(conf).toMatch(/^After=.*\bsystemd-tmpfiles-setup\.service\b/m)
    }
  })

  test('disables nftables.service by preset', () => {
    expect(readFileSync(join(payload, 'usr/lib/systemd/system-preset/50-mica-nftables.preset'), 'utf8')).toBe('disable nftables.service\n')
    expect(readFileSync(join(REPO, 'debs/mica-systemd/postinst'), 'utf8')).toContain('NFT_LINK=/etc/systemd/system/sysinit.target.wants/nftables.service')
  })

  // The console is an option: no getty starts until login is installed.
  test('holds every getty until the console option installs login', () => {
    for (const unit of ['getty@', 'serial-getty@'])
      expect(readFileSync(join(payload, `etc/systemd/system/${unit}.service.d/10-mica-console.conf`), 'utf8')).toMatch(/^ConditionPathExists=\/usr\/bin\/login$/m)
  })

  // The first prompt carries micad's device code (/etc/issue.d): every getty starts
  // after micad, and never needs it, so a root without micad still gets a prompt.
  test('starts every getty after micad, without requiring it', () => {
    for (const unit of ['getty@', 'serial-getty@']) {
      const dropIn = readFileSync(join(payload, `etc/systemd/system/${unit}.service.d/10-mica-console.conf`), 'utf8')
      expect(dropIn).toMatch(/^After=micad\.service$/m)
      expect(dropIn).not.toMatch(/^(?:Requires|Wants|BindsTo)=/m)
    }
  })

  // The console policy of every board: tty1 never gets a getty, not even logind's
  // on-demand autovt (a mask, which no preset overrides); tty2 is the one login VT.
  test('masks getty@tty1 and gives logind one reserved VT, tty2', () => {
    expect(readlinkSync(join(payload, 'etc/systemd/system/getty@tty1.service'))).toBe('/dev/null')
    const logind = readFileSync(join(payload, 'etc/systemd/logind.conf.d/50-mica-console.conf'), 'utf8')
    expect(logind).toMatch(/^\[Login\]$/m)
    expect(logind).toMatch(/^NAutoVTs=0$/m)
    expect(logind).toMatch(/^ReserveVT=2$/m)
  })

  // systemd starts a unit attached to the console only once it holds the console's
  // lock, which a getty resetting a tty nothing reads never gives back: the gate and
  // the rollback write to the journal, and their scripts echo the verdict to the
  // console themselves, bounded.
  test('never attaches the health gate or the rollback to the console', () => {
    for (const unit of ['usr/lib/systemd/system/mica-health.service', 'etc/systemd/system/mica-boot-failure.service']) {
      const service = readFileSync(join(payload, unit), 'utf8')
      expect(service).toMatch(/^StandardOutput=journal$/m)
      expect(service).toMatch(/^StandardError=journal$/m)
      expect(service).not.toMatch(/console/i)
    }
  })

  // A device may run with no network at all: nothing waits for a link. With
  // wait-online masked (no preset re-enables a mask), network-online.target is
  // reached with network.target, and an offline boot leaves no failed unit.
  test('masks systemd-networkd-wait-online and pulls it in nowhere', () => {
    expect(readlinkSync(join(payload, 'etc/systemd/system/systemd-networkd-wait-online.service'))).toBe('/dev/null')
    expect(lstatExists(join(payload, 'etc/systemd/system/network-online.target.wants'))).toBe(false)
  })

  // Debian's quota left the floor; its units are nothing to mask.
  test('masks no unit of the quota package', () => {
    for (const unit of ['quota', 'quotacheck', 'rpc-rquotad'])
      expect(lstatExists(join(payload, `etc/systemd/system/${unit}.service`))).toBe(false)
  })

  // The systemd half: the init, and mica-system under it.
  test('depends on mica-system and the systemd stack, and provides the init', () => {
    const control = readFileSync(join(REPO, 'debs/mica-systemd/control'), 'utf8')
    expect(/^Depends: (.*)$/m.exec(control)?.[1]?.split(', ')).toEqual(['mica-system', 'systemd', 'systemd-sysv', 'systemd-resolved', 'systemd-repart', 'systemd-timesyncd', 'udev'])
    expect(control).toMatch(/^Provides: mica-init-system$/m)
    expect(existsSync(join(payload, 'usr/lib/mica/mica-init'))).toBe(true)
  })
})

describe('the mica-openrc payload', () => {
  const payload = join(REPO, 'debs/mica-openrc/payload')
  const mdev = join(REPO, 'debs/mica-mdev/payload')
  const scripts = [...readdirSync(join(payload, 'etc/init.d')).map(name => join(payload, 'etc/init.d', name)), join(mdev, 'etc/init.d/mica-mdev')]

  test('every service is an executable openrc-run script that parses as sh', () => {
    for (const script of scripts) {
      expect(readFileSync(script, 'utf8')).toStartWith('#!/sbin/openrc-run\n')
      expect(lstatSync(script).mode & 0o111).toBe(0o111)
      expect(run(['sh', '-n', script]).code).toBe(0)
    }
    for (const helper of ['mica-init', 'mica-grow-data', 'mica-udhcpc'])
      expect(run(['sh', '-n', join(payload, 'usr/lib/mica', helper)]).code).toBe(0)
  })

  // Membership of a runlevel is payload, as enablement is in mica-systemd.
  test('links every runlevel member to a service mica-openrc or mica-mdev ships', () => {
    const names = scripts.map(script => script.split('/').at(-1))
    for (const runlevel of ['sysinit', 'boot', 'default']) {
      for (const link of readdirSync(join(payload, 'etc/runlevels', runlevel))) {
        expect(readlinkSync(join(payload, 'etc/runlevels', runlevel, link))).toBe(`/etc/init.d/${link}`)
        expect(names).toContain(link)
      }
    }
    expect(readlinkSync(join(payload, 'usr/sbin/init'))).toBe('openrc-init')
    expect(readlinkSync(join(payload, 'etc/resolv.conf'))).toBe('../run/mica/resolv.conf')
    // What systemd's tmpfiles give the other root: /etc/mtab, which mount and e2fsck read.
    expect(readlinkSync(join(payload, 'etc/mtab'))).toBe('../proc/self/mounts')
    // The RAM log mica-syslogd keeps, read by micad.
    expect(readlinkSync(join(payload, 'usr/bin/logread'))).toBe('busybox')
    // The network is /etc/network/interfaces on DATA, applied by busybox's ifupdown.
    expect(readlinkSync(join(payload, 'etc/network/interfaces'))).toBe('../../var/lib/mica/network/interfaces')
    for (const tool of ['ifup', 'ifdown', 'ip', 'udhcpc'])
      expect(readlinkSync(join(payload, 'usr/sbin', tool))).toBe('../bin/busybox')
  })

  // Each package carries its own services for both inits, and no other package's.
  test('ships no service of another package', () => {
    for (const service of ['micad', 'apid', 'mica-mqttd', 'mica-mqtt-broker', 'mica-bluetoothd'])
      expect(existsSync(join(payload, 'etc/init.d', service))).toBe(false)
  })

  test('depends on mica-system, mdev, openrc and fdisk, and excludes systemd', () => {
    const control = readFileSync(join(REPO, 'debs/mica-openrc/control'), 'utf8')
    expect(/^Depends: (.*)$/m.exec(control)?.[1]?.split(', ')).toEqual(['mica-system', 'mica-mdev', 'openrc', 'fdisk'])
    expect(control).toMatch(/^Provides: mica-init-system$/m)
    expect(/^Conflicts: (.*)$/m.exec(control)?.[1]?.split(', ')).toEqual(['mica-systemd', 'systemd-sysv', 'udev', 'ifupdown', 'ifupdown-ng', 'iproute2', 'udhcpc', 'busybox-syslogd'])
  })

  // Every group mdev.conf gives a node exists in the floor: base-passwd's static
  // groups or config/ids.json's pinned ones.
  test('mdev gives nodes only groups the floor has', () => {
    const pinned = (JSON.parse(readFileSync(join(REPO, 'config/ids.json'), 'utf8')) as { groups: { name: string }[] }).groups.map(group => group.name)
    const floor = new Set([...pinned, 'root', 'kmem', 'tty', 'disk', 'dialout', 'cdrom', 'audio', 'video'])
    const groups = readFileSync(join(mdev, 'etc/mdev.conf'), 'utf8').split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => /\s\S+:(\S+)\s+0[0-7]{3}/.exec(line)?.[1] ?? '(none)')
    expect(groups.filter(group => !floor.has(group))).toEqual([])
  })
})

// micad drives the option packages under OpenRC through these, as it drives their
// systemd units; each package carries its own, inert on a systemd root.
describe('the option packages\' OpenRC scripts', () => {
  test.each([
    ['mica-ssh', 'mica-dropbear'],
    ['mica-ssh', 'mica-sshd'],
    ['mica-ssh', 'mica-sshd-boot'],
    ['mica-openssh', 'mica-sshd'],
    ['mica-openssh', 'mica-sshd-boot'],
    ['mica-wifi', 'mica-wifi-client'],
    ['mica-wifi-ap', 'mica-wifi-ap'],
  ])('%s installs /etc/init.d/%s, an openrc-run script that parses as sh', (name, service) => {
    const script = join(REPO, 'debs', name, `${service}.openrc`)
    expect(readFileSync(script, 'utf8')).toStartWith('#!/sbin/openrc-run\n')
    expect(run(['sh', '-n', script]).code).toBe(0)
    expect(readFileSync(join(REPO, 'debs', name, 'Dockerfile'), 'utf8')).toMatch(new RegExp(`install -D -m 0755 \\S+/${service}\\.openrc /stage/etc/init\\.d/${service};`))
  })
})

// Bluetooth as an option, for both inits: the HCI attach and the pairing keys on STATE.
// The UART, protocol and speed (/etc/mica/bt.conf), modules and firmware are the board's.
describe('mica-bluetooth', () => {
  const payload = join(REPO, 'debs/mica-bluetooth/payload')

  test('depends on bluez and rfkill', () => {
    const control = readFileSync(join(REPO, 'debs/mica-bluetooth/control'), 'utf8')
    expect(/^Depends: (.*)$/m.exec(control)?.[1]?.split(', ')).toEqual(['bluez', 'rfkill'])
  })

  test('under systemd: the attach unit and the pairing-key bind, enabled as payload', () => {
    expect(readFileSync(join(payload, 'usr/lib/systemd/system/mica-bt.service'), 'utf8')).toContain('ConditionPathExists=/etc/mica/bt.conf')
    expect(readlinkSync(join(payload, 'etc/systemd/system/multi-user.target.wants/mica-bt.service'))).toBe('/usr/lib/systemd/system/mica-bt.service')
    expect(readFileSync(join(payload, 'etc/systemd/system/var-lib-bluetooth.mount'), 'utf8')).toContain('What=/mnt/data/state/bluetooth')
    expect(readlinkSync(join(payload, 'etc/systemd/system/local-fs.target.wants/var-lib-bluetooth.mount'))).toBe('/etc/systemd/system/var-lib-bluetooth.mount')
    expect(run(['sh', '-n', join(payload, 'usr/lib/mica/hwinit-bt')]).code).toBe(0)
  })

  test('under OpenRC: mica-bt and mica-bluetoothd, openrc-run scripts in no runlevel', () => {
    for (const service of ['mica-bt', 'mica-bluetoothd']) {
      const script = join(payload, 'etc/init.d', service)
      expect(readFileSync(script, 'utf8')).toStartWith('#!/sbin/openrc-run\n')
      expect(lstatSync(script).mode & 0o111).toBe(0o111)
      expect(run(['sh', '-n', script]).code).toBe(0)
    }
    expect(existsSync(join(payload, 'etc/runlevels'))).toBe(false)
    expect(readFileSync(join(payload, 'etc/init.d/mica-bluetoothd'), 'utf8')).toContain('/mnt/data/state/bluetooth /var/lib/bluetooth')
  })

  // /etc/bluetooth/main.conf is bluez's conffile; bluetoothd reads this package's
  // file instead, under both inits: LE connection intervals of 11.25-15 ms.
  test('bluetoothd runs with -f /usr/lib/mica/bluetooth/main.conf, LE interval 9-12', () => {
    const config = readFileSync(join(payload, 'usr/lib/mica/bluetooth/main.conf'), 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
    expect(config).toEqual(['[LE]', 'MinConnectionInterval=9', 'MaxConnectionInterval=12'])
    expect(existsSync(join(payload, 'etc/bluetooth'))).toBe(false)
    expect(readFileSync(join(payload, 'usr/lib/systemd/system/bluetooth.service.d/mica.conf'), 'utf8').split('\n').filter(line => line.startsWith('ExecStart='))).toEqual([
      'ExecStart=',
      'ExecStart=/usr/libexec/bluetooth/bluetoothd -f /usr/lib/mica/bluetooth/main.conf',
    ])
    expect(readFileSync(join(payload, 'etc/init.d/mica-bluetoothd'), 'utf8')).toContain('command_args="-n -f /usr/lib/mica/bluetooth/main.conf"')
  })
})

describe('mica-ssh', () => {
  const directory = join(REPO, 'debs/mica-ssh')

  test('carries SSH: dropbear, its units, prestarts and presets, on top of mica-system', () => {
    const control = readFileSync(join(directory, 'control'), 'utf8')
    const depends = /^Depends: (.*)$/m.exec(control)?.[1] ?? ''
    expect(depends.split(', ')).toEqual(['dropbear-bin', 'mica-system'])
    expect(depends).not.toMatch(/openssh/)
    expect(readFileSync(join(directory, '50-mica-dropbear.preset'), 'utf8')).toBe('disable dropbear.service\n')
    for (const file of ['dropbear.service', 'mica-dropbear-prestart', 'mica-sshd.service', 'mica-sshd-prestart'])
      expect(existsSync(join(directory, file))).toBe(true)
  })

  // One SSH server per root: the two packages ship the same mica-sshd paths, which
  // the pool gate allows only between packages that conflict with each other.
  test('conflicts with mica-openssh, both providing mica-ssh-server', () => {
    for (const [name, other] of [['mica-ssh', 'mica-openssh'], ['mica-openssh', 'mica-ssh']]) {
      const control = readFileSync(join(REPO, 'debs', name!, 'control'), 'utf8')
      expect(control).toMatch(new RegExp(`^Conflicts: ${other}$`, 'm'))
      expect(control).toMatch(/^Provides: mica-ssh-server$/m)
      expect(control).not.toMatch(/^Replaces:/m)
    }
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

describe('mica-openssh', () => {
  const directory = join(REPO, 'debs/mica-openssh')

  // The Debian packages need debconf, ucf and systemd's sysusers: their binaries
  // are payload, built for each architecture out of the pinned archives.
  test('carries sshd, sshd-session, sshd-auth and ssh-keygen of the pinned OpenSSH, with their libraries in Depends', () => {
    expect(declared(REPO).find(entry => entry.name === 'mica-openssh')).toMatchObject({ arches: ['amd64', 'arm64', 'armhf'], inputs: ['openssh-server', 'openssh-client'] })
    const control = readFileSync(join(directory, 'control'), 'utf8')
    const server = selectInputs(REPO, 'amd64').find(row => row.name === 'openssh-server')!
    expect(control).toMatch(new RegExp(`^Version: ${server.version.replace(/^\d+:/, '').replace(/-[^-]*$/, '').replaceAll('.', '\\.')}-mica\\d+$`, 'm'))
    const depends = (/^Depends: (.*)$/m.exec(control)?.[1] ?? '').split(', ')
    expect(depends).toEqual(['mica-system', 'libaudit1', 'libcom-err2', 'libcrypt1', 'libgssapi-krb5-2', 'libkrb5-3', 'libpam0g', 'libselinux1', 'libssl3t64', 'libwrap0', 'libwtmpdb0', 'zlib1g'])
    expect(depends.filter(name => name.startsWith('openssh'))).toEqual([])
    const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')
    for (const path of ['/stage/usr/sbin/sshd', '/stage/usr/lib/openssh/sshd-session', '/stage/usr/lib/openssh/sshd-auth', '/stage/usr/bin/ssh-keygen'])
      expect(dockerfile).toContain(` ${path};`)
    expect(dockerfile).toContain('which no Depends of debs/mica-openssh/control provides')
    // No client, no /etc/ssh and no sftp-server: SFTP is the root's /usr/lib/sftp-server.
    for (const absent of [' /stage/usr/bin/ssh;', '/stage/etc/ssh', '/stage/usr/lib/openssh/sftp-server'])
      expect(dockerfile).not.toContain(absent)
  })

  // Every library a pinned binary needs is a Depends, and every Depends a library a
  // root can install: a row of the release.
  test.each(['amd64', 'arm64', 'armhf'] as const)('%s: its libraries are pinned for later stages', (arch) => {
    const control = readFileSync(join(directory, 'control'), 'utf8')
    const rows = selectRuntime(REPO, arch, { kind: 'all' }).map(row => row.name)
    for (const name of (/^Depends: (.*)$/m.exec(control)?.[1] ?? '').split(', ').filter(name => name !== 'mica-system'))
      expect(rows).toContain(name)
  })

  test('adds the sshd account, uid 22', () => {
    const postinst = readFileSync(join(directory, 'postinst'), 'utf8')
    expect(postinst).toContain('ENTRY="${NAME}:x:${ID}:65534:OpenSSH privilege separation:/run/sshd:/usr/sbin/nologin"')
    expect(postinst).toMatch(/^ID=22$/m)
    expect(postinst).not.toContain('multi-user.target.wants/mica-sshd.service')
    expect(run(['sh', '-n', join(directory, 'postinst')]).code).toBe(0)
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
    // mica-build-tools docs/spec/build-rules.md section 6 refuses Replaces; a device never upgrades a package in place.
    expect(control).not.toMatch(/^Replaces:/m)
    expect(existsSync(join(directory, 'postinst'))).toBe(false)
  })
})

// Under `set -o pipefail`, an early-exiting reader on the right of a pipe (head,
// grep -q/-m, sed -n Nq, read) fails the pipeline when the producer dies of
// SIGPIPE, so the test passes or fails by where the match sits. No script here
// enables pipefail; a script that does may not pipe into such a reader, and
// mica-health and the busybox build do not pipe into one at all.
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
  // mica-health and the busybox build are held free of the shape, pipefail or not.
  for (const path of ['payload/usr/lib/mica/mica-health', 'debs/mica-busybox/Dockerfile'])
    expect(readFileSync(join(REPO, path), 'utf8').split('\n').filter(line => early.test(line))).toEqual([])
  // The guard sees the shape: a script with pipefail and such a pipe is refused.
  expect(early.test('printf \'%s\\n\' "$x" | grep -qx y')).toBe(true)
  expect(early.test('sed -n "s/^a=//p" "$f" | head -n1')).toBe(true)
  expect(early.test('dpkg-deb --fsys-tarfile "$1" | tar -tf -')).toBe(false)
})
