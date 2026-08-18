# coturn setup

TURN/STUN relay for calls (`apps/web/app/api/calls/turn-credentials/route.ts`),
deployed on the same droplet as `comm-web`/`comm-worker` — see `turnserver.conf`'s
own header comment for why this deviates from docs/11's "separate VM" default.

## One-time setup (already done on the current production droplet)

```bash
apt-get install -y coturn
cp infrastructure/coturn/turnserver.conf /etc/turnserver.conf
# Replace the placeholder secret with a real one, e.g.:
openssl rand -hex 32
# ...and set it as static-auth-secret= in /etc/turnserver.conf, byte-for-byte
# identical to TURN_SHARED_SECRET in apps/web/.env.
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable --now coturn
```

Then in `apps/web/.env`:
```
TURN_SHARED_SECRET="<the same secret>"
TURN_URLS="turn:apk4game.com:3478"
```
and reload `comm-web` (`pm2 reload comm-web --update-env`) — no app code changes
needed, `POST /api/calls/turn-credentials` already reads these at request time.

## Verifying it's actually working

A same-network call succeeding proves nothing about TURN specifically (it works
via host candidates alone even with an empty ICE list). To prove the relay itself
works, mint a REST-API credential and drive a real allocation:

```bash
python3 -c "
import hmac, hashlib, base64, time
secret = '<the real secret>'
expiry = int(time.time()) + 600
username = f'{expiry}:test-user'
print(username, base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode())
"
turnutils_uclient -y -u '<username>' -w '<credential>' -t <server-ip>
```
`0 lost packets` in the output means the TURN relay itself round-tripped real
traffic, not just that the process is running and answering STUN pings
(`turnutils_stunclient` alone doesn't exercise authentication or relaying at all).

The real, live-user-facing test is still two devices on genuinely different
networks (e.g. cellular data + wifi, or one behind a VPN) placing a call — that's
the only way to prove ICE actually falls back to the relay candidate in practice,
not just that the relay is reachable in isolation.

## Rotating the shared secret

Update both `static-auth-secret` in `/etc/turnserver.conf` and `TURN_SHARED_SECRET`
in `apps/web/.env` together, `systemctl restart coturn`, then reload `comm-web`.
Any credentials already minted under the old secret simply stop working — they're
only ever valid for 10 minutes anyway, so there's no meaningful transition window
to manage.
