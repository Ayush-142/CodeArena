# Two Sum

You are given `n` integers `a[1..n]` and a target `T`. Find two **distinct** 1-indexed
positions `i < j` such that `a[i] + a[j] = T`.

If multiple pairs work, print the one with the smallest `i`, and among those the smallest `j`.
If no such pair exists, print `NO`.

## Input

- Line 1: two integers `n` and `T` (`2 <= n <= 2000`, `-10^9 <= T <= 10^9`).
- Line 2: `n` integers `a[1], ..., a[n]` (`-10^9 <= a[k] <= 10^9`).

## Output

If a valid pair exists, print `YES i j` (space-separated, `i < j`). Otherwise print `NO`.
