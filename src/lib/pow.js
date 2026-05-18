// Proof-of-Work solver. Computes a `solution` string such that
//   sha256(nonce + ':' + solution)
// has at least `difficulty` leading zero bits in its raw-byte form.
//
// Runs in the MV3 service worker (Chrome / Edge) and in the Firefox
// event-page background — both expose Web Crypto via `crypto.subtle`
// without any extra permissions. Computation yields back to the event
// loop every 5000 iterations so the SW message pump can still respond
// to other handlers while a solve is in progress.
//
// At 20-bit difficulty, expected ~1M trials = ~0.3-1.5 seconds on a
// modern desktop, 2-4 seconds on cheap mobile. The popup calls
// `solvePow` in the background context (not on the UI thread) so the
// form input stays responsive throughout.
//
// Solver is also resilient to a slow / aborted SW: the iteration
// counter is just a local; if the SW is killed and respawned, the
// next solveTokenForChallenge restarts from i=0 against a fresh
// challenge fetch. We never persist intermediate state — there's
// nothing to persist.

(function (root) {
  'use strict';

  function countLeadingZeroBits(bytes) {
    var count = 0;
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i];
      if (byte === 0) { count += 8; continue; }
      var b = byte;
      while ((b & 0x80) === 0) { count++; b <<= 1; }
      return count;
    }
    return count;
  }

  async function sha256(str) {
    var enc = new TextEncoder();
    var buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return new Uint8Array(buf);
  }

  // Solve. Returns the solution string. Iteration cap prevents an
  // adversarial challenge from looping forever — at 20-bit difficulty
  // the probability of NOT finding a solution within 100M trials is
  // ~e^-95, vanishingly small; if we somehow blow past it, reject.
  async function solvePow(nonce, difficulty) {
    var MAX_ITERS = 100 * 1000 * 1000; // ~100M
    var YIELD_EVERY = 5000;
    var i = 0;
    while (i < MAX_ITERS) {
      // Base-36 packs more entropy per character than base-10 — keeps
      // the solution string short and the over-the-wire payload tiny.
      var solution = i.toString(36);
      var hash = await sha256(nonce + ':' + solution);
      if (countLeadingZeroBits(hash) >= difficulty) return solution;
      i++;
      if ((i % YIELD_EVERY) === 0) {
        // Yield to the event loop so the SW can dispatch other
        // messages (popup state queries etc.) while we're mining.
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
    throw new Error('PoW solver exhausted iteration cap');
  }

  root.Pow = { solve: solvePow };
})(typeof self !== 'undefined' ? self : this);
