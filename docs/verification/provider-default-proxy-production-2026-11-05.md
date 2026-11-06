# Custom Provider default proxy verification

On November 5, 2026, a test Pod running the release image inherited the Host proxy with `OMA_PROVIDER_PROXY_URL` unset. An unauthenticated model discovery request reached the upstream gateway and received HTTP 401. The proxy recorded a matching outbound connection from the Pod.

After the production API and Runner rollout, a verification Session sent a short prompt to a custom model. The Runner inherited `HTTP_PROXY`. The proxy connection matched the Runner, provider endpoint and request time. The model returned the expected text, the Turn completed, and the Session became idle. The public health check returned `ok`.
