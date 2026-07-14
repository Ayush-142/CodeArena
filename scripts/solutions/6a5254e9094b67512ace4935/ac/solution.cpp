// Known-AC reference solution for is-prime — verified against the real judging pipeline
// (Phase 7 seed data verification, all 6 hidden tests passed).
// Deliberately back on <bits/stdc++.h> (real contestants almost universally write this, not a
// targeted include) — this is the actual fix's regression test. It CE'd twice under the old
// 10s COMPILE_TIMEOUT_MS/from-source compile; worker/judge/Dockerfile now precompiles this
// header so the real per-submission compile is well under 1s. See that Dockerfile's comment.
#include <bits/stdc++.h>
int main() {
  long long n;
  std::cin >> n;
  if (n < 2) {
    std::cout << "NO" << std::endl;
    return 0;
  }
  for (long long i = 2; i * i <= n; i++) {
    if (n % i == 0) {
      std::cout << "NO" << std::endl;
      return 0;
    }
  }
  std::cout << "YES" << std::endl;
}
