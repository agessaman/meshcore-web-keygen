/* tslint:disable */
/* eslint-disable */

/**
 * Generate a batch of Ed25519 vanity keys, returning only those matching the prefix.
 *
 * # Arguments
 * * `prefix_bytes` - Packed prefix bytes (high-nibble-first, e.g. "F8" → 0xF8)
 * * `prefix_nibbles` - Number of hex nibbles to match (1-8)
 * * `batch_size` - Number of keys to attempt
 *
 * # Returns
 * Flat byte buffer:
 *   [match_count: u32 LE][attempted: u32 LE]
 *   Per match (128 bytes): [pubkey: 32][clamped: 32][sha512_second_half: 32][seed: 32]
 */
export function generate_batch(prefix_bytes: Uint8Array, prefix_nibbles: number, batch_size: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly generate_batch: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
