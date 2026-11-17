import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
export const PASSWORD_OPTIONS = { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 }

export function parsePasswordHash(value) {
  if (typeof value !== 'string') throw new Error('Missing password hash')
  const parts = value.split('$')
  if (
    parts.length !== 6 || parts[0] !== 'scrypt' ||
    parts[1] !== '65536' || parts[2] !== '8' || parts[3] !== '2' ||
    !/^[a-f0-9]{64}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])
  ) throw new Error('Unsupported password hash; run deploy/setup-auth.py')
  return { salt: Buffer.from(parts[4], 'hex'), key: Buffer.from(parts[5], 'hex') }
}

export async function verifyPassword(password, encoded) {
  const { salt, key } = parsePasswordHash(encoded)
  const actual = await scrypt(password, salt, key.length, PASSWORD_OPTIONS)
  return timingSafeEqual(actual, key)
}
