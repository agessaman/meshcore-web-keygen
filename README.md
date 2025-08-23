# MeshCore Web Key Generator

A web application that generates Ed25519 keys compatible with MeshCore. Runs entirely in your browser.

## What it does

Generates Ed25519 key pairs where the public key starts with a specific hex prefix. MeshCore uses the first two characters of the public key as a node identifier, so this helps avoid collisions with neighboring nodes.

## Features

- Generate Ed25519 keys with custom hex prefixes (1-8 characters)
- Real-time progress display (attempts, speed, time)
- JSON export of generated keys
- Import instructions for MeshCore nodes
- URL parameter support for pre-filling prefixes

## Usage

1. Open `index.html` in a web browser
2. Enter a hex prefix (e.g., "F8", "F8A1")
3. Click "Generate Key"
4. Download the JSON file when complete

### URL Parameters

Pre-fill the prefix input:
- `index.html?prefix=FA` - Sets prefix to "FA"
- `index.html?prefix=f8a1` - Sets prefix to "F8A1"

## Key Format

- **Private Key**: 64 bytes (128 hex characters)
- **Public Key**: 32 bytes (64 hex characters)

## Performance

Typical speeds:
- Desktop: 10,000-50,000 keys/second
- Mobile: 1,000-10,000 keys/second

Expected time to find a key at 10k keys/second:
- 1-character prefix: ~0.01 seconds
- 2-character prefix: ~0.3 seconds
- 3-character prefix: ~4 seconds
- 4-character prefix: ~1 minute
- 5-character prefix: ~17 minutes
- 6-character prefix: ~4.5 hours
- 7-character prefix: ~3 days
- 8-character prefix: ~47 days

## Browser Support

Chrome 60+, Firefox 55+, Safari 11+, Edge 79+

## Importing to MeshCore

### Companion Nodes
1. Connect to your node using the MeshCore app
2. Tap the Settings gear icon
3. Tap "Manage Identity Key"
4. Paste your Private Key into the text box
5. Tap "Import Private Key"
6. Tap the checkmark ✓ to save changes

### Repeater Nodes
1. Flash companion firmware temporarily
2. Follow companion instructions above
3. Re-flash to repeater firmware

### JSON Import
1. MeshCore app → Import Config
2. Select downloaded JSON file

## Example Output

```json
{
  "public_key": "F8A1B2C3D4E5F6789012345678901234567890ABCDEF1234567890ABCDEF12",
  "private_key": "305e0b1b3142a95882915c43cd806df904247a2d505505f73dfb0cde9e666c4d656591bb4b5a23b6f47c786bf6cccfa0c4423c4617bbc9ab51dfb6f016f84144"
}
```

Filename: `meshcore_[PREFIX]_[TIMESTAMP].json`

## Security

- All processing happens in your browser
- No network requests during generation
- Keys never leave your device

## Troubleshooting

**Slow performance**: Close other tabs, use desktop, try shorter prefixes

**Browser freezes**: Refresh the page

**No match found**: Normal for difficult patterns, try shorter prefix
