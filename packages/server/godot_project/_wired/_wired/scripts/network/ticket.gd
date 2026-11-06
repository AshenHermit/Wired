class_name WiredTicket
extends RefCounted

## Short-lived, single-use ticket shared with the Godot runtime through the
## `WIRED_GAME_TICKET_SECRET` environment variable.
##
## Format: `<exp_unix>.<nonce>.<hex_hmac_sha256>`
## Signed message: `<room>:<exp_unix>:<nonce>`
##
## The backend mints tickets; the Godot server only verifies them. A ticket is
## burned by the runtime on first successful verification (`_used_nonces`).

static func verify(
	ticket: String, secret: String, room: String, now_unix: float
) -> Dictionary:
	var parts := ticket.split(".")
	if parts.size() != 3:
		return {"ok": false, "reason": "malformed"}
	var exp := parts[0].to_int()
	var nonce := parts[1]
	var mac := parts[2].to_lower()
	if exp <= int(now_unix):
		return {"ok": false, "reason": "expired"}
	if nonce.is_empty() or nonce.length() > 128:
		return {"ok": false, "reason": "bad_nonce"}
	var ctx := HMACContext.new()
	var err: int = ctx.start(HashingContext.HASH_SHA256, secret.to_utf8_buffer())
	if err != OK:
		return {"ok": false, "reason": "hmac_init_failed"}
	ctx.update(("%s:%d:%s" % [room, exp, nonce]).to_utf8_buffer())
	var expected := ctx.finish().hex_encode()
	if not equals_constant_time(expected, mac):
		return {"ok": false, "reason": "bad_signature"}
	return {"ok": true, "nonce": nonce, "exp": exp}


static func equals_constant_time(a: String, b: String) -> bool:
	if a.length() != b.length():
		return false
	var diff := 0
	for i in a.length():
		diff |= a.unicode_at(i) ^ b.unicode_at(i)
	return diff == 0
