# TradingView configuration

IS-VOL creates `Documents/IS-VOL/config.json` on its first launch, next to the `Data` directory. The Documents location follows the operating system setting, including redirected Documents folders. Existing configuration files are never overwritten.

```json
{
  "tradingview": {
    "cookie": ""
  },
  "_examples": {
    "tradingview.cookie": "sessionid=YOUR_SESSION_ID; sessionid_sign=YOUR_SESSION_SIGNATURE; device_t=YOUR_DEVICE_TOKEN"
  }
}
```

Paste the value of your authenticated TradingView browser request's `Cookie` header into `tradingview.cookie`, without the `Cookie:` prefix. A full cookie string is accepted. Escape any embedded double quotes as `\"` to keep the JSON valid. `_examples` is documentation only and is never sent to the provider.

An empty or missing cookie keeps anonymous requests. A configured cookie is read before each snapshot request and sent with every TradingView option-chain request for every tab and expiry. Saving the file applies to the next snapshot request without restarting IS-VOL. Invalid JSON or an invalid cookie value fails the request with a configuration error instead of silently switching to anonymous access.

The cookie stays in the main process and is not added to dashboard state, widget data, or snapshot archives. It is sent only to `https://scanner.tradingview.com`; authenticated requests reject redirects. Yahoo underlying-price requests do not receive it. Keep this file private because the cookie grants access to your TradingView session.

Real-time OPRA access depends on your TradingView session and subscription. An expired session can return delayed data even with a configured cookie; replace the cookie with a current browser value.

Expand the Data settings and select the TradingView datasource to see the data mode from the last response. A yellow warning appears when any returned contract in any requested expiry has a delayed `update_mode`, including the maximum declared delay in minutes when available. All contracts must report `streaming` for the real-time status. Missing modes, empty chains, and unrecognized modes leave real-time access unconfirmed. Before the first response, the status asks you to refresh. The status updates with each successful snapshot and shows the last response time; it reports the feed mode, not whether a particular cookie is valid. Snapshot `time` remains the app's observation time, not the exchange quote time.
