import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

/**
 * Decrypt and verify a web-push request the way a browser's push service would.
 *
 * This exists because the one failure mode that genuinely cannot be noticed until the
 * day is a broken crypto chain. A wrong VAPID signature, a payload that does not
 * decrypt, a bad content encoding -- every one of those results in the push service
 * quietly dropping the request, the admin panel cheerfully reporting success, and
 * nobody discovering it until the event is half over with people saying they were
 * never told.
 *
 * The only way to rule that out is to open one up.
 */

/**
 * The DER prefix of an uncompressed P-256 SPKI key, which is a fixed 26 bytes.
 *
 * Needed because `createPublicKey` will not take a bare 65-byte point, and that is
 * the only form a push body's `keyid` arrives in.
 */
const P256_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex',
)

/**
 * A recipient: the keypair whose public half is the `p256dh` a browser would send.
 *
 * Generated through `createECDH` rather than `generateKeyPairSync` because this needs
 * the raw 32-byte private scalar as well as the public point. `generateKeyPairSync`
 * hands back DER and JWK encodings that would each have to be unpacked again here,
 * which is work with no bearing on what is being tested.
 */
export function makeRecipient() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()

  return {
    privateScalar: ecdh.getPrivateKey(),
    // Uncompressed, base64url, exactly as `PushSubscription.toJSON()` reports it.
    p256dh: ecdh.getPublicKey().toString('base64url'),
    // 16 bytes. In a real subscription the browser generates this and sends it as
    // `keys.auth`; it is half of the secret the payload is encrypted with.
    auth: randomBytes(16).toString('base64url'),
  }
}

/**
 * Recover the plaintext of an `aes128gcm` push body.
 *
 * The body layout is the part that is genuinely hard to guess, and it is worth
 * writing down because it cost two wrong turns:
 *
 *   salt      16 bytes
 *   rs        4 bytes, big-endian -- the record size, 4096 here
 *   keyidLen  1 byte -- 65, for an uncompressed P-256 point
 *   keyid     the SENDER's ephemeral public key, carried IN THE BODY
 *   record    ciphertext, then 1 padding byte, then the 16-byte GCM tag
 *
 * Two things send you down the wrong path, and both cost time here:
 *
 *  - The sender's key is in the body, not in a header. web-push emits `Encryption`
 *    and `Crypto-Key` only for the LEGACY `aesgcm` encoding. For `aes128gcm` — which
 *    is what it uses by default — there are no such headers at all.
 *  - The salt is not prepended separately from the record. Header and record are one
 *    contiguous thing, and slicing "the first 16 bytes" off the ciphertext lands in
 *    the middle of a point.
 *
 * Then, per RFC 8188:
 *   key       = HKDF(sha256, ECDH(our private, sender keyid), salt, "Content-Encoding\0auth\0", 16)
 *   AAD       = "P-256\0" + our p256dh + "Content-Encoding\0aes128gcm\0"
 *   plaintext = AES-128-GCM(record minus tag minus pad byte, key, nonce 0, AAD)
 *
 * The trailing padding byte is dropped: it records how much padding there was, and
 * leaving it on would put a stray `0x01` at the end of the JSON.
 */
