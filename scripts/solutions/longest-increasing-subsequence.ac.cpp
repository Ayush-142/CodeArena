// Known-AC reference solution for longest-increasing-subsequence — O(n log n) patience
// sorting, verified against the real judging pipeline (Phase 7 seed data verification, all 6
// hidden tests passed, including the n=6000 stress test).
// <iostream>/<vector>/<algorithm>, not <bits/stdc++.h> — see is-prime.ac.cpp's comment on
// the compile-timeout risk that header carries.
#include <iostream>
#include <vector>
#include <algorithm>
int main() {
  int n;
  std::cin >> n;
  std::vector<long long> a(n);
  for (auto& x : a) std::cin >> x;
  std::vector<long long> tails;
  for (auto x : a) {
    auto it = std::lower_bound(tails.begin(), tails.end(), x);
    if (it == tails.end()) tails.push_back(x);
    else *it = x;
  }
  std::cout << tails.size() << std::endl;
}
