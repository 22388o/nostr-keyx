#!/usr/local/bin/node

// SPDX-FileCopyrightText: 2023 Susumu OTA <1632335+susumuota@users.noreply.github.com>
// SPDX-License-Identifier: MIT

// Set shebang line to the path to node.
// If you use node installed by Homebrew, your shebang line should be:
//   #!/usr/local/bin/node
//
// If you use node installed by nodebrew, use absolute path (no tilde)
//   #!/Users/username/.nodebrew/current/bin/node
//
// If you prefer to use `env`,
//   #!/usr/bin/env node
// But you may need to open Chrome from Terminal to make it work instead of Dock launcher.
//   open -a /Applications/Google\ Chrome.app
//
// Run `which node` to find the path to node.
// But make sure whether it can be accessible from Chrome.app.

// https://developer.chrome.com/docs/apps/nativeMessaging/
// https://dev.classmethod.jp/articles/chrome-native-message/


import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

import * as secp from '@noble/secp256k1';
import { bech32, base64 } from '@scure/base';


// Event object.
// https://github.com/nostr-protocol/nips/blob/master/01.md#events-and-signatures
type Event = {
  id?: string,
  sig?: string,
  kind: number,
  tags: string[][],
  pubkey: string,
  content: string,
  created_at: number
}

const SERVICE_NAME = 'nostr-keyx';
const BECH32_MAX_SIZE = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const getBech32PrivateKey = (account: string) => {
  // TODO: needs to sanitize account?
  return spawnSync('security', ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w']).stdout.toString().trim();
};

const getPrivateKey = (account: string) => {
  // try to avoid showing the private key in error message.
  if (!account) throw new Error('Account was not specified.');
  let bech32PrivateKey: string;
  try {
    bech32PrivateKey = getBech32PrivateKey(account);
  } catch (err) {
    throw new Error('Failed to access keychain.');
  }
  if (!bech32PrivateKey) throw new Error('Private key was not found.');
  if (bech32PrivateKey.length !== 63) throw new Error('Invalid private key length. It should be 63 characters.');
  try {
    let { words } = bech32.decode(bech32PrivateKey, BECH32_MAX_SIZE);
    return secp.utils.bytesToHex(bech32.fromWords(words));
  } catch (err) {
    throw new Error('Failed to beck32 decode private key.');
  }
};

const publicKeyCache = new Map<string, string>();

const getPublicKey = (account: string) => {
  if (publicKeyCache.has(account)) return publicKeyCache.get(account);
  const privateKey = getPrivateKey(account);
  try {
    const publicKey = secp.utils.bytesToHex(secp.schnorr.getPublicKey(privateKey));
    publicKeyCache.set(account, publicKey);
    return publicKey;
  } catch (err) {
    throw new Error('Failed to calculate public key.');
  }
};

// NIP-04 encryption for direct messages.
// https://github.com/nostr-protocol/nips/blob/master/04.md
// https://github.com/nbd-wtf/nostr-tools/blob/master/nip04.ts
const nip04encrypt = async (privkey: string, pubkey: string, text: string) => {
  const key = secp.getSharedSecret(privkey, '02' + pubkey);
  const normalizedKey = key.slice(1, 33);
  const iv = Uint8Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const plaintext = encoder.encode(text);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', normalizedKey, { name: 'AES-CBC' }, false, ['encrypt']
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv }, cryptoKey, plaintext
  );
  const ctb64 = base64.encode(new Uint8Array(ciphertext));
  const ivb64 = base64.encode(new Uint8Array(iv.buffer));
  return `${ctb64}?iv=${ivb64}`;
};

