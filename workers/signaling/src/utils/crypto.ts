const ITERATIONS = 100000;
const KEY_LEN_BYTES = 32;

function buf2hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hex2buf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedKey = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN_BYTES * 8,
  );

  const saltHex = buf2hex(salt.buffer);
  const hashHex = buf2hex(derivedKey);

  return `$pbkdf2$v=1$i=${ITERATIONS}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(
  password: string,
  serializedHash: string,
): Promise<boolean> {
  const parts = serializedHash.split('$');
  if (parts.length !== 6 || parts[1] !== 'pbkdf2' || parts[2] !== 'v=1') {
    return false;
  }

  const iterations = parseInt(parts[3]?.replace('i=', '') ?? '', 10);
  const saltHex = parts[4];
  const targetHashHex = parts[5];

  // Guard the iteration count as well as the hex fields: a stored hash with a
  // non-numeric or absurd `i=` would otherwise reach `deriveBits` and throw
  // (or hang) instead of cleanly failing verification.
  if (
    !iterations ||
    iterations < 1 ||
    iterations > 4294967295 ||
    !saltHex ||
    !targetHashHex
  ) {
    return false;
  }

  const salt = hex2buf(saltHex);
  const targetBytes = hex2buf(targetHashHex);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const computedKey = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN_BYTES * 8,
  );

  const computedBytes = new Uint8Array(computedKey);

  if (computedBytes.length !== targetBytes.length) {
    return false;
  }

  // Constant-time XOR comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < computedBytes.length; i++) {
    diff |= (computedBytes[i] ?? 0) ^ (targetBytes[i] ?? 0);
  }

  return diff === 0;
}
