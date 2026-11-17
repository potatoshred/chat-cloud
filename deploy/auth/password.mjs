import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
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
  ) throw new Error('Unsupported password hash')
  return { salt: Buffer.from(parts[4], 'hex'), key: Buffer.from(parts[5], 'hex') }
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || Array.from(password).length < 14 || password.length > 256 || !password.trim()) {
    throw new Error('AUTH_PASSWORD must contain 14–256 characters and cannot be blank')
  }
  const salt = randomBytes(32)
  const key = await scrypt(password, salt, 64, PASSWORD_OPTIONS)
  return `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, encoded) {
  const { salt, key } = parsePasswordHash(encoded)
  const actual = await scrypt(password, salt, key.length, PASSWORD_OPTIONS)
  return timingSafeEqual(actual, key)
}
