// Deliberately wrong: missing the n<2 special case, so n=1 falls through the trial-division
// loop untested (2*2=4 > 1, loop body never runs) and incorrectly prints YES. Fails the
// hidden test for n=1 (expected NO). Used by scripts/simulate-contest.ts to produce a
// realistic WA verdict.
#include <bits/stdc++.h>
int main() {
  long long n;
  std::cin >> n;
  for (long long i = 2; i * i <= n; i++) {
    if (n % i == 0) {
      std::cout << "NO" << std::endl;
      return 0;
    }
  }
  std::cout << "YES" << std::endl;
}
