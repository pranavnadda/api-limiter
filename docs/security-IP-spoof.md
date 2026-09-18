<!-- Rate-Limiting Design Note: Trusted Proxy Requirement -->
## Security Design Note: x-forwarded-for Trust

This rate limiter reads the client's IP from `x-forwarded-for`. That header is set by proxies (Vercel, nginx, Cloudflare) but can be spoofed by clients connecting directly.

BEHAVIOR:
- Behind a trusted proxy: accurate per-IP rate limiting.
- Direct connection: clients can set arbitrary `x-forwarded-for` values to bypass limits.

PORTFOLIO NOTE: This is a documented trade-off (not a hidden bug). Production deployments should place the server behind a trusted proxy or validate the header against a whitelist.