// NIP-04 decryption for direct messages.
// https://github.com/nostr-protocol/nips/blob/master/04.md
// https://github.com/nbd-wtf/nostr-tools/blob/master/nip04.ts
const nip04decrypt = async (privkey: string, pubkey: string, data: string) => {
  const [ctb64, ivb64] = data.split('?iv=');
  if (!ctb64 || !ivb64) throw new Error('invalid data');
  const key = secp.getSharedSecret(privkey, '02' + pubkey)
  const normalizedKey = key.slice(1, 33);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', normalizedKey, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const ciphertext = base64.decode(ctb64);
  const iv = base64.decode(ivb64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, cryptoKey, ciphertext
  );
  return decoder.decode(plaintext);
};

// read message from stdin
const receiveMessage = () => {
  const chunks: Buffer[] = [];
  let chunk: Buffer;
  // TODO: should treat first 4 bytes as body length
  // because 2+ different messages may be sent at once without null
  while (null !== (chunk = process.stdin.read())) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const bodyLength = input.readUInt32LE(0); // first 4 bytes are body length
  const body = input.subarray(4, bodyLength + 4);
  if (body.length !== bodyLength) {
    log({ 'message': 'if this happen, need to fix while loop', 'body.length': body.length, 'bodyLength': bodyLength });
  }
  return JSON.parse(body.toString());
}

// write message to stdout
const sendMessage = (message: any) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); // first 4 bytes are body length
  process.stdout.write(Buffer.concat([header, body]))
};

// message handler
const handleMessage = async (request: any) => {
  const { id, type, arg, account } = request;
  // log({ request });
  const responseType = [...type].reverse().join(''); // see inject.ts

  // NIP-07 APIs
  // TODO: try to avoid showing the private key in error message.
  try {
    if (type === 'getPublicKey') {
      sendMessage({ id, type: responseType, result: getPublicKey(account) });
    } else if (type === 'signEvent') {
      const { event }: { event: Event } = arg;
      // not necessary to fix pubkey and id here but it is for nos2x compatibility
      event.pubkey = event.pubkey ?? getPublicKey(account); // nos2x compatibility
      if (!event.id) {
        const json = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
        event.id = secp.utils.bytesToHex(await secp.utils.sha256(encoder.encode(json))); // nos2x compatibility
      }
      event.sig = secp.utils.bytesToHex(await secp.schnorr.sign(event.id, getPrivateKey(account)));
      // console.assert(await secp.schnorr.verify(event.sig, event.id, event.pubkey));
      sendMessage({ id, type: responseType, result: event });
    } else if (type === 'getRelays') {
      sendMessage({ id, type: responseType, result: {} }) // TODO: implement relays
    } else if (type === 'nip04.encrypt') {
      const { pubkey, plaintext }: { pubkey: string, plaintext: string } = arg;
      const ciphertext = await nip04encrypt(getPrivateKey(account), pubkey, plaintext);
      console.assert(plaintext === await nip04decrypt(getPrivateKey(account), pubkey, ciphertext));
      sendMessage({ id, type: responseType, result: ciphertext });
    } else if (type === 'nip04.decrypt') {
      const { pubkey, ciphertext }: { pubkey: string, ciphertext: string } = arg;
      const plaintext = await nip04decrypt(getPrivateKey(account), pubkey, ciphertext);
      sendMessage({ id, type: responseType, result: plaintext });
    } else {
      // log({ error: 'unknown type', request });
      sendMessage({ id, type: 'error', result: 'unknown type' });
    }
  } catch (err) {
    // log({ error: err.toString(), request });
    // TODO: check if err.toString() contains private key or not
    sendMessage({ id, type: 'error', result: 'error in keychain.ts. intentionally not showing the error message to protect private key.' });
  }
};

const log = (obj: any) => {
  appendFileSync(path.join(process.cwd(), 'nostr-keyx.log'), JSON.stringify(obj) + '\n');
}

// event listener
process.stdin.on('readable', async () => {
  await handleMessage(receiveMessage());
});

// error handler
process.on('uncaughtException', (err) => {
  // log({ error: err.toString() });
  // TODO: check if err.toString() contains private key or not
  sendMessage({ id: '', type: 'error', result: 'uncaughtException. intentionally not showing the error message to protect private key.' });
});