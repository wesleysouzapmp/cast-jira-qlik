import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

function derive(pw, salt) {
  return new Promise((resolve, reject) => {
    scrypt(String(pw), salt, KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = await derive(pw, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (!salt.length || expected.length !== KEYLEN) return false;
  const actual = await derive(pw, salt);
  return timingSafeEqual(actual, expected);
}
