# Maximum Subarray Sum

You are given an array of `n` integers, which may be negative. Find the maximum possible
sum of a contiguous (non-empty) subarray.

## Input

- Line 1: a single integer `n` (`1 <= n <= 200000`).
- Line 2: `n` space-separated integers, each in `[-10000, 10000]`.

## Output

A single line containing the maximum subarray sum.

## Note

An `O(n^2)` solution that checks every pair of (start, end) indices will not fit in the
time limit on the largest test. An `O(n)` solution (e.g. Kadane's algorithm) is required.
