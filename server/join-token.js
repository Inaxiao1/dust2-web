import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'v2.';

/** Verify a Go-issued v2 HMAC-SHA256 JoinToken without calling the control plane. */
export function verifyJoinToken(token, secret, {
  expectedWorkerId = null,
  expectedMapId = null,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证格式无效。' };
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const parts = rest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证格式无效。' };
  }
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    return { ok: false, code: 'TOKEN_CONFIG_ERROR', message: '服务端尚未配置加入凭证密钥。' };
  }

  const [payloadB64, sigB64] = parts;
  let gotSig;
  try {
    gotSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证签名格式无效。' };
  }
  const expectedSig = createHmac('sha256', secret).update(TOKEN_PREFIX + payloadB64).digest();
  if (gotSig.length !== expectedSig.length || !timingSafeEqual(gotSig, expectedSig)) {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证签名校验失败。' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证内容解析失败。' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return { ok: false, code: 'INVALID_JOIN_TOKEN', message: '加入凭证内容无效。' };
  }
  if (!Number.isFinite(claims.exp) || nowSeconds > claims.exp) {
    return { ok: false, code: 'JOIN_TOKEN_EXPIRED', message: '加入凭证已过期，请从大厅重新进入。' };
  }
  if (expectedWorkerId && claims.workerId !== expectedWorkerId) {
    return { ok: false, code: 'TOKEN_WORKER_MISMATCH', message: '加入凭证与当前对局节点不匹配。' };
  }
  if (expectedMapId && claims.mapId !== expectedMapId) {
    return { ok: false, code: 'TOKEN_MAP_MISMATCH', message: '加入凭证与当前地图不匹配。' };
  }
  return { ok: true, claims };
}
