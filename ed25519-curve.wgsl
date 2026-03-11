// Ed25519 Elliptic Curve Operations using i256 library
// Implements scalar multiplication on the Ed25519 curve

// Ed25519 curve parameters
// Prime: p = 2^255 - 19
// Order: n = 2^252 + 27742317777372353535851937790883648493
// d = -121665/121666 (mod p)
// Base point G has order n

// Ed25519 prime: 2^255 - 19
// Stored as array<u32, 8> in little-endian format
const ED25519_P: array<u32, 8> = array<u32, 8>(
    0xFFFFFFEDu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu,
    0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x7FFFFFFFu
);

// Ed25519 d parameter: d = -121665/121666 mod p
// = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3
const ED25519_D: array<u32, 8> = array<u32, 8>(
    0x135978a3u, 0x75eb4dcau, 0x4141d8abu, 0x00700a4du,
    0x7779e898u, 0x8cc74079u, 0x2b6ffe73u, 0x52036ceeu
);

// Ed25519 base point G_x
// = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a
const ED25519_GX: array<u32, 8> = array<u32, 8>(
    0x8f25d51au, 0xc9562d60u, 0x9525a7b2u, 0x692cc760u,
    0xfdd6dc5cu, 0xc0a4e231u, 0xcd6e53feu, 0x216936d3u
);

// Ed25519 base point G_y
// = 0x6666666666666666666666666666666666666666666666666666666666666658
const ED25519_GY: array<u32, 8> = array<u32, 8>(
    0x66666658u, 0x66666666u, 0x66666666u, 0x66666666u,
    0x66666666u, 0x66666666u, 0x66666666u, 0x66666666u
);

// Extended Edwards coordinates point (X : Y : Z : T) where x = X/Z, y = Y/Z, T = XY/Z
struct EdwardsPoint {
    X: i256,
    Y: i256,
    Z: i256,
    T: i256,
}

// Modular reduction for Ed25519 prime (2^255 - 19)
// This is a simplified version - production needs full Barrett/Montgomery reduction
fn mod_p(a: i256) -> i256 {
    // For proper implementation, this needs:
    // 1. Barrett reduction or Montgomery form
    // 2. Handle both positive and negative values
    // 3. Multiple rounds of reduction if needed

    // Simple approach: if a >= p, subtract p repeatedly
    // This is inefficient but correct for demonstration

    let p = i256_from_u32_array(ED25519_P, 1);
    var result = a;

    // Ensure positive
    if (result.sign < 0) {
        // Add multiples of p until positive
        result = i256_sum(result, p);
    }

    // Reduce while >= p
    for (var i = 0; i < 10; i++) {
        if (i256_greater_eq(result, p)) {
            result = i256_sub(result, p);
        } else {
            break;
        }
    }

    return result;
}

// Modular multiplication: (a * b) mod p
fn mul_mod_p(a: i256, b: i256) -> i256 {
    let product = i256_mul_to_i512(a, b);
    // Convert i512 back to i256 (taking lower 256 bits) then reduce
    var result256 = i256_from_u32_array(
        array<u32, 8>(
            product.number[15], product.number[14], product.number[13], product.number[12],
            product.number[11], product.number[10], product.number[9], product.number[8]
        ),
        product.sign
    );
    return mod_p(result256);
}

// Modular addition: (a + b) mod p
fn add_mod_p(a: i256, b: i256) -> i256 {
    return mod_p(i256_sum(a, b));
}

// Modular subtraction: (a - b) mod p
fn sub_mod_p(a: i256, b: i256) -> i256 {
    return mod_p(i256_sub(a, b));
}

// Identity point (0 : 1 : 1 : 0)
fn edwards_identity() -> EdwardsPoint {
    var point: EdwardsPoint;
    point.X = i256_from_u32(0u);
    point.Y = i256_from_u32(1u);
    point.Z = i256_from_u32(1u);
    point.T = i256_from_u32(0u);
    return point;
}

// Ed25519 base point in extended coordinates
fn edwards_base_point() -> EdwardsPoint {
    var point: EdwardsPoint;
    point.X = i256_from_u32_array(ED25519_GX, 1);
    point.Y = i256_from_u32_array(ED25519_GY, 1);
    point.Z = i256_from_u32(1u);
    point.T = mul_mod_p(point.X, point.Y);
    return point;
}

