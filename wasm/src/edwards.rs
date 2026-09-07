//! Extended twisted Edwards arithmetic used by the vanity walk.
//!
//! MeshCore stores a 64-byte expanded key and derives the public key with
//! `ge_scalarmult_base(prv[0..32])`. Any correctly clamped scalar works;
//! bytes 32..63 are only a signing nonce and can be random. That lets the
//! search walk `s += 8`, `P += 8G` instead of hashing a new seed and doing
//! a full basepoint multiply on every candidate.

use crate::field::{self, Fe, ONE, ZERO};

const GX_BYTES: [u8; 32] = [
    0x1a, 0xd5, 0x25, 0x8f, 0x60, 0x2d, 0x56, 0xc9, 0xb2, 0xa7, 0x25, 0x95, 0x60, 0xc7, 0x2c, 0x69,
    0x5c, 0xdc, 0xd6, 0xfd, 0x31, 0xe2, 0xa4, 0xc0, 0xfe, 0x53, 0x6e, 0xcd, 0xd3, 0x36, 0x69, 0x21,
];
const GY_BYTES: [u8; 32] = [
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
];
const D2_BYTES: [u8; 32] = [
    0x59, 0xf1, 0xb2, 0x26, 0x94, 0x9b, 0xd6, 0xeb, 0x56, 0xb1, 0x83, 0x82, 0x9a, 0x14, 0xe0, 0x00,
    0x30, 0xd1, 0xf3, 0xee, 0xf2, 0x80, 0x8e, 0x19, 0xe7, 0xfc, 0xdf, 0x56, 0xdc, 0xd9, 0x06, 0x24,
];

const GX: Fe = field::from_bytes(&GX_BYTES);
const GY: Fe = field::from_bytes(&GY_BYTES);
const D2: Fe = field::from_bytes(&D2_BYTES);

#[derive(Clone, Copy)]
pub struct ExtPoint {
    pub x: Fe,
    pub y: Fe,
    pub z: Fe,
    pub t: Fe,
}

#[derive(Clone, Copy)]
pub struct CachedPoint {
    ymx: Fe,
    ypx: Fe,
    t2d: Fe,
    z2: Fe,
}

pub const IDENTITY: ExtPoint = ExtPoint {
    x: ZERO,
    y: ONE,
    z: ONE,
    t: ZERO,
};

fn basepoint() -> ExtPoint {
    ExtPoint {
        x: GX,
        y: GY,
        z: ONE,
        t: field::mul(GX, GY),
    }
}

pub fn cache(p: ExtPoint) -> CachedPoint {
    CachedPoint {
        ymx: field::sub(p.y, p.x),
        ypx: field::add(p.y, p.x),
        t2d: field::mul(D2, p.t),
        z2: field::add(p.z, p.z),
    }
}

/// add-2008-hwcd-3 (a = -1), 8 field multiplications.
pub fn add_cached(p: ExtPoint, c: &CachedPoint) -> ExtPoint {
    let a = field::mul(field::sub(p.y, p.x), c.ymx);
    let b = field::mul(field::add(p.y, p.x), c.ypx);
    let cc = field::mul(p.t, c.t2d);
    let dz = field::mul(p.z, c.z2);
    let e = field::sub(b, a);
    let f = field::sub(dz, cc);
    let h = field::add(b, a);
    let i = field::add(dz, cc);
    ExtPoint {
        x: field::mul(e, f),
        y: field::mul(i, h),
        z: field::mul(f, i),
        t: field::mul(e, h),
    }
}

/// dbl-2008-hwcd
fn dbl(p: ExtPoint) -> ExtPoint {
    let a = field::sqr(p.x);
    let b = field::sqr(p.y);
    let c = field::add(field::sqr(p.z), field::sqr(p.z));
    let h = field::add(a, b);
    let e = field::sub(h, field::sqr(field::add(p.x, p.y)));
    let i = field::sub(a, b);
    let f = field::add(c, i);
    ExtPoint {
        x: field::mul(e, f),
        y: field::mul(i, h),
        z: field::mul(f, i),
        t: field::mul(e, h),
    }
}

pub fn scalar_mul_base(k: &[u8; 32]) -> ExtPoint {
    let mut q = IDENTITY;
    let mut d = basepoint();
    for bit_index in 0..256 {
        if (k[bit_index >> 3] >> (bit_index & 7)) & 1 == 1 {
            q = add_cached(q, &cache(d));
        }
        d = dbl(d);
    }
    q
}

pub fn eight_g_cached() -> CachedPoint {
    let g2 = dbl(basepoint());
    let g4 = dbl(g2);
    cache(dbl(g4))
}

pub fn encode_point(p: ExtPoint) -> [u8; 32] {
    let zi = field::invert(p.z);
    let x = field::mul(p.x, zi);
    let y = field::mul(p.y, zi);
    let mut b = y.to_bytes();
    if x.is_odd() {
        b[31] |= 0x80;
    }
    b
}

pub fn add8_le(scalar: &mut [u8; 32]) {
    let mut carry = 8u16;
    for byte in scalar.iter_mut() {
        let t = *byte as u16 + carry;
        *byte = t as u8;
        carry = t >> 8;
        if carry == 0 {
            return;
        }
    }
}

pub fn clamp_scalar(bytes: &mut [u8; 32]) {
    bytes[0] &= 248;
    bytes[31] &= 63;
    bytes[31] |= 64;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_basepoint() {
        let encoded = encode_point(basepoint());
        assert_eq!(encoded, GY_BYTES);
    }

    #[test]
    fn mul_base_one_is_g() {
        let mut k = [0u8; 32];
        k[0] = 1;
        assert_eq!(encode_point(scalar_mul_base(&k)), GY_BYTES);
    }

    #[test]
    fn add_eight_matches_mul() {
        let mut k = [0u8; 32];
        k[0] = 8;
        k[31] = 64;
        let p0 = scalar_mul_base(&k);
        let p1 = add_cached(p0, &eight_g_cached());
        add8_le(&mut k);
        assert_eq!(encode_point(p1), encode_point(scalar_mul_base(&k)));
    }

    #[test]
    fn agrees_with_dalek_mul_base_clamped() {
        use curve25519_dalek::EdwardsPoint;
        let mut k = [0u8; 32];
        k[0] = 0x18;
        k[7] = 0xab;
        k[15] = 0xcd;
        k[23] = 0xef;
        clamp_scalar(&mut k);
        let ours = encode_point(scalar_mul_base(&k));
        let theirs = EdwardsPoint::mul_base_clamped(k).compress().to_bytes();
        assert_eq!(ours, theirs);
    }
}
