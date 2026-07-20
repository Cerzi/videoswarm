const GENERATION_REQUEST_TOKEN_MAX_BYTES = 128;

function invalidToken(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_GENERATION_REQUEST_TOKEN';
  return error;
}

function normalizeGenerationRequestToken(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw invalidToken('A generation metadata request token is required');
    }
    return null;
  }
  if (typeof value !== 'string' || value !== value.trim()) {
    throw invalidToken('Generation metadata request tokens must be trimmed strings');
  }
  if (/[\x00-\x1F\x7F]/u.test(value)) {
    throw invalidToken('Generation metadata request tokens cannot contain control characters');
  }
  if (Buffer.byteLength(value, 'utf8') > GENERATION_REQUEST_TOKEN_MAX_BYTES) {
    throw invalidToken(
      `Generation metadata request tokens cannot exceed ${GENERATION_REQUEST_TOKEN_MAX_BYTES} bytes`
    );
  }
  return value;
}

function createGenerationRequestIdentity({
  profileId,
  generation,
  webContentsId,
  requestToken = null,
}) {
  const ownerBase = `${profileId}:${generation}:wc:${webContentsId}`;
  if (!requestToken) {
    return {
      ownerId: ownerBase,
      scopeId: `${profileId}:${generation}`,
    };
  }
  const requestIdentity = `${ownerBase}:request:${requestToken}`;
  return {
    ownerId: requestIdentity,
    scopeId: requestIdentity,
  };
}

module.exports = {
  GENERATION_REQUEST_TOKEN_MAX_BYTES,
  normalizeGenerationRequestToken,
  createGenerationRequestIdentity,
};
