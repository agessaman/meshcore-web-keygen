# MeshCore Web Key Generator

A client-side web application for generating MeshCore-compatible Ed25519 keys. The application runs entirely in your browser and generates keys that match the exact format expected by MeshCore.

## Features

- **Client-side processing**: All key generation happens locally in your browser
- **MeshCore compatibility**: Generates keys in the format MeshCore expects
- **Custom prefixes**: Search for keys starting with specific hex prefixes (1-8 characters)
- **Real-time progress**: Shows attempts, generation speed, and elapsed time
- **JSON export**: Download generated keys in a structured format
- **Import instructions**: Built-in guidance for importing keys into MeshCore

## How It Works

MeshCore uses the first two characters of your public key as a node identifier. This tool helps you generate keys with specific prefixes to avoid collisions with neighboring nodes.

The key generation process:
1. Generates a 32-byte random seed
2. Applies SHA-512 hashing
3. Performs Ed25519 scalar clamping
4. Derives the public key using the clamped scalar
5. Creates a 64-byte private key with the clamped scalar and random filler

## Usage

1. Open `index.html` in a modern web browser
2. Enter your desired hex prefix (e.g., "F8", "F8A1", "FFF")
3. Click "Generate Key" to start the search
4. Wait for a matching key to be found
5. Download the JSON file or copy the keys manually

## Key Format

Generated keys follow MeshCore's Ed25519 specification:

- **Private Key**: 64 bytes (128 hex characters)
  - First 32 bytes: Clamped scalar for Ed25519
  - Last 32 bytes: Random filler
- **Public Key**: 32 bytes (64 hex characters)
  - Derived from the clamped scalar

## Performance

Generation speed depends on your device:
- Modern desktop: ~10,000-50,000 keys/second
- Mobile devices: ~1,000-10,000 keys/second

Expected time to find a key:
- 1-character prefix: ~0.1 seconds
- 2-character prefix: ~1-10 seconds
- 3-character prefix: ~1-10 minutes
- 4-character prefix: ~1-10 hours
- Longer prefixes: May take days or longer

## Browser Requirements

- Chrome/Chromium 60+
- Firefox 55+
- Safari 11+
- Edge 79+

Requires support for:
- Web Crypto API
- ES6 modules
- Modern JavaScript features

## Importing Keys

### Companion Nodes
1. Connect to your node using the MeshCore app
2. Tap the Settings gear icon
3. Tap "Manage Identity Key"
4. Paste your Private Key into the text box
5. Tap "Import Private Key"
6. Tap the checkmark ✓ to save changes

### Repeater Nodes
1. Temporarily flash companion firmware first
2. Follow the companion instructions above
3. Re-flash to repeater firmware after importing

### JSON Import
1. In MeshCore app settings, tap "Import Config"
2. Select your downloaded JSON file
3. Keys will be automatically imported

## Example Output

The downloaded JSON contains:

```json
{
  "public_key": "F8A1B2C3D4E5F6789012345678901234567890ABCDEF1234567890ABCDEF12",
  "private_key": "305e0b1b3142a95882915c43cd806df904247a2d505505f73dfb0cde9e666c4d656591bb4b5a23b6f47c786bf6cccfa0c4423c4617bbc9ab51dfb6f016f84144"
}
```

The filename follows the pattern: `meshcore_[PREFIX]_[TIMESTAMP].json`

## Security Notes

- All processing happens locally in your browser
- No network requests are made during key generation
- Keys are never transmitted to any server
- Uses cryptographically secure random number generation
- Implements proper Ed25519 scalar clamping

## Troubleshooting

**Slow performance**: 
- Close other browser tabs
- Use a desktop computer instead of mobile
- Try shorter prefixes

**Browser becomes unresponsive**:
- The app yields control every 1000 attempts
- If it still freezes, refresh the page

**No match found**:
- This is normal for difficult patterns
- Try a shorter prefix
- Be patient - some patterns take significant time

## Technical Implementation

The web version implements the same MeshCore key generation algorithm as the Python reference implementation:

1. Generate 32-byte random seed
2. SHA-512 hash the seed
3. Apply Ed25519 scalar clamping to first 32 bytes
4. Generate public key using the clamped scalar
5. Create 64-byte private key: `[clamped_scalar][random_filler]`

The application uses the noble-ed25519 library for cryptographic operations and includes fallback mechanisms for offline use.
