// The packer as a command, for a package's Dockerfile:
//
//   bun /tooling/debs/pack-cli.ts --stage DIR --control FILE --out DIR
//       [--postinst FILE] [--substitute NAME=VALUE]...
//
// The architecture, the repository and the epoch come from the build arguments
// every package Dockerfile declares: MICA_DEB_ARCH, MICA_DEB_SOURCE_REPO and
// SOURCE_DATE_EPOCH, which must be the epoch the control template declares; the
// version is the template's own.
import type { PackRequest } from './pack.ts'
import { readFileSync } from 'node:fs'
import { fail, report } from '../errors.ts'
import { declaration, pack } from './pack.ts'

async function main(argv: string[]): Promise<void> {
  const values = new Map<string, string>()
  const substitutions: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const [option = '', value] = [argv[index], argv[index + 1]]
    if (value === undefined)
      fail(`${option} requires a value`)
    if (option === '--substitute') {
      const at = value.indexOf('=')
      if (at < 1)
        fail(`--substitute takes NAME=VALUE, not ${value}`)
      substitutions[value.slice(0, at)] = value.slice(at + 1)
    }
    else if (['--stage', '--control', '--out', '--postinst'].includes(option)) {
      values.set(option, value)
    }
    else {
      fail(`unknown option: ${option}`)
    }
  }
  const env = process.env
  const arch = env.MICA_DEB_ARCH ?? ''
  if (!['amd64', 'arm64', 'all'].includes(arch))
    fail(`MICA_DEB_ARCH='${arch}' is not amd64, arm64 or all`)
  for (const required of ['--stage', '--control', '--out']) {
    if (!values.get(required))
      fail(`${required} is required`)
  }
  const { epoch } = declaration(readFileSync(values.get('--control')!, 'utf8'), values.get('--control')!)
  if (env.SOURCE_DATE_EPOCH !== String(epoch))
    fail(`SOURCE_DATE_EPOCH='${env.SOURCE_DATE_EPOCH ?? ''}' is not the ${epoch} ${values.get('--control')} declares`)
  const request: PackRequest = {
    stage: values.get('--stage')!,
    control: values.get('--control')!,
    arch: arch as PackRequest['arch'],
    out: values.get('--out')!,
    repository: env.MICA_DEB_SOURCE_REPO ?? '',
    substitutions,
  }
  const postinst = values.get('--postinst')
  if (postinst)
    request.scripts = { postinst }
  console.log(`pack: ${await pack(request)}`)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
