// Deliberately slow: a fixed busy-loop before the real computation, sized to exceed any
// judge time limit regardless of which hidden test it runs against. `volatile` prevents g++
// -O2 (see worker/src/sandbox.ts's compile step) from optimizing the loop away as dead code.
// Used by scripts/simulate-contest.ts to produce a realistic TLE verdict.
#include <bits/stdc++.h>
int main() {
  int n;
  long long t;
  std::cin >> n >> t;
  std::vector<long long> a(n + 1);
  for (int i = 1; i <= n; i++) std::cin >> a[i];
  volatile long long busy = 0;
  for (long long i = 0; i < 3000000000LL; i++) {
    busy += i;
  }
  for (int i = 1; i <= n; i++) {
    for (int j = i + 1; j <= n; j++) {
      if (a[i] + a[j] == t) {
        std::cout << "YES " << i << " " << j << std::endl;
        return 0;
      }
    }
  }
  std::cout << "NO" << std::endl;
}
