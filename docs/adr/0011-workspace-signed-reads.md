# ADR-0011: Direct Workspace reads through signed OSS URLs

## Status

Accepted, 2026-09-18. Updates ADR-0009's file-read response and ADR-0008's
restriction of browser signing to the regional public endpoint. Workspace
ownership, object keys, writes and mounted Sandbox access are unchanged.

## Decision

`GET /v1/workspaces/{id}/files/{path}` returns a JSON read descriptor, not file
bytes. The descriptor contains `path`, `url`, `expiresIn`, `expiresAt`, `size`,
`contentType`, and `etag` when available. It is the single read entry point for
program clients, browser previews and downloads; the separate `preview-url`
endpoint is removed. Responses use `Cache-Control: no-store`; the default
lifetime is 600 seconds, bounded to 60–900 seconds.

Before signing, the Host authenticates the Tenant, checks Workspace ownership,
validates the relative path and reads object metadata with OSS HEAD. It does not
GET the file body to discover its size, type or existence. An absent file returns
404; storage errors are sanitized. A backend without signed-read support returns
501 rather than silently falling back to buffered file transfer.

Browsers and program clients fetch the signed URL directly, without forwarding
the API's Authorization or x-api-key headers. The browser gives the URL to native
image, audio and video elements. Text preview reads OSS directly with a bounded
size; selecting another file cancels pending requests. Programs stream the
response to their destination. Persist Workspace IDs and paths, not signed URLs.

`download=1` requests a signed attachment response with the original filename.
Preview URLs must not be reused as attachment URLs: cross-origin anchor download
attributes do not substitute for the storage response's Content-Disposition.

The Host's configured public signing endpoint can be either the regional HTTPS
endpoint or an explicitly configured public HTTPS custom domain attached to the
Bucket. The latter is required where OSS default-domain policies prevent inline
previews. SDK CNAME signing uses the configured domain directly. Regional URLs
preserve stored Content-Type because this Bucket's default endpoint has rejected
Content-Type overrides; custom-domain URLs can request inferred MIME. Signing
never mutates the object. Browser text reads and media elements using anonymous
CORS require Bucket CORS settings.

## Consequences

The project is pre-release, so it has one read contract and no compatibility
aliases or buffered HTTP fallback. The web console, Python integration example,
verification scripts, API tests and OpenAPI contract all use this descriptor.
The Host retains internal object reads for operations such as rename and mount
verification.

Signed links are temporary bearer credentials. Revoking application permission
prevents new links but does not immediately revoke previously issued links.
Clients refresh expired links with a bounded retry; they must not interpret every
403 as expiration. Same-path overwrites remain possible, so programs that resume
partial transfers need to check object identity/ETag before appending bytes.

Production rollout must verify the configured preview domain, HTTPS, CORS,
stored/generic MIME files, Range/206 video seeking, Unicode attachment names,
expiry recovery and file-switch cancellation. Local SDK protocol fixtures are
not proof that live Bucket policies or a custom domain are configured.
