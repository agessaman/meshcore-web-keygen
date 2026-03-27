use wasm_bindgen::prelude::*;
use sha2::{Sha512, Digest};
use curve25519_dalek::EdwardsPoint;
use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};
use std::cell::RefCell;

thread_local! {
    static WORKER_RNG: RefCell<Option<ChaCha8Rng>> = const { RefCell::new(None) };
}

/// Generate a batch of Ed25519 vanity keys, returning only those matching the prefix.
///
/// # Arguments
/// * `prefix_bytes` - Packed prefix bytes (high-nibble-first, e.g. "F8" → 0xF8)
/// * `prefix_nibbles` - Number of hex nibbles to match (1-8)
/// * `batch_size` - Number of keys to attempt
///
/// # Returns
/// Flat byte buffer:
///   [match_count: u32 LE][attempted: u32 LE]
///   Per match (128 bytes): [pubkey: 32][clamped: 32][sha512_second_half: 32][seed: 32]
#[wasm_bindgen]
pub fn generate_batch(prefix_bytes: &[u8], prefix_nibbles: u32, batch_size: u32) -> Vec<u8> {
    WORKER_RNG.with(|rng_cell| {
        let mut rng_ref = rng_cell.borrow_mut();
        let rng = rng_ref.get_or_insert_with(|| {
            let mut rng_seed = [0u8; 32];
            getrandom::getrandom(&mut rng_seed).expect("failed to seed worker RNG");
            ChaCha8Rng::from_seed(rng_seed)
        });

        let mut results = Vec::with_capacity(8 + 128); // header + likely 0-1 matches
        // Reserve header space (filled at end)
        results.extend_from_slice(&[0u8; 8]);

        let mut match_count: u32 = 0;
        let mut seed = [0u8; 32];
        let mut clamped = [0u8; 32];

        for _ in 0..batch_size {
            // 1. Generate random 32-byte seed via fast PRNG (no JS interop)
            rng.fill_bytes(&mut seed);

            // 2. SHA-512(seed)
            let digest = Sha512::digest(seed);

            // 3. Clamp first 32 bytes (RFC 8032 scalar clamping)
            clamped.copy_from_slice(&digest[..32]);
            clamped[0] &= 248;
            clamped[31] &= 63;
            clamped[31] |= 64;

            // 4. Basepoint multiply from clamped scalar bytes
            let point = EdwardsPoint::mul_base_clamped(clamped);
            let compressed = point.compress();
            let pubkey = compressed.as_bytes();

            // 5. Skip reserved prefixes (0x00, 0xFF)
            if pubkey[0] == 0x00 || pubkey[0] == 0xFF {
                continue;
            }

            // 6. Check prefix match
            if check_prefix(pubkey, prefix_bytes, prefix_nibbles) {
                match_count += 1;
                results.extend_from_slice(pubkey);          // 32 bytes
                results.extend_from_slice(&clamped);        // 32 bytes
                results.extend_from_slice(&digest[32..64]); // 32 bytes
                results.extend_from_slice(&seed);           // 32 bytes
            }
        }

        // Fill in header
        results[0..4].copy_from_slice(&match_count.to_le_bytes());
        results[4..8].copy_from_slice(&batch_size.to_le_bytes());

        results
    })
}

#[inline]
fn check_prefix(pubkey: &[u8], prefix_bytes: &[u8], nibbles: u32) -> bool {
    let full_bytes = (nibbles / 2) as usize;
    for i in 0..full_bytes {
        if pubkey[i] != prefix_bytes[i] {
            return false;
        }
    }
    if nibbles % 2 == 1 {
        if (pubkey[full_bytes] & 0xF0) != (prefix_bytes[full_bytes] & 0xF0) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::check_prefix;

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
}
