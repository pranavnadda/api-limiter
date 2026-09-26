<!-- Rate-Limiting Design Note: Trusted Proxy Requirement -->
## Security Design Note: client identity

The limiter does not trust a client-supplied identity.

### IP

`TRUSTED_PROXY_HOPS` is the number of addresses to take from the **right** of `x-forwarded-for`. `0` (the default) ignores `x-forwarded-for` and `x-real-ip`. The leftmost value is never used as the client, because that is the value an attacker can set.

`ALLOW_UNTRUSTED_FORWARDED=1` honors the leftmost forwarded address only when `NODE_ENV` is not `production`, so the local simulator can send a fake IP. Requests with no forwarding header use `127.0.0.1` in that mode, which covers the dashboard's EventSource connection. Production ignores that flag.

If no trusted IP can be determined and the request has no issued API key, the middleware returns `400 CLIENT_IP_REQUIRED`. Those requests are not grouped into one `unknown` bucket.

### API keys

`X-API-Key` or `Authorization: Bearer` becomes the limiter identity only when the value is listed in `API_KEYS` (or the issued-key list stored with live config). Any other value is ignored, and the request is limited by IP.
