mod edwards;
mod field;

use edwards::{
    add8_le, add_cached, clamp_scalar, eight_g_cached, encode_point, scalar_mul_base, CachedPoint,
    ExtPoint,
};
use field::Fe;
use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

const INVERT_BATCH: usize = 512;

thread_local! {
    static WALKER: RefCell<Option<Walker>> = const { RefCell::new(None) };
}

struct Walker {
    rng: ChaCha8Rng,
    scalar: [u8; 32],
    point: ExtPoint,
    step: CachedPoint,
    points: Vec<ExtPoint>,
    ys: Vec<Fe>,
    zs: Vec<Fe>,
    scratch: Vec<Fe>,
}

impl Walker {
    fn new() -> Self {
        let mut rng_seed = [0u8; 32];
        getrandom::getrandom(&mut rng_seed).expect("failed to seed worker RNG");
        let mut rng = ChaCha8Rng::from_seed(rng_seed);
        let step = eight_g_cached();
        let (scalar, point) = random_start(&mut rng);
        Self {
            rng,
            scalar,
            point,
            step,
            points: Vec::with_capacity(INVERT_BATCH),
            ys: Vec::with_capacity(INVERT_BATCH),
            zs: Vec::with_capacity(INVERT_BATCH),
            scratch: Vec::with_capacity(INVERT_BATCH),
        }
    }

    fn reseed(&mut self) {
        let (scalar, point) = random_start(&mut self.rng);
        self.scalar = scalar;
        self.point = point;
    }
}

fn random_start(rng: &mut ChaCha8Rng) -> ([u8; 32], ExtPoint) {
    let mut scalar = [0u8; 32];
    rng.fill_bytes(&mut scalar);
    clamp_scalar(&mut scalar);
    let point = scalar_mul_base(&scalar);
    (scalar, point)
}

fn add_u32_le(bytes: &mut [u8; 32], mut val: u32) {
    for byte in bytes.iter_mut() {
        if val == 0 {
            return;
        }
        let t = *byte as u32 + val;
        *byte = t as u8;
        val = t >> 8;
    }
}

/// Generate a batch of Ed25519 vanity keys, returning only those matching the prefix.
///
/// Candidates are produced by walking `s += 8`, `P += 8G` from a random clamped
/// scalar. Affine y is recovered for a whole chunk with one inversion. SHA-512
/// seed expansion is skipped: MeshCore derives the public key from the stored
/// 32-byte scalar, and the second half of the 64-byte private key is a random
/// signing nonce.
///
/// # Arguments
/// * `prefix_bytes` - Packed prefix bytes (high-nibble-first, e.g. "F8" → 0xF8)
/// * `prefix_nibbles` - Number of hex nibbles to match (1-8)
/// * `batch_size` - Number of keys to attempt
///
/// # Returns
/// Flat byte buffer:
///   [match_count: u32 LE][attempted: u32 LE]
///   Per match (128 bytes): [pubkey: 32][clamped: 32][nonce: 32][unused: 32]
#[wasm_bindgen]
pub fn generate_batch(prefix_bytes: &[u8], prefix_nibbles: u32, batch_size: u32) -> Vec<u8> {
    WALKER.with(|cell| {
        let mut slot = cell.borrow_mut();
        let walker = slot.get_or_insert_with(Walker::new);
        generate_batch_with(walker, prefix_bytes, prefix_nibbles, batch_size)
    })
}

