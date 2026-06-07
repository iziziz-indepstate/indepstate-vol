# Vol Upfront Widget

`Vol Upfront` calculates implied forward volatility between adjacent `Straddle ATM` expiries on the same tab.

## Data Source

The widget does not fetch market data directly. It reads published `Straddle ATM` widget outputs from the current tab, sorts those readings by DTE, and calculates one forward-vol segment for each adjacent pair.

At least two valid `Straddle ATM` readings are required.

## Calculation

For each straddle point:

```text
totalVariance = iv * iv * dte
```

For adjacent expiries:

```text
forwardVariance = (totalVarianceTo - totalVarianceFrom) / (dteTo - dteFrom)
forwardVol = sqrt(forwardVariance)
```

If `forwardVariance` is negative, the segment is marked:

```text
invalid_negative_forward_variance
```

The widget does not take the square root of negative variance.

## Output

The widget renders:

- a forward-vol chart by adjacent segment
- source straddle readings: label, DTE, ATM IV
- segment table with DTE range, total variance, forward variance, forward vol, and status

`Vol Upfront` refreshes when a source `Straddle ATM` widget republishes its output.
