// Deliberately wrong: uses upper_bound instead of lower_bound, computing the longest
// NON-decreasing subsequence instead of the required STRICTLY increasing one. Matches on
// all-distinct inputs but fails on the "all equal" hidden test (expects 1, this gives 6).
// Used by scripts/simulate-contest.ts to produce a realistic WA verdict.
#include <bits/stdc++.h>
int main() {
  int n;
  std::cin >> n;
  std::vector<long long> a(n);
  for (auto& x : a) std::cin >> x;
  std::vector<long long> tails;
  for (auto x : a) {
    auto it = std::upper_bound(tails.begin(), tails.end(), x);
    if (it == tails.end()) tails.push_back(x);
    else *it = x;
  }
  std::cout << tails.size() << std::endl;
}
