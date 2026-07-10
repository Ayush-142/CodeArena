// Deliberately wrong: prints 0-indexed positions instead of the required 1-indexed ones, so
// the exact-match output comparison (worker/src/compare.ts) fails on every test, starting
// with the first. Used by scripts/simulate-contest.ts to produce a realistic WA verdict.
#include <bits/stdc++.h>
int main() {
  int n;
  long long t;
  std::cin >> n >> t;
  std::vector<long long> a(n + 1);
  for (int i = 1; i <= n; i++) std::cin >> a[i];
  for (int i = 1; i <= n; i++) {
    for (int j = i + 1; j <= n; j++) {
      if (a[i] + a[j] == t) {
        std::cout << "YES " << (i - 1) << " " << (j - 1) << std::endl;
        return 0;
      }
    }
  }
  std::cout << "NO" << std::endl;
}
