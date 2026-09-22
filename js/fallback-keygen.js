import { searchVanityPrefix } from './ed25519-vanity.js';

export async function searchVanityKey(options) {
    const {
        targetPrefix,
        shouldStop,
        onAttempted
    } = options;

    if (typeof shouldStop !== 'function') {
        throw new Error('shouldStop callback is required');
    }

    return searchVanityPrefix({
        targetPrefix,
        shouldStop,
        onAttempted
    });
}
