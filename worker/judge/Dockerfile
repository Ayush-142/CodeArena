# Judge sandbox image — extends the stock gcc:12-bookworm with a precompiled bits/stdc++.h
# header (a .gch file). Real contestant C++ is written against #include <bits/stdc++.h> almost
# universally; compiling that header from source measured 5.9-10.9s standalone on a modest dev
# box, which sits right at/over worker/src/sandbox.ts's compile timeout. Precompiling it here
# drops a real per-submission compile to well under 1s (measured: ~0.86s for a trivial program).
#
# CRITICAL — do not hand-edit the flags below. The flags used to build the .gch MUST exactly
# match the flags worker/src/sandbox.ts passes to g++ for the real per-submission compile, or
# GCC silently rejects the stale .gch and falls back to compiling the header from source on
# every submission — no error, no warning, the fix just silently stops applying. Verified this
# failure mode directly: with mismatched flags, `g++ -H` prints `x <path>.gch` (rejected)
# instead of `! <path>.gch` (used).
#
# Single source of truth: worker/judge/compile-flags.txt, read by both this Dockerfile (COPY +
# cat below) and worker/src/sandbox.ts (readFileSync at runtime) — the same bytes, so the two
# cannot drift apart.
#
# Pinned by digest per ARCHITECTURE.md §6 ("Base images: pinned digests ... never latest in
# production") — never a floating tag, so a `docker build` next month can't silently swap in a
# different gcc:12-bookworm build (which could also invalidate the .gch's flag-match, per the
# comment above). Re-resolve with `docker inspect gcc:12-bookworm --format
# '{{index .RepoDigests 0}}'` after a deliberate, tested upgrade — never edit this blindly.
FROM gcc:12-bookworm@sha256:112aacdc53e949b9d2ccefb9ed64930a7fda5e10e007430f244be27e0263220b

COPY worker/judge/compile-flags.txt /opt/judge/compile-flags.txt

# The exact on-disk path of bits/stdc++.h is resolved dynamically (via `find`), not hardcoded
# to a specific gcc point-release path (e.g. .../12.5.0/...) — that version string is baked
# into gcc:12-bookworm's own build and would silently break this COPY-free `find` on a future
# rebuild of that upstream image otherwise.
RUN set -eu; \
    HDR=$(find /usr/local/include/c++ -path '*/x86_64-linux-gnu/bits/stdc++.h' | head -1); \
    if [ -z "$HDR" ]; then echo "bits/stdc++.h not found under /usr/local/include/c++" >&2; exit 1; fi; \
    FLAGS=$(cat /opt/judge/compile-flags.txt); \
    g++ $FLAGS -x c++-header -o "$HDR.gch" "$HDR"; \
    # Fail the build loudly if the .gch didn't actually get used for a real compile with the
    # same flags — a silently-broken PCH is worse than no PCH (see the header comment above).
    printf '#include <bits/stdc++.h>\nint main(){}\n' > /tmp/pch-check.cpp; \
    g++ $FLAGS -H -fsyntax-only /tmp/pch-check.cpp 2>/tmp/pch-check.log; \
    grep -q "^! .*stdc++.h.gch" /tmp/pch-check.log || { \
      echo "PRECOMPILED HEADER WAS NOT USED — see /tmp/pch-check.log:" >&2; \
      cat /tmp/pch-check.log >&2; \
      exit 1; \
    }; \
    rm -f /tmp/pch-check.cpp /tmp/pch-check.log
