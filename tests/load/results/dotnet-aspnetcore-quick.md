# Load result: dotnet-aspnetcore (quick)

Machine: Apple M4 Max, 16 cores, 48 GiB, Darwin 25.5.0 arm64, Node v24.5.0. Started 2026-11-21T15:08:52.846Z.

Fixture start command: `dotnet examples/DotnetConformance/bin/Release/net10.0/DotnetConformance.dll`.

## Idle overhead (bench disabled vs enabled; median of 6 alternating 1000 ms bursts)

| Route | Disabled rps | Enabled rps | Ratio | Disabled p50/p99 ms | Enabled p50/p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ready@1 | 19781.9 | 19707.9 | 0.996 | 0.05 / 0.11 | 0.05 / 0.11 | 0 |
| ready@16 | 58265 | 51543.2 | 0.885 | 0.38 / 1.01 | 0.34 / 1.02 | 0 |
| read@1 | 1747.6 | 1358.3 | 0.777 | 0.54 / 1.14 | 0.66 / 4.65 | 0 |
| read@16 | 8053.6 | 8407.6 | 1.044 | 1.29 / 6.21 | 1.33 / 5.89 | 0 |
| write@1 | 550.7 | 506.7 | 0.92 | 1.35 / 7.74 | 1.51 / 10.45 | 0 |
| write@16 | 2505.8 | 1768.1 | 0.706 | 0.38 / 302.74 | 0.5 / 762.7 | 0 |
| send@1 | - | 383.8 | - | - | 1.88 / 10.63 | 0 |
| send@16 | - | 2208.3 | - | - | 0.47 / 154.97 | 0 |
| observedSend@1 | - | 150.9 | - | - | 7.33 / 16.02 | 0 |
| observedSend@16 | - | 2270 | - | - | 0.5 / 152.4 | 0 |
| preview@1 | - | 1432 | - | - | 0.64 / 1.84 | 0 |
| preview@16 | - | 1686.3 | - | - | 0.32 / 151.71 | 0 |

Overall: PASS
