# Skew. Overview

This widget uses the latest full snapshot from the tab's TradingView datasource. The expiration selector lists dates from that snapshot. **Auto** selects the nearest expiration with contracts as of the snapshot's New York calendar date. An explicit selection stays fixed if it leaves the configured range. DTE is the difference in calendar days from that snapshot date.

**Smile** plots implied volatility against strike, with brighter OTM lines, muted ITM lines, spot and ATM reference lines, and interpolated 25Δ wings. Shading shows where valid OTM bid IV is above or below ATM IV. **Term** plots ATM IV and both 25Δ wing IVs by calendar DTE. **Table** shows the contracts at each displayed strike, including their delta, IV, bid IV, bid, and ask.

The strike range applies to Smile and Table. **Auto** starts at ±5% of spot and extends to include any available 25Δ wing strikes. **±5%**, **±10%**, and **±20%** are fixed around spot. **All** shows the entire chain. The selected view, expiration mode, and range are saved per widget instance.

## Metrics

Each metric uses the full strip. ATM and wings use the quote validation and delta interpolation rules from [Skew. 0DTE](zero-dte-skew.md). Wing marker strikes use the same interpolation weights as their IVs.

| Metric | Calculation |
| --- | --- |
| ATM IV | Mean of the valid call and put IVs at the closest paired strike to spot. A tie selects the lower strike. |
| 25Δ Skew | Put IV at −25Δ minus call IV at +25Δ, in vol points. |
| 10Δ Skew | Put IV at −10Δ minus call IV at +10Δ, in vol points. |
| 25Δ Butterfly | Mean of both 25Δ wing IVs minus ATM IV, in vol points. |
| Skew Slope | Call +25Δ IV minus put −25Δ IV in vol points, divided by the width between their strikes in percentage points of spot. |
| Term Slope | Far ATM IV minus near ATM IV in vol points, multiplied by 30 and divided by the calendar days between those expirations. The endpoints are the earliest and latest valid ATM observations. |

Each metric displays `N/A` when its inputs are unavailable. A single expiration can produce Term points. Term Slope requires two valid ATM observations. Refresh the datasource to populate the widget after opening with only compact history.

The widget data contract is published under type `skew-overview`. Output includes `timestamp`, `expiration` (YYYYMMDD), `dte`, `contractCount`, `metrics`, `smile`, and `term`. ATM, wing, and quote IVs are fractions. Skew, butterfly, and both slope fields use the units in the table above. The published smile includes the full selected strip and marks which quotes pass validation.
