// Deliberately slow: a fixed busy-loop before the real computation, sized to exceed any
// judge time limit regardless of which hidden test it runs against. `volatile` prevents g++
// -O2 (see worker/src/sandbox.ts's compile step) from optimizing the loop away as dead code.
// Used by scripts/simulate-contest.ts to produce a realistic TLE verdict.
#include <bits/stdc++.h>
int main() {
  int n;
  std::cin >> n;
  std::vector<long long> a(n);
  for (auto& x : a) std::cin >> x;
  volatile long long busy = 0;
  for (long long i = 0; i < 3000000000LL; i++) {
    busy += i;
  }
  std::vector<long long> tails;
  for (auto x : a) {
    auto it = std::lower_bound(tails.begin(), tails.end(), x);
    if (it == tails.end()) tails.push_back(x);
    else *it = x;
  }
  std::cout << tails.size() << std::endl;
}