// Point addition in extended Edwards coordinates
// Formula from https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html
fn edwards_add(p1: EdwardsPoint, p2: EdwardsPoint) -> EdwardsPoint {
    let d = i256_from_u32_array(ED25519_D, 1);

    // A = X1 * X2
    let A = mul_mod_p(p1.X, p2.X);
    // B = Y1 * Y2
    let B = mul_mod_p(p1.Y, p2.Y);
    // C = T1 * d * T2
    let C = mul_mod_p(mul_mod_p(p1.T, d), p2.T);
    // D = Z1 * Z2
    let D = mul_mod_p(p1.Z, p2.Z);
    // E = (X1 + Y1) * (X2 + Y2) - A - B
    let E = sub_mod_p(sub_mod_p(mul_mod_p(add_mod_p(p1.X, p1.Y), add_mod_p(p2.X, p2.Y)), A), B);
    // F = D - C
    let F = sub_mod_p(D, C);
    // G = D + C
    let G = add_mod_p(D, C);
    // H = B - a * A (where a = -1 for Ed25519, so H = B + A)
    let H = add_mod_p(B, A);

    var result: EdwardsPoint;
    // X3 = E * F
    result.X = mul_mod_p(E, F);
    // Y3 = G * H
    result.Y = mul_mod_p(G, H);
    // Z3 = F * G
    result.Z = mul_mod_p(F, G);
    // T3 = E * H
    result.T = mul_mod_p(E, H);

    return result;
}

// Point doubling in extended Edwards coordinates
fn edwards_double(p: EdwardsPoint) -> EdwardsPoint {
    // A = X^2
    let A = mul_mod_p(p.X, p.X);
    // B = Y^2
    let B = mul_mod_p(p.Y, p.Y);
    // C = 2 * Z^2
    let two = i256_from_u32(2u);
    let C = mul_mod_p(two, mul_mod_p(p.Z, p.Z));
    // D = a * A (where a = -1, so D = -A)
    let D = i256_negate(A);
    // E = (X + Y)^2 - A - B
    let E = sub_mod_p(sub_mod_p(mul_mod_p(add_mod_p(p.X, p.Y), add_mod_p(p.X, p.Y)), A), B);
    // G = D + B
    let G = add_mod_p(D, B);
    // F = G - C
    let F = sub_mod_p(G, C);
    // H = D - B
    let H = sub_mod_p(D, B);

    var result: EdwardsPoint;
    // X3 = E * F
    result.X = mul_mod_p(E, F);
    // Y3 = G * H
    result.Y = mul_mod_p(G, H);
    // Z3 = F * G
    result.Z = mul_mod_p(F, G);
    // T3 = E * H
    result.T = mul_mod_p(E, H);

    return result;
}

// Scalar multiplication using double-and-add algorithm
// Computes scalar * base_point
fn edwards_scalar_mult(scalar: i256, base: EdwardsPoint) -> EdwardsPoint {
    var result = edwards_identity();
    var temp = base;

    // Process each bit of the scalar
    for (var i = 0u; i < 256u; i++) {
        // Check if bit i is set
        let word_idx = i / 32u;
        let bit_idx = i % 32u;
        let bit_set = (scalar.number[7u - word_idx] & (1u << bit_idx)) != 0u;

        if (bit_set) {
            result = edwards_add(result, temp);
        }

        temp = edwards_double(temp);
    }

    return result;
}

// Convert Edwards point to affine coordinates (x, y)
// Returns y-coordinate with sign bit of x (Ed25519 public key format)
fn edwards_to_public_key(point: EdwardsPoint) -> array<u32, 8> {
    // Compute affine y = Y/Z (mod p)
    // For proper implementation, need modular inverse
    // Simplified version - assumes Z = 1 or uses approximation

    // In production: compute Z^(-1) mod p using Fermat's little theorem
    // z_inv = z^(p-2) mod p

    let p = i256_from_u32_array(ED25519_P, 1);
    let p_minus_2 = i256_sub(p, i256_from_u32(2u));

    // Compute modular inverse: z^(p-2) mod p
    let z_inv = i256_powermod(point.Z, p_minus_2, p);

    // y = Y * Z^(-1) mod p
    let y = mul_mod_p(point.Y, z_inv);

    // x = X * Z^(-1) mod p
    let x = mul_mod_p(point.X, z_inv);

    // Encode as 32 bytes (y-coordinate with sign bit)
    var result = y.number;

    // Set top bit if x is negative (odd)
    if ((x.number[7] & 1u) != 0u) {
        result[0] = result[0] | 0x80000000u;
    }

    return result;
}

// Main function: scalar multiplication of base point
// Takes clamped scalar as array<u32, 8>, returns public key
fn ed25519_scalar_mult_base_impl(scalar_bytes: array<u32, 8>) -> array<u32, 8> {
    // Convert scalar to i256
    let scalar = i256_from_u32_array(scalar_bytes, 1);

    // Get base point
    let base = edwards_base_point();

    // Perform scalar multiplication
    let result_point = edwards_scalar_mult(scalar, base);

    // Convert to public key format
    return edwards_to_public_key(result_point);
}
