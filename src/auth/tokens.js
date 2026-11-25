import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
