//! Variable-time arithmetic in GF(2^255-19).
//!
//! Vanity search does not need constant-time ops; keeping this variable-time
//! makes the +8G walk cheap enough to beat a full basepoint multiply.

use core::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fe(pub [u64; 4]);

const P: [u64; 4] = [
    0xffff_ffff_ffff_ffed,
    0xffff_ffff_ffff_ffff,
    0xffff_ffff_ffff_ffff,
    0x7fff_ffff_ffff_ffff,
];
const MASK255: u64 = 0x7fff_ffff_ffff_ffff;

pub const ZERO: Fe = Fe([0, 0, 0, 0]);
pub const ONE: Fe = Fe([1, 0, 0, 0]);

const fn load_le_u64(b: &[u8; 32], i: usize) -> u64 {
    u64::from_le_bytes([
        b[i],
        b[i + 1],
        b[i + 2],
        b[i + 3],
        b[i + 4],
        b[i + 5],
        b[i + 6],
        b[i + 7],
    ])
}

pub const fn from_bytes(b: &[u8; 32]) -> Fe {
    Fe([
        load_le_u64(b, 0),
        load_le_u64(b, 8),
        load_le_u64(b, 16),
        load_le_u64(b, 24) & MASK255,
    ])
}

impl Fe {
    pub fn to_bytes(self) -> [u8; 32] {
        let r = reduce_ge_p(self.0);
        let mut out = [0u8; 32];
        out[0..8].copy_from_slice(&r[0].to_le_bytes());
        out[8..16].copy_from_slice(&r[1].to_le_bytes());
        out[16..24].copy_from_slice(&r[2].to_le_bytes());
        out[24..32].copy_from_slice(&r[3].to_le_bytes());
        out
    }

    pub fn is_odd(self) -> bool {
        reduce_ge_p(self.0)[0] & 1 == 1
    }
}

fn cmp_limbs(a: [u64; 4], b: [u64; 4]) -> Ordering {
    for i in (0..4).rev() {
        if a[i] > b[i] {
            return Ordering::Greater;
        }
        if a[i] < b[i] {
            return Ordering::Less;
        }
    }
    Ordering::Equal
}

fn reduce_ge_p(limbs: [u64; 4]) -> [u64; 4] {
    if cmp_limbs(limbs, P) != Ordering::Less {
        sub_limbs(limbs, P)
    } else {
        limbs
    }
}

fn sub_limbs(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut borrow = 0u64;
    let mut out = [0u64; 4];
    for i in 0..4 {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(borrow);
        out[i] = d2;
        borrow = u64::from(b1 | b2);
    }
    debug_assert_eq!(borrow, 0);
    out
}

pub fn add(a: Fe, b: Fe) -> Fe {
    let mut carry = 0u128;
    let mut out = [0u64; 4];
    for i in 0..4 {
        let s = a.0[i] as u128 + b.0[i] as u128 + carry;
        out[i] = s as u64;
        carry = s >> 64;
    }
    debug_assert_eq!(carry, 0);
    Fe(reduce_ge_p(out))
}

pub fn sub(a: Fe, b: Fe) -> Fe {
    if cmp_limbs(a.0, b.0) != Ordering::Less {
        Fe(sub_limbs(a.0, b.0))
    } else {
        let mut carry = 0u128;
        let mut tmp = [0u64; 4];
        for i in 0..4 {
            let s = a.0[i] as u128 + P[i] as u128 + carry;
            tmp[i] = s as u64;
            carry = s >> 64;
        }
        debug_assert_eq!(carry, 0);
        Fe(sub_limbs(tmp, b.0))
    }
}

fn mul_wide(a: [u64; 4], b: [u64; 4]) -> [u64; 8] {
    let mut acc = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u128;
        for j in 0..4 {
            let t = acc[i + j] as u128 + a[i] as u128 * b[j] as u128 + carry;
            acc[i + j] = t as u64;
            carry = t >> 64;
        }
        let mut k = i + 4;
        while carry > 0 {
            let t = acc[k] as u128 + carry;
            acc[k] = t as u64;
            carry = t >> 64;
            k += 1;
        }
    }
    acc
}

fn carry6(r: [u128; 6]) -> [u64; 6] {
    let mut limbs = [0u64; 6];
    let mut carry = 0u128;
    for i in 0..6 {
        let s = r[i] + carry;
        limbs[i] = s as u64;
        carry = s >> 64;
    }
    debug_assert_eq!(carry, 0);
    limbs
}

/// Reduce a 512-bit product using 2^256 ≡ 38 and 2^255 ≡ 19 (mod p).
fn reduce_512(t: [u64; 8]) -> Fe {
    let mut r = [0u128; 6];
    for i in 0..4 {
        r[i] = t[i] as u128 + 38u128 * t[i + 4] as u128;
    }
    fold_255(carry6(r))
}

