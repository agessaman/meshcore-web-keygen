# MeshCore Web Key Generator

A client-side web application for generating MeshCore-compatible Ed25519 vanity keys using the [noble-ed25519](https://github.com/paulmillr/noble-ed25519) library.

## Features

- **Client-side only**: All key generation happens in your browser - keys never leave your device
- **MeshCore compatible**: Generates keys in the exact format MeshCore expects
- **Vanity prefixes**: Search for keys starting with specific 2 or 4 character hex prefixes
- **Real-time progress**: Shows attempts, speed, and estimated progress
- **JSON export**: Download keys in MeshCore-compatible JSON format
- **Modern UI**: Clean, responsive design that works on desktop and mobile

## Usage

1. Open `meshcore-web-keygen.html` in any modern web browser
2. Select the prefix length (2 or 4 characters)
3. Enter your desired hex prefix (e.g., "F8" or "F8A1")
4. Click "Generate Key" and wait for a match
5. Download the JSON file when complete

## Key Format

The generated keys follow MeshCore's Ed25519 format:

- **Private Key**: 64 bytes (128 hex characters)
  - First 32 bytes: Clamped scalar for Ed25519
  - Last 32 bytes: Random filler
- **Public Key**: 32 bytes (64 hex characters)
  - Derived from the clamped scalar using `crypto_scalarmult_ed25519_base_noclamp`

## Probability

- **2-character prefix**: 1 in 256 chance (0.39%)
- **4-character prefix**: 1 in 65,536 chance (0.0015%)

## Performance

Performance varies by device:
- Modern desktop: ~10,000-50,000 keys/second
- Mobile devices: ~1,000-10,000 keys/second
- 2-character prefixes typically found in seconds
- 4-character prefixes may take minutes to hours

## Security

- All processing happens locally in your browser
- No network requests are made during key generation
- Keys are never transmitted to any server
- Uses cryptographically secure random number generation
- Implements proper Ed25519 scalar clamping

## Browser Compatibility

- Chrome/Chromium 60+
- Firefox 55+
- Safari 11+
- Edge 79+

Requires support for:
- Web Crypto API
- ES6 async/await
- Modern JavaScript features

## Example Output

The downloaded JSON file contains:

```json
{
  "public_key": "F8A1B2C3D4E5F6789012345678901234567890ABCDEF1234567890ABCDEF12",
  "private_key": "305e0b1b3142a95882915c43cd806df904247a2d505505f73dfb0cde9e666c4d656591bb4b5a23b6f47c786bf6cccfa0c4423c4617bbc9ab51dfb6f016f84144",
  "generated_at": "2024-01-15T10:30:45.123Z",
  "target_prefix": "F8A1",
  "prefix_length": 4
}
```

## Comparison with Python Version

| Feature | Python Version | Web Version |
|---------|---------------|-------------|
| Performance | Very high (multi-core) | Moderate (single-thread) |
| Complexity | Advanced patterns | Simple prefixes only |
| Portability | Requires Python setup | Works in any browser |
| Security | Local processing | Local processing |
| UI | Command line | Modern web interface |

## Troubleshooting

**Slow performance**: 
- Close other browser tabs
- Use a desktop computer instead of mobile
- Try shorter prefixes (2 characters)

**Browser freezes**:
- The app yields control every 1000 attempts
- If it still freezes, try refreshing the page

**No match found**:
- This is normal for difficult patterns
- Try a shorter prefix
- Be patient - some patterns take time

## Technical Details

The web version implements the same MeshCore key generation algorithm as the Python version:

1. Generate 32-byte random seed
2. SHA-512 hash the seed
3. Apply Ed25519 scalar clamping to first 32 bytes
4. Generate public key using `crypto_scalarmult_ed25519_base_noclamp`
5. Create 64-byte private key: `[clamped_scalar][random_filler]`

The main difference is that the web version uses the noble-ed25519 library instead of PyNaCl, but the core algorithm remains the same.
