// Known-AC reference solution for two-sum — verified against the real judging pipeline
// (Phase 7 seed data verification, all 5 hidden tests passed).
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
        std::cout << "YES " << i << " " << j << std::endl;
        return 0;
      }
    }
  }
  std::cout << "NO" << std::endl;
}