fn fold_255(mut limbs: [u64; 6]) -> Fe {
    for _ in 0..3 {
        let hi0 = (limbs[3] >> 63) | (limbs[4] << 1);
        let hi1 = (limbs[4] >> 63) | (limbs[5] << 1);
        let hi2 = limbs[5] >> 63;
        limbs[3] &= MASK255;
        limbs[4] = 0;
        limbs[5] = 0;

        let mut r = [0u128; 6];
        for i in 0..4 {
            r[i] = limbs[i] as u128;
        }
        r[0] += 19u128 * hi0 as u128;
        r[1] += 19u128 * hi1 as u128;
        r[2] += 19u128 * hi2 as u128;
        limbs = carry6(r);
    }
    debug_assert_eq!(limbs[4], 0);
    debug_assert_eq!(limbs[5], 0);
    debug_assert_eq!(limbs[3] >> 63, 0);
    Fe(reduce_ge_p([limbs[0], limbs[1], limbs[2], limbs[3]]))
}

pub fn mul(a: Fe, b: Fe) -> Fe {
    reduce_512(mul_wide(a.0, b.0))
}

pub fn sqr(a: Fe) -> Fe {
    mul(a, a)
}

/// z^(p-2) via the ref10 addition chain.
pub fn invert(z: Fe) -> Fe {
    let z2 = sqr(z);
    let mut t = sqr(sqr(z2));
    let z9 = mul(t, z);
    let z11 = mul(z9, z2);
    let z2_5_0 = mul(sqr(z11), z9);

    t = z2_5_0;
    for _ in 0..5 {
        t = sqr(t);
    }
    let z2_10_0 = mul(t, z2_5_0);

    t = z2_10_0;
    for _ in 0..10 {
        t = sqr(t);
    }
    let z2_20_0 = mul(t, z2_10_0);

    t = z2_20_0;
    for _ in 0..20 {
        t = sqr(t);
    }
    let z2_40_0 = mul(t, z2_20_0);

    t = z2_40_0;
    for _ in 0..10 {
        t = sqr(t);
    }
    let z2_50_0 = mul(t, z2_10_0);

    t = z2_50_0;
    for _ in 0..50 {
        t = sqr(t);
    }
    let z2_100_0 = mul(t, z2_50_0);

    t = z2_100_0;
    for _ in 0..100 {
        t = sqr(t);
    }
    let z2_200_0 = mul(t, z2_100_0);

    t = z2_200_0;
    for _ in 0..50 {
        t = sqr(t);
    }
    t = mul(t, z2_50_0);
    for _ in 0..5 {
        t = sqr(t);
    }
    mul(t, z11)
}

/// Invert every `z[i]` in place with one `invert()` (Montgomery's trick).
pub fn batch_invert(zs: &mut [Fe], scratch: &mut [Fe]) {
    let n = zs.len();
    if n == 0 {
        return;
    }
    debug_assert!(scratch.len() >= n);

    let mut run = zs[0];
    scratch[0] = run;
    for i in 1..n {
        run = mul(run, zs[i]);
        scratch[i] = run;
    }

    let mut inv = invert(run);
    for i in (1..n).rev() {
        let zi = mul(inv, scratch[i - 1]);
        inv = mul(inv, zs[i]);
        zs[i] = zi;
    }
    zs[0] = inv;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_sub_small() {
        let a = Fe([123, 0, 0, 0]);
        let b = Fe([456, 0, 0, 0]);
        assert_eq!(add(a, b).0[0], 579);
        assert_eq!(sub(add(a, b), b), a);
        assert_eq!(add(sub(ZERO, a), a), ZERO);
    }

    #[test]
    fn mul_small() {
        let a = Fe([12345, 0, 0, 0]);
        let b = Fe([67890, 0, 0, 0]);
        assert_eq!(mul(a, b), Fe([12345 * 67890, 0, 0, 0]));
        let pm1 = sub(ZERO, ONE);
        assert_eq!(mul(pm1, pm1), ONE);
    }

    #[test]
    fn invert_roundtrip() {
        let a = Fe([0x1234_5678_9abc_def0, 0x0fed, 1, 0]);
        assert_eq!(mul(a, invert(a)), ONE);
    }

    #[test]
    fn bytes_roundtrip() {
        let a = Fe([0x0123456789abcdef, 0xfedcba9876543210, 0x1111, 0x2222]);
        let b = from_bytes(&a.to_bytes());
        assert_eq!(reduce_ge_p(a.0), reduce_ge_p(b.0));
    }
}