fn generate_batch_with(
    walker: &mut Walker,
    prefix_bytes: &[u8],
    prefix_nibbles: u32,
    batch_size: u32,
) -> Vec<u8> {
    let mut results = Vec::with_capacity(8 + 128);
    results.extend_from_slice(&[0u8; 8]);

    let mut match_count: u32 = 0;
    let mut remaining = batch_size as usize;

    while remaining > 0 {
        let chunk = remaining.min(INVERT_BATCH);
        walker.points.clear();
        walker.ys.clear();
        walker.zs.clear();
        walker.scratch.clear();

        if walker.scalar[31] & 0x80 != 0 {
            walker.reseed();
        }

        let scalar0 = walker.scalar;
        for _ in 0..chunk {
            add8_le(&mut walker.scalar);
            walker.point = add_cached(walker.point, &walker.step);
            walker.points.push(walker.point);
            walker.ys.push(walker.point.y);
            walker.zs.push(walker.point.z);
        }

        walker.scratch.resize(chunk, field::ZERO);
        field::batch_invert(&mut walker.zs, &mut walker.scratch);

        for i in 0..chunk {
            let y = field::mul(walker.ys[i], walker.zs[i]);
            let y_bytes = y.to_bytes();
            if y_bytes[0] == 0x00 || y_bytes[0] == 0xff {
                continue;
            }
            if !check_prefix(&y_bytes, prefix_bytes, prefix_nibbles) {
                continue;
            }

            let pubkey = encode_point(walker.points[i]);
            let mut scalar = scalar0;
            add_u32_le(&mut scalar, 8 * (i as u32 + 1));
            let mut nonce = [0u8; 32];
            walker.rng.fill_bytes(&mut nonce);

            match_count += 1;
            results.extend_from_slice(&pubkey);
            results.extend_from_slice(&scalar);
            results.extend_from_slice(&nonce);
            results.extend_from_slice(&[0u8; 32]);
        }

        remaining -= chunk;
    }

    results[0..4].copy_from_slice(&match_count.to_le_bytes());
    results[4..8].copy_from_slice(&batch_size.to_le_bytes());
    results
}

fn check_prefix(pubkey: &[u8], prefix_bytes: &[u8], nibbles: u32) -> bool {
    let full_bytes = (nibbles / 2) as usize;
    for i in 0..full_bytes {
        if pubkey[i] != prefix_bytes[i] {
            return false;
        }
    }
    if nibbles % 2 == 1 && (pubkey[full_bytes] & 0xF0) != (prefix_bytes[full_bytes] & 0xF0) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{add_u32_le, check_prefix, generate_batch_with, Walker};
    use crate::edwards::{add8_le, encode_point, scalar_mul_base};

    #[test]
    fn matches_full_byte_prefix() {
        let pubkey = [0xAB, 0xCD, 0xEF, 0x11];
        assert!(check_prefix(&pubkey, &[0xAB], 2));
        assert!(!check_prefix(&pubkey, &[0xAC], 2));
    }

    #[test]
    fn matches_odd_nibble_prefix() {
        let pubkey = [0xAB, 0xCD, 0xEF, 0x11];
        assert!(check_prefix(&pubkey, &[0xA0], 1));
        assert!(check_prefix(&pubkey, &[0xAB, 0xC0], 3));
        assert!(!check_prefix(&pubkey, &[0xAB, 0xD0], 3));
    }

    #[test]
    fn add_u32_matches_repeated_add8() {
        let mut start = [0u8; 32];
        start[0] = 8;
        start[31] = 64;
        let mut stepped = start;
        for _ in 0..100 {
            add8_le(&mut stepped);
        }
        let mut added = start;
        add_u32_le(&mut added, 8 * 100);
        assert_eq!(added, stepped);
    }

    #[test]
    fn walked_pubkey_matches_scalar_mul() {
        let mut walker = Walker::new();
        let buf = generate_batch_with(&mut walker, &[], 0, 32);
        let match_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert!(match_count > 0);
        for m in 0..match_count as usize {
            let off = 8 + m * 128;
            let pubkey = &buf[off..off + 32];
            let scalar: [u8; 32] = buf[off + 32..off + 64].try_into().unwrap();
            assert_eq!(pubkey, encode_point(scalar_mul_base(&scalar)));
            assert_eq!(scalar[0] & 7, 0);
            assert_eq!(scalar[31] & 192, 64);
        }
    }

    #[test]
    fn walk_finds_one_nibble_prefix() {
        let mut walker = Walker::new();
        let mut found = false;
        for _ in 0..64 {
            let buf = generate_batch_with(&mut walker, &[0xA0], 1, 4096);
            let match_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
            if match_count > 0 {
                let pubkey = &buf[8..40];
                assert_eq!(pubkey[0] & 0xF0, 0xA0);
                found = true;
                break;
            }
        }
        assert!(found);
    }

    #[test]
    fn walk_throughput_smoke() {
        let mut walker = Walker::new();
        let n = 1u32 << 16;
        let start = std::time::Instant::now();
        let _ = generate_batch_with(&mut walker, &[0xff, 0xff, 0xff, 0xff], 8, n);
        let elapsed = start.elapsed().as_secs_f64().max(1e-9);
        let rate = n as f64 / elapsed;
        eprintln!("walk throughput: {:.0} keys/sec", rate);
        assert!(rate > 1_000.0);
    }
}
