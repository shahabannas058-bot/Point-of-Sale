import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Synchronous SHA-256 of a UTF-8 string, lowercase hex. Pure JS: identical in Node and the Tauri webview. */
export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));
