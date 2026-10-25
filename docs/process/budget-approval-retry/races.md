# Repeated approval retry races

Own isolated-fixture checks on 25 October 2026, source `c2115e9f7` before the
documentation rebase onto main `90ec96bc6`. The rebase left the dispatch code and
HTTP tests unchanged. Every run used `nice -n 10`, one worker and fresh fixtures.
No live qualification ran. Durations include fixture setup and the whole test.

Each case requires one successful retry, one refusal, one send, two saved consent
uses and one budget admission. The free tool holds and settles zero cents.
Later retries send nothing. **PASS: 30/30 saved-start and 30/30 budget-admission cases.**

| Run | Saved start | Duration (ms) | Budget admission | Duration (ms) |
| --- | --- | ---: | --- | ---: |
| 1 | PASS | 19715 | PASS | 9568 |
| 2 | PASS | 13345 | PASS | 9582 |
| 3 | PASS | 11978 | PASS | 8743 |
| 4 | PASS | 12491 | PASS | 8490 |
| 5 | PASS | 12799 | PASS | 10208 |
| 6 | PASS | 15477 | PASS | 9839 |
| 7 | PASS | 11488 | PASS | 8907 |
| 8 | PASS | 11907 | PASS | 9236 |
| 9 | PASS | 13187 | PASS | 7940 |
| 10 | PASS | 11819 | PASS | 8944 |
| 11 | PASS | 13957 | PASS | 9328 |
| 12 | PASS | 12463 | PASS | 10693 |
| 13 | PASS | 14199 | PASS | 11708 |
| 14 | PASS | 17161 | PASS | 12856 |
| 15 | PASS | 19011 | PASS | 16347 |
| 16 | PASS | 17084 | PASS | 12773 |
| 17 | PASS | 19793 | PASS | 14362 |
| 18 | PASS | 17877 | PASS | 18621 |
| 19 | PASS | 17922 | PASS | 12861 |
| 20 | PASS | 15952 | PASS | 11493 |
| 21 | PASS | 19001 | PASS | 13397 |
| 22 | PASS | 17369 | PASS | 15029 |
| 23 | PASS | 17103 | PASS | 12574 |
| 24 | PASS | 15607 | PASS | 11270 |
| 25 | PASS | 20455 | PASS | 18219 |
| 26 | PASS | 21005 | PASS | 16108 |
| 27 | PASS | 19579 | PASS | 16473 |
| 28 | PASS | 19374 | PASS | 16637 |
| 29 | PASS | 18451 | PASS | 13748 |
| 30 | PASS | 17100 | PASS | 13018 |

These results do not identify the causes of earlier 29/30 and 53/60 failures.
The [receipt](receipt.md) keeps those failures and the separate broad-test timeout explicit.
