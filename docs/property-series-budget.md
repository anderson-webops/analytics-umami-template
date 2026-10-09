# Property-series query budget

Event and session string/boolean and array series select the most frequent property values from the same filtered rows used for the chart. They return every requested time bucket for each selected value, rather than truncating the finished series. Ties are ordered by value. Null values remain distinct from empty strings.

The maximum is 50 values and 10,000 returned value-by-time points. The value limit decreases for finer or longer date ranges. Requests that cannot fit even one value fail before querying. PostgreSQL and ClickHouse queries have a 10-second execution limit; ClickHouse also enforces the result-row cap. Session property timestamps must fall within the requested range so an older property cannot create out-of-range buckets through a recent session event.

At the value cap, the chart omits the percentage column and doughnut chart because the returned values may be only a subset. Counts and time series remain counts of the selected values, not totals for every stored value. The API response keeps its existing array shape.
