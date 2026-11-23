/**
 * A Rex data connection (`GET /api/data`) on Android, over RexDataSocket.kt.
 * Binary only: frames reach the listener as Uint8Array, and the client sends
 * only the binary HELLO or RESUME. Callbacks arrive on the opening thread
 * (the main thread or the worker that called openRexDataSocket), and none
 * arrive once close() has been called. Android only; iOS has no native side.
 */
import { copyToJavaByteBuffer } from './java-direct-buffer'
import { REX_DATA_SUBPROTOCOL } from '../apps/terminal/rex/protocol'

declare const com: any

export type RexDataSocketListener = {
  onOpen(): void
  /** One binary message, never empty. The array is the listener's own copy. */
  onBinaryMessage(bytes: Uint8Array): void
  onClosed(code: number, reason: string): void
  onFailure(message: string): void
}

export type RexDataSocketConnection = {
  /** False once the socket is closing or has failed. */
  sendBinary(bytes: Uint8Array): boolean
  close(code: number, reason: string): void
}

export function openRexDataSocket(url: string, listener: RexDataSocketListener): RexDataSocketConnection {
  const proxy = new com.faceclaw.app.RexDataSocketListener({
    onOpen: () => listener.onOpen(),
    // The frame is a direct buffer of exactly the message's bytes: view it in place, then copy once
    // so V8 owns the result and the Java buffer can go.
    onBinaryMessage: (frame: unknown) => listener.onBinaryMessage(new Uint8Array((ArrayBuffer as any).from(frame)).slice()),
    onClosed: (code: number, reason: string) => listener.onClosed(Number(code), String(reason)),
    onFailure: (message: string) => listener.onFailure(String(message)),
  })
  const native = new com.faceclaw.app.RexDataSocket(url, REX_DATA_SUBPROTOCOL, proxy)
  const connection = { listenerProxy: proxy, sendBinary: (bytes: Uint8Array) => native.sendBinary(copyToJavaByteBuffer(bytes)) !== false,
    close: (code: number, reason: string) => native.close(code, reason) }
  return connection
}