export function decrypt(recipient, body) {
  const keyidLength = body[20]
  const recordStart = 21 + keyidLength
  const senderPoint = body.subarray(21, recordStart)
  const salt = body.subarray(0, 16)
  const record = body.subarray(recordStart)

  // Ciphertext + 1 padding byte + a 16-byte tag is the smallest possible record.
  if (record.length < 17) throw new Error('record is too short to contain a tag')

  /*
    The other half of the ECDH, from OUR private key.

    `createECDH` and nothing wrapped around it, because this must be the raw shared X
    coordinate -- that is exactly what feeds the HKDF below. Hashing it here would
    derive a different key, and the failure would then look like a corrupt payload
    rather than a bug in this function.

    The other key is passed as the bare 65-byte point rather than a KeyObject:
    `computeSecret` rejects a PublicKeyObject outright, and unpacking one here would
    only add a way to get the bytes wrong.
  */
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(recipient.privateScalar)
  const shared = ecdh.computeSecret(senderPoint)

/*
    Key derivation. Three calls, and the shape is not the one RFC 8188 - or most
    write-ups - describe. The body layout above is spelled out for the same reason.

      1. HKDF(salt = the auth secret, ikm = the ECDH secret,
             info = "WebPush: info" NUL + receiver public key + sender public key)
         -> 32 bytes.

      2. HKDF(salt = THE RECORD SALT from the body header, ikm = the result of 1,
             info = "Content-Encoding: aes128gcm" NUL)  -> 16 bytes: the AES key.

      3. The same, with info "Content-Encoding: nonce" NUL -> 12 bytes: the nonce.

    THE ONE THAT BITES: there is no "Content-Encoding: auth" step.

    http_ece does have an auth-secret HKDF, and it is very easy to assume aes128gcm
    passes through it. It does not - for that version the chain runs straight from the
    "WebPush: info" derivation into the record-salted expand. Adding the auth step
    yields a key wrong in every byte and a GCM error that reads like a corrupt payload
    rather than a mis-derived key, which is where several wrong turns ended up.

    The record salt is not decorative either. It is what binds the key to THIS record,
    and step 1 is the only part that does not use it.

    The info strings are http_ece's, not RFC 8188's: a colon and a space, so
    "Content-Encoding: aes128gcm" NUL rather than "Content-Encoding" NUL
    "aes128gcm" NUL. Almost every explanation of web push quotes the RFC spelling, and
    it is wrong for this library.
  */
  const authSecret = Buffer.from(recipient.auth, 'base64url')

  const stage1 = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      authSecret,
      Buffer.concat([
        Buffer.from('WebPush: info\0', 'utf8'),
        Buffer.from(recipient.p256dh, 'base64url'),
        senderPoint,
      ]),
      32,
    ),
  )

  const key = hkdfSync(
    'sha256',
    stage1,
    salt,
    Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'),
    16,
  )
  const nonce = hkdfSync(
    'sha256',
    stage1,
    salt,
    Buffer.from('Content-Encoding: nonce\0', 'ascii'),
    12,
  )

  /*
    The record is ciphertext + 1 encrypted padding byte + a 16-byte tag. The padding
    byte goes through the cipher before the tag is computed, so the split removes the
    tag only and the padding byte is stripped from the plaintext afterwards. Cutting
    17 bytes here throws away the last byte of ciphertext and shifts everything, which
    surfaces as an authentication failure rather than as an off-by-one.
  */
  const ciphertext = record.subarray(0, record.length - 16)
  const tag = record.subarray(record.length - 16)

  /*
    No additional authenticated data.

    RFC 8188 defines a context string and it is tempting to hand it to setAAD, but
    http_ece never does - the context is not authenticated, and passing it fails every
    single decrypt because the tag was computed without it.
  */
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return plaintext.subarray(0, plaintext.length - 1)
}
/**
 * Verify a VAPID `Authorization` header the way a push service does.
 *
 * The header is `vapid t=<jwt>, k=<public key>`. The service checks the JWT's ES256
 * signature against the application server key it was configured with, then `aud`,
 * `exp` and `sub`. If any of that is wrong the request is rejected outright and
 * nothing comes back to say why.
 *
 * The signature is genuinely verified rather than the token merely decoded. A test
 * that decoded without checking would pass just as happily with a completely wrong
 * key, which is the whole failure this is here to catch.
 */
export function verifyVapid(authorization, publicKey) {
  const token = /vapid\s+t=([^,\s]+),\s*k=([^\s]+)/.exec(authorization ?? '')
  if (!token) throw new Error('no VAPID token in the Authorization header')

  const [, jwt, declaredKey] = token
  const [header, payload, signature] = jwt.split('.')

  const headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))

  // The signed input is the header and payload exactly as they appear on the wire.
  const verifier = createVerify('sha256')
  verifier.update(Buffer.from(`${header}.${payload}`, 'ascii'))
  verifier.end()

  const signatureValid = verifier.verify(
    {
      key: createPublicKey({
        key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(declaredKey, 'base64url')]),
        format: 'der',
        type: 'spki',
      }),
      // ES256 signatures are r||s in raw form, not the DER sequence OpenSSL emits.
      dsaEncoding: 'ieee-p1363',
    },
    Buffer.from(signature, 'base64url'),
  )

  return {
    header: headerJson,
    claims,
    signatureValid,
    // The token must carry the key it claims, or a push service configured with a
    // different public key would reject it on sight.
    keyMatchesConfig: declaredKey === publicKey,
    ttlSeconds: claims.exp - Math.floor(Date.now() / 1000),
  }
}
