// Known-AC reference solution for is-prime — verified against the real judging pipeline
// (Phase 7 seed data verification, all 6 hidden tests passed).
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
