# OAuth Provider Reference

Notes on implementing social OAuth login (Google, Microsoft, Yahoo, Apple) in a web app with a server-side backend.

---

## General Pattern

The recommended flow for server-side web apps:

1. Frontend opens a popup to the provider's authorization URL
2. User authenticates and grants consent
3. Provider redirects the popup to your `redirect_uri` with an auth code
4. Popup sends the code back to the main window (via `postMessage` or `BroadcastChannel`)
5. Frontend POSTs the code to your backend
6. Backend exchanges the code for tokens at the provider's token endpoint
7. Backend verifies the ID token (via JWKS), extracts user info, issues your own session/JWT

---

## Cross-Origin-Opener-Policy (COOP) and Popups

If your app sets `Cross-Origin-Opener-Policy: same-origin-allow-popups` (required for Google Sign-In), `window.opener` will be `null` in your OAuth callback page after the popup has navigated through a cross-origin provider. The callback page can't `postMessage` back to the main window.

**Fix**: Use `BroadcastChannel` as a fallback. Both same-origin windows (main page and callback popup) can communicate through it even when `window.opener` is broken.

`oauth-callback.html`:
```html
<script>
    const params = new URLSearchParams(window.location.search);
    const payload = {
        type: 'oauth-callback',
        code:  params.get('code'),
        state: params.get('state'),
        error: params.get('error'),
        error_description: params.get('error_description')
    };
    if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(payload, window.location.origin); } catch(e) {}
    }
    try {
        const ch = new BroadcastChannel('oauth_callback');
        ch.postMessage(payload);
        ch.close();
    } catch(e) {}
    window.close();
</script>
```

Main app — listen on both:
```javascript
function waitForOAuthCode(popup) {
    return new Promise((resolve, reject) => {
        let done = false;
        const channel = new BroadcastChannel('oauth_callback');

        function finish(data) {
            if (done) return;
            done = true;
            window.removeEventListener('message', msgHandler);
            clearInterval(pollClosed);
            try { channel.close(); } catch(e) {}
            if (data instanceof Error) reject(data);
            else if (data.error) reject(new Error(data.error_description || data.error));
            else resolve(data);
        }

        const msgHandler = (e) => {
            if (e.origin !== window.location.origin) return;
            if (e.data?.type !== 'oauth-callback') return;
            finish(e.data);
        };
        window.addEventListener('message', msgHandler);

        channel.addEventListener('message', (e) => {
            if (e.data?.type !== 'oauth-callback') return;
            finish(e.data);
        });

        const pollClosed = setInterval(() => {
            if (popup.closed) finish(new Error('Popup closed'));
        }, 500);
    });
}
```

---

## JWKS Verification (RS256 + ES256)

Providers sign ID tokens with either RS256 (RSA) or ES256 (ECDSA). Your verifier should handle both. Uses Node.js built-in `crypto.subtle` — no libraries needed.

```javascript
const alg = header.alg || jwk.alg;
let importAlg, verifyAlg;
if (alg === 'ES256') {
    importAlg = { name: 'ECDSA', namedCurve: 'P-256' };
    verifyAlg = { name: 'ECDSA', hash: 'SHA-256' };
} else {
    // RS256
    importAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    verifyAlg = 'RSASSA-PKCS1-v1_5';
}
const cryptoKey = await webcrypto.subtle.importKey('jwk', jwk, importAlg, false, ['verify']);
const valid = await webcrypto.subtle.verify(verifyAlg, cryptoKey, signature, signingInput);
```

---

## Google

**Cost**: Free

**Flow**: ID token — no auth code or PKCE needed. The `@react-oauth/google` library handles the popup and returns a signed JWT credential directly.

**Verification**: POST the ID token to Google's tokeninfo endpoint:
```
GET https://oauth2.googleapis.com/tokeninfo?id_token=<token>
```
Google validates the signature and returns the payload. No JWKS verification needed on your end.

**Registration**: Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client ID

**Scopes**: `openid email profile`

**Notes**:
- Requires `Cross-Origin-Opener-Policy: same-origin-allow-popups` on your page or the sign-in popup will log a console warning
- No client secret needed for ID token verification

---

## Microsoft

**Cost**: Free — requires a free [Microsoft Azure account](https://azure.microsoft.com/free/)

**Flow**: Auth code + PKCE + server-side token exchange

**Registration**: Azure Portal → Microsoft Entra ID → App registrations → New registration
- Supported account types: choose "Personal Microsoft accounts only" for consumer accounts, or "Any Azure AD directory + personal" for both
- Redirect URI: Platform = Web → `https://yourapp.com/oauth-callback.html`
- After creating: Certificates & secrets → New client secret → copy the **Value** (not the secret ID)

**Endpoints**:
- Authorization: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- Token: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- JWKS: `https://login.microsoftonline.com/common/discovery/v2.0/keys`

Use the `common` tenant in all URLs to support both personal and organizational accounts.

**JWT algorithm**: RS256

**Issuer**: Dynamic — `https://login.microsoftonline.com/{tenantId}/v2.0`. Validate with a regex:
```javascript
/^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(iss)
```

**Email claim**: `payload.email || payload.preferred_username`

**Scopes**: `openid profile email`

**Token exchange** (server-side):
```javascript
{
    grant_type:    'authorization_code',
    code,
    redirect_uri,
    client_id,
    client_secret,
    code_verifier   // PKCE verifier
}
```

---

## Yahoo

**Cost**: Free

**Registration**: [developer.yahoo.com/apps/](https://developer.yahoo.com/apps/) → click **Create an App**

The interface is very minimal — just a single form with:
- Application Name
- Application Type (select **Web Application**)
- Homepage URL
- Redirect URIs
- OAuth Client Type: **Confidential Client** (for server-side web apps)
- API Permissions: check **OpenID Connect Permissions** → then check **Email** and **Profile** sub-options

**Flow**: Auth code + server-side token exchange. **Do NOT use PKCE** — Yahoo rejects `code_challenge` / `code_challenge_method` parameters for confidential clients with a misleading `unauthorized_client: invalid client id` error.

**Endpoints**:
- Authorization: `https://api.login.yahoo.com/oauth2/request_auth`
- Token: `https://api.login.yahoo.com/oauth2/get_token`
- JWKS: `https://api.login.yahoo.com/openid/v1/certs`

**JWT algorithm**: **ES256** (ECDSA P-256) — not RS256. Yahoo's JWKS contains both RSA and EC keys; their ID tokens use the EC key. Your verifier must support ES256.

**Issuer**: `https://api.login.yahoo.com`

**Client ID**: The long base64 `dj0y...` Consumer Key shown in the developer portal.

**Scopes**: `openid profile email`

---

## Apple

**Cost**: **$99/year** Apple Developer Program membership required

**Flow**: Auth code + server-side token exchange, but Apple uses a non-standard client secret: you generate it yourself as a signed ES256 JWT using a `.p8` private key downloaded from Apple's developer portal. The JWT expires and must be regenerated periodically (max 6 months).

**Registration**: developer.apple.com → Certificates, Identifiers & Profiles → App IDs + Service IDs

**Quirk**: Apple only returns the user's name on the **very first** sign-in. After that, only the email is provided. You must capture and store the name on first login.

**Scopes**: `name email`

---

## Provider Summary

| Provider | Cost | Flow | JWT Alg | PKCE |
|----------|------|------|---------|------|
| Google | Free | ID token direct | RS256 | N/A |
| Microsoft | Free (Azure account) | Auth code | RS256 | Yes |
| Yahoo | Free | Auth code | **ES256** | No |
| Apple | $99/year | Auth code | ES256 | Yes |
