# OIDC single sign-on

Vibeable supports a generic OpenID Connect authorization-code flow with PKCE. Configure this exact redirect URI at the identity provider:

```text
${PUBLIC_URL}/api/auth/oidc/callback
```

The provider must return a signed ID token containing `sub`, `email`, and normally `email_verified`. Vibeable validates issuer, audience, signature, expiry, nonce, one-time state, and an allowlist of signing algorithms. Discovery, token, JWKS, and UserInfo requests use bounded responses, timeouts, disabled redirects, DNS checks, and connection pinning.

OIDC feeds the same persisted organization roles and team memberships described in the [User guide](user-guide.md#roles). It is authentication and provisioning, not a second authorization system.

## Minimum configuration

```dotenv
OIDC_ENABLED=true
OIDC_ISSUER=https://idp.example.com/application/o/vibeable
OIDC_CLIENT_ID=vibeable
OIDC_CLIENT_SECRET=replace-with-a-random-client-secret
OIDC_ORGANIZATION_SLUG=acme
OIDC_AUTO_PROVISION=true
OIDC_ALLOWED_EMAIL_DOMAINS=acme.example
OIDC_ROLE_MAPPING={"vibeable-admins":"admin","vibeable-developers":"developer"}
OIDC_TEAM_MAPPING={"platform-team":"platform","product-team":"product"}
```

The team mapping values are existing Vibeable team slugs. A login fails when a matched mapping references a missing team, making configuration mistakes visible instead of silently changing access.

## Provisioning and linking

- `OIDC_DEFAULT_ROLE` defaults to `viewer`.
- IdP claims can grant `admin`, `developer`, `reviewer`, or `viewer`; they can never grant `owner`.
- `OIDC_AUTO_PROVISION=false` prevents creation of new users.
- `OIDC_ALLOW_EMAIL_LINKING=false` prevents a new OIDC identity from attaching to an existing local account. Enable it temporarily only when the IdP is authoritative for verified email addresses.
- `OIDC_SYNC_TEAM_MEMBERSHIPS=true` synchronizes only memberships previously created by OIDC. Locally managed memberships and organization roles win and are never deleted by claim synchronization.
- `OIDC_ALLOWED_EMAIL_DOMAINS` is optional but recommended when automatic provisioning is enabled.

Keep `LOCAL_LOGIN_ENABLED=true` for a tested break-glass owner account. After the first successful SSO login, automatic provisioning or email linking can be disabled without affecting identities that are already linked.

## Self-hosted providers

Private IdP endpoints require `OIDC_ALLOW_PRIVATE_ENDPOINTS=true`. Plain HTTP additionally requires `OIDC_ALLOW_INSECURE_HTTP=true` and should be limited to an isolated development network. Production deployments should use HTTPS and a trusted internal CA.

The default client authentication method is `client_secret_basic`. Public PKCE clients can use:

```dotenv
OIDC_CLIENT_AUTH_METHOD=none
OIDC_CLIENT_SECRET=
```

For nested group claims, set a dotted claim path such as `OIDC_GROUPS_CLAIM=realm_access.roles`.

For reverse-proxy, backup, and recovery requirements around SSO, see the [Operator guide](operator-guide.md).
