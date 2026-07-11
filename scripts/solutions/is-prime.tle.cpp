// Deliberately slow: a fixed busy-loop before the real computation, sized to exceed any
// judge time limit regardless of which hidden test it runs against. `volatile` prevents g++
// -O2 (see worker/src/sandbox.ts's compile step) from optimizing the loop away as dead code.
// Used by scripts/simulate-contest.ts to produce a realistic TLE verdict.
// <iostream>, not <bits/stdc++.h> — see is-prime.ac.cpp's comment on the compile-timeout risk.
#include <iostream>
int main() {
  long long n;
  std::cin >> n;
  volatile long long busy = 0;
  for (long long i = 0; i < 3000000000LL; i++) {
    busy += i;
  }
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
