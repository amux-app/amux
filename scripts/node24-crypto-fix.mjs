/**
 * Node 24 compatibility shim: crypto.hash() one-shot API crashes on large Buffers
 * due to a V8 regression where TypedArray.prototype.join() is called on the
 * input, exceeding max string length for buffers >~256MB in aggregate.
 */

import { createHash } from 'node:crypto';
import crypto from 'node:crypto';

const major = parseInt(process.versions.node.split('.')[0], 10);

if (major >= 24 && typeof crypto.hash === 'function') {
  crypto.hash = function patchedHash(algorithm, data, outputEncoding) {
    const h = createHash(algorithm);
    h.update(data);
    return outputEncoding === 'buffer' ? h.digest() : h.digest(outputEncoding || 'hex');
  };
}
