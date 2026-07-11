// Known-AC reference solution for is-prime — verified against the real judging pipeline
// (Phase 7 seed data verification, all 6 hidden tests passed).
// Deliberately <iostream>, not <bits/stdc++.h>: the latter took 6-11s to compile standalone
// on a modest dev box under worker/src/sandbox.ts's 10s COMPILE_TIMEOUT_MS — i.e. already at
// or over budget with zero other load, causing a real, reproducible CE. Found while
// re-verifying the prod-mode contest smoke test.
#include <iostream>
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
